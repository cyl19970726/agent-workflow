import { posix } from "node:path";
import type { Sandbox } from "@alibaba-group/opensandbox";
import type { SiwcImage, SiwcTool, SiwcVisualToolResult } from "@signal-room/workflow-agent-sdk";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SandboxHandle = Pick<Sandbox, "id" | "files" | "commands" | "kill" | "close">;
export interface OpenSandboxCommand { argv: readonly [string, ...string[]]; timeoutSeconds: number; }
export interface OpenSandboxToolPolicy {
  workspaceRoot: string;
  writePrefixes: readonly string[];
  commands: Readonly<Record<string, OpenSandboxCommand>>;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxOutputBytes: number;
  maxImageBytes: number;
}

export class AttemptTerminalError extends Error {
  constructor(message = "Sandbox attempt has an unknown command outcome or was aborted") { super(message); }
}

export interface AttemptGate { assertOpen(signal: AbortSignal): void; terminal(): void; }
const object = (value: Json): Record<string, Json> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object arguments");
  return value;
};
const string = (value: Json | undefined, field: string): string => {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
};

export function relativeSandboxPath(input: string): string {
  if (!input || input.includes("\0") || input.includes("\\") || input.startsWith("/")) throw new Error("Sandbox path must be relative");
  const parts = input.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("Sandbox path traversal is not allowed");
  return parts.join("/");
}

/** Accept container-absolute paths only when they name a child of this declared workspace. */
export function workspaceRelativePath(input: string, workspaceRoot: string): string {
  const root = workspaceRoot.replace(/\/+$/, "") || "/";
  if (input.startsWith("/")) {
    const prefix = root === "/" ? "/" : `${root}/`;
    if (!input.startsWith(prefix)) throw new Error("Sandbox path is outside the workspace");
    return relativeSandboxPath(input.slice(prefix.length));
  }
  return relativeSandboxPath(input);
}

function inside(root: string, path: string): string { return posix.join(root, relativeSandboxPath(path)); }
function bounded(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024) throw new Error(`Invalid ${name}`);
}
function imageMime(bytes: Uint8Array): SiwcImage["mimeType"] | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP") return "image/webp";
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString().match(/^GIF8[79]a$/)) return "image/gif";
  return undefined;
}

/** SDK offset/limit count lines in OpenSandbox 1.1.1; HTTP Range preserves exact file bytes. */
export async function readBoundedSandboxBytes(sandbox: Pick<SandboxHandle, "files">, path: string,
  maxBytes: number, signal: AbortSignal, gate?: AttemptGate): Promise<Uint8Array> {
  bounded(maxBytes, "read limit");
  signal.throwIfAborted();
  gate?.assertOpen(signal);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    // The inclusive end requests maxBytes+1, letting the host detect an oversized file.
    for await (const chunk of sandbox.files.readBytesStream(path, { range: `bytes=0-${maxBytes}` })) {
      signal.throwIfAborted();
      gate?.assertOpen(signal);
      length += chunk.length;
      if (length > maxBytes) throw new Error("Sandbox file exceeds read limit");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Sandbox file exceeds read limit") throw error;
    if (error instanceof AttemptTerminalError || signal.aborted) throw error;
    throw new Error("Sandbox file download failed"); // Do not expose SDK response bodies or headers.
  }
  signal.throwIfAborted();
  gate?.assertOpen(signal);
  return Buffer.concat(chunks, length);
}

/** Application-level path limits. An approved command can still execute arbitrary code inside the sandbox. */
export function validateOpenSandboxToolPolicy(policy: OpenSandboxToolPolicy): void {
  if (!policy.workspaceRoot.startsWith("/") || policy.workspaceRoot.includes("..")) throw new Error("Workspace root must be absolute");
  for (const prefix of policy.writePrefixes) relativeSandboxPath(prefix);
  for (const key of ["maxReadBytes", "maxWriteBytes", "maxOutputBytes", "maxImageBytes"] as const) bounded(policy[key], key);
  for (const [name, command] of Object.entries(policy.commands)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !command.argv.length ||
        command.argv.some(arg => !arg || arg.includes("\0")) ||
        !Number.isSafeInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 300)
      throw new Error("Invalid host command registry");
  }
}

export function createOpenSandboxWorkspaceTools(sandbox: SandboxHandle, policy: OpenSandboxToolPolicy, gate: AttemptGate): SiwcTool[] {
  validateOpenSandboxToolPolicy(policy);
  const fileArgs = { type: "object", properties: { path: { type: "string",
    description: `Workspace-relative or container-absolute inside ${policy.workspaceRoot}; e.g. summary.json or ${policy.workspaceRoot}/summary.json.` } },
    required: ["path"], additionalProperties: false };
  const read = async (path: string, max: number, signal: AbortSignal) => {
    gate.assertOpen(signal);
    return readBoundedSandboxBytes(sandbox, inside(policy.workspaceRoot, path), max, signal, gate);
  };
  return [
    { name: "read_file", description: `Read bounded UTF-8 text inside ${policy.workspaceRoot}. Relative and in-workspace absolute paths are accepted.`, parameters: fileArgs,
      async execute(args, signal): Promise<Json> {
        const path = workspaceRelativePath(string(object(args).path, "path"), policy.workspaceRoot);
        const bytes = await read(path, policy.maxReadBytes, signal);
        return { path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } },
    { name: "write_file", description: `Write UTF-8 text under ${policy.workspaceRoot}, only in: ${policy.writePrefixes.join(", ") || "no paths"}. Relative and in-workspace absolute paths are accepted.`,
      parameters: { type: "object", properties: { path: { type: "string",
        description: `Relative or absolute inside ${policy.workspaceRoot}; write prefixes: ${policy.writePrefixes.join(", ") || "none"}.` }, content: { type: "string" } },
        required: ["path", "content"], additionalProperties: false },
      async execute(args, signal): Promise<Json> {
        gate.assertOpen(signal);
        const data = object(args); const path = workspaceRelativePath(string(data.path, "path"), policy.workspaceRoot);
        if (!policy.writePrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) throw new Error("Sandbox write path denied");
        const content = string(data.content, "content");
        const bytes = Buffer.from(content, "utf8");
        if (bytes.length > policy.maxWriteBytes) throw new Error("Sandbox write exceeds limit");
        try { await sandbox.files.writeFiles([{ path: inside(policy.workspaceRoot, path), data: bytes, mode: 600 }]); }
        catch { gate.terminal(); throw new AttemptTerminalError("Sandbox file write outcome unknown"); }
        gate.assertOpen(signal);
        return { path, bytesWritten: bytes.length };
      } },
    { name: "read_image", description: `Read bounded image pixels inside ${policy.workspaceRoot}; relative or in-workspace absolute path.`, parameters: fileArgs,
      async execute(args, signal): Promise<Json | SiwcVisualToolResult> {
        const path = workspaceRelativePath(string(object(args).path, "path"), policy.workspaceRoot);
        const bytes = await read(path, policy.maxImageBytes, signal);
        const mimeType = imageMime(bytes);
        if (!mimeType) throw new Error("Unsupported sandbox image type");
        return { kind: "siwc_visual_tool_result", value: { path, mimeType, sizeBytes: bytes.length },
          images: [{ mimeType, base64: Buffer.from(bytes).toString("base64"), detail: "high" }] };
      } },
    { name: "exec_allowed", description: `Run one fixed host command by name: ${Object.keys(policy.commands).join(", ")}. No model arguments.`,
      parameters: { type: "object", properties: { name: { type: "string", enum: Object.keys(policy.commands) } },
        required: ["name"], additionalProperties: false },
      async execute(args, signal): Promise<Json> {
        gate.assertOpen(signal);
        const name = string(object(args).name, "name"); const command = policy.commands[name];
        if (!command) throw new Error("Sandbox command denied");
        let stdout = ""; let stderr = "";
        try {
          const result = await sandbox.commands.run([...command.argv], { timeoutSeconds: command.timeoutSeconds,
            workingDirectory: policy.workspaceRoot }, {
            skipAccumulation: true,
            onStdout: message => { stdout += message.text; if (Buffer.byteLength(stdout) > policy.maxOutputBytes) throw new Error("Sandbox stdout limit exceeded"); },
            onStderr: message => { stderr += message.text; if (Buffer.byteLength(stderr) > policy.maxOutputBytes) throw new Error("Sandbox stderr limit exceeded"); },
          }, signal);
          gate.assertOpen(signal);
          if (!result.complete || result.exitCode === null || result.exitCode === undefined || result.error) {
            gate.terminal(); throw new AttemptTerminalError("Sandbox command completion unknown");
          }
          return { name, exitCode: result.exitCode, stdout, stderr };
        } catch (error) {
          gate.terminal();
          if (error instanceof AttemptTerminalError || signal.aborted ||
              (error instanceof Error && /^Sandbox (?:stdout|stderr) limit exceeded$/.test(error.message))) throw error;
          throw new AttemptTerminalError("Sandbox command outcome unknown"); // No SDK response bodies or headers.
        }
      } },
  ];
}
