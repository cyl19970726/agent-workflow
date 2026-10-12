import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, opendir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { SiwcImage, SiwcTool, SiwcVisualToolResult } from "./responses.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface WorkspaceCommand {
  /** Executable selected by the trusted host. Never supplied by the model. */
  command: string;
  /** Fixed arguments selected by the trusted host, such as a script path. */
  args?: readonly string[];
  /** Working directory relative to workspace root. Defaults to root. */
  cwd?: string;
  /** Explicit additions to the minimal child environment. Never traced by this module. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Permit model-supplied arguments to be appended after the fixed host arguments. Defaults to false. */
  allowAdditionalArgs?: boolean;
}

export interface WorkspaceToolsOptions {
  /** Existing writable work directory bound to the current run. */
  root: string;
  /** Additional existing directories exposed only through read tools. */
  readRoots?: readonly string[];
  /** Relative writable path prefixes under root. An omitted or empty list denies every write. */
  writePaths?: readonly string[];
  /** Explicit command registry. The model can select a key, never an executable path. */
  commands?: Readonly<Record<string, WorkspaceCommand>>;
}

interface BoundRoot { id: string; path: string; }
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 15 * 60_000;

/**
 * Creates node-scoped workspace tools. The root and command registry must be bound by a trusted host.
 * Path checks and command allowlists are application controls, not an OS sandbox: an allowed executable
 * can still read or write anything the process user can access.
 */
export async function createWorkspaceTools(options: WorkspaceToolsOptions): Promise<SiwcTool[]> {
  const root = await boundRoot("workspace", options.root);
  const roots: BoundRoot[] = [root];
  for (let index = 0; index < (options.readRoots?.length ?? 0); index++) {
    roots.push(await boundRoot(`read-${index}`, options.readRoots![index]!));
  }
  const writePaths = (options.writePaths ?? []).map(normalizePrefix);
  const commands = options.commands ?? {};
  for (const [name, config] of Object.entries(commands)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid workspace command name: ${name}`);
    if (!config.command.trim() || config.command.includes("\0")) throw new Error(`Invalid executable for workspace command: ${name}`);
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > MAX_COMMAND_TIMEOUT_MS)) {
      throw new Error(`Invalid timeout for workspace command: ${name}`);
    }
    for (const arg of config.args ?? []) assertCommandText(arg, "configured argument");
    for (const [key, value] of Object.entries(config.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key for workspace command: ${name}`);
      assertCommandText(value, "configured environment value");
    }
  }

  const rootIds = roots.map(item => item.id);
  const readParameters = { type: "object", properties: {
    root: { type: "string", enum: rootIds, description: "workspace is the writable run directory; read-N roots are read-only references." },
    path: { type: "string", description: "Relative path inside the selected root; parent traversal and absolute paths are rejected." },
  }, required: ["root", "path"], additionalProperties: false };
  const tools: SiwcTool[] = [
    {
      name: "read_file", description: "Read a bounded UTF-8 text file from the workspace or a bound read-only reference root.",
      parameters: readParameters,
      execute: async (args, signal) => {
        signal.throwIfAborted();
        const input = objectArgs(args);
        const selected = selectRoot(roots, input.root);
        const file = await resolveInside(selected, stringArg(input.path, "path"));
        const info = await stat(file);
        if (!info.isFile()) throw new Error("Workspace read_file requires a regular file");
        if (info.size > MAX_TEXT_BYTES) throw new Error("Workspace text file exceeds the read limit");
        const bytes = await readFile(file);
        signal.throwIfAborted();
        if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error("Workspace text file exceeds the read limit");
        return { root: selected.id, path: relative(selected.path, file).split(sep).join("/"), content: bytes.toString("utf8") };
      },
    },
    {
      name: "list_directory", description: "List immediate entries in a workspace or bound read-only reference directory.",
      parameters: readParameters,
      execute: async (args, signal) => {
        signal.throwIfAborted();
        const input = objectArgs(args);
        const selected = selectRoot(roots, input.root);
        const directory = await resolveInside(selected, stringArg(input.path, "path"));
        if (!(await stat(directory)).isDirectory()) throw new Error("Workspace list_directory requires a directory");
        const handle = await opendir(directory);
        const rows: Array<{ name: string; type: string }> = [];
        let truncated = false;
        for await (const entry of handle) {
          signal.throwIfAborted();
          if (rows.length === 500) { truncated = true; break; }
          rows.push({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file"
            : entry.isSymbolicLink() ? "symlink" : "other" });
        }
        return { root: selected.id, path: relative(selected.path, directory).split(sep).join("/"),
          entries: rows.sort((a, b) => a.name.localeCompare(b.name)), truncated };
      },
    },
    {
      name: "write_file", description: "Write UTF-8 text inside the workspace, only under the host-approved write path prefixes.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Relative path under an approved workspace write prefix." },
        content: { type: "string" },
      }, required: ["path", "content"], additionalProperties: false },
      execute: async (args, signal) => {
        signal.throwIfAborted();
        const input = objectArgs(args);
        const path = stringArg(input.path, "path");
        const content = stringArg(input.content, "content");
        const normalized = normalizeRelative(path);
        const bytes = Buffer.from(content, "utf8");
        if (bytes.byteLength > MAX_WRITE_BYTES) throw new Error("Workspace write exceeds the size limit");
        const target = await resolveForWrite(root, normalized);
        assertWritable(normalized, relative(root.path, target).split(sep).join("/"), writePaths);
        await mkdir(dirname(target), { recursive: true });
        const parent = await realpath(dirname(target));
        assertContained(root.path, parent);
        const finalTarget = join(parent, target.slice(dirname(target).length + 1));
        assertWritable(normalized, relative(root.path, finalTarget).split(sep).join("/"), writePaths);
        try {
          const existing = await import("node:fs/promises").then(({ lstat }) => lstat(finalTarget));
          if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Workspace write target must be a regular file, not a symlink");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const handle = await open(finalTarget, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
        signal.throwIfAborted();
        return { path: relative(root.path, finalTarget).split(sep).join("/"), bytesWritten: bytes.byteLength };
      },
    },
    {
      name: "read_image", description: "Read a bound image and return its actual pixels for visual inspection.",
      parameters: readParameters,
      execute: async (args, signal): Promise<Json | SiwcVisualToolResult> => {
        signal.throwIfAborted();
        const input = objectArgs(args);
        const selected = selectRoot(roots, input.root);
        const file = await resolveInside(selected, stringArg(input.path, "path"));
        const info = await stat(file);
        if (!info.isFile()) throw new Error("Workspace read_image requires a regular file");
        if (info.size > MAX_IMAGE_BYTES) throw new Error("Workspace image exceeds the read limit");
        const bytes = await readFile(file);
        signal.throwIfAborted();
        const mimeType = imageMime(bytes);
        if (!mimeType) throw new Error("Unsupported workspace image type");
        const image: SiwcImage = { mimeType, base64: bytes.toString("base64"), detail: "high" };
        return { kind: "siwc_visual_tool_result", value: { root: selected.id,
          path: relative(selected.path, file).split(sep).join("/"), mimeType, sizeBytes: bytes.byteLength }, images: [image] };
      },
    },
  ];

  if (Object.keys(commands).length) {
    tools.push({
      name: "exec_allowed", description: `Run a host-approved command by name (${Object.keys(commands).join(", ")}). No shell is available.`,
      parameters: { type: "object", properties: {
        name: { type: "string", enum: Object.keys(commands) },
        args: { type: "array", items: { type: "string", maxLength: 8192 }, maxItems: 64 },
      }, required: ["name"], additionalProperties: false },
      execute: async (args, signal) => {
        signal.throwIfAborted();
        const input = objectArgs(args);
        const name = stringArg(input.name, "name");
        const config = commands[name];
        if (!config) throw new Error(`Unauthorized workspace command: ${name}`);
        const extra = input.args === undefined ? [] : stringArrayArg(input.args, "args");
        if (extra.length && config.allowAdditionalArgs !== true) throw new Error(`Additional arguments are not allowed for workspace command: ${name}`);
        extra.forEach(arg => assertCommandText(arg, "argument"));
        const cwd = config.cwd === undefined ? root.path : await resolveInside(root, config.cwd);
        if (!(await stat(cwd)).isDirectory()) throw new Error("Workspace command cwd must be a directory");
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir(),
          ...config.env,
        };
        const output = await runCommand(config.command, [...(config.args ?? []), ...extra], {
          cwd, env, signal, timeoutMs: config.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        });
        return { command: name, exitCode: output.exitCode, ...(output.errorCode ? { errorCode: output.errorCode } : {}),
          stdout: output.stdout, stderr: output.stderr, timedOut: output.timedOut };
      },
    });
  }
  return tools;
}

async function boundRoot(id: string, input: string): Promise<BoundRoot> {
  if (!input || input.includes("\0")) throw new Error(`Invalid ${id} directory`);
  const path = await realpath(resolve(input));
  if (!(await stat(path)).isDirectory()) throw new Error(`${id} must be a directory`);
  return { id, path };
}

function selectRoot(roots: readonly BoundRoot[], id: unknown): BoundRoot {
  if (typeof id !== "string") throw new Error("Workspace root is required");
  const root = roots.find(item => item.id === id);
  if (!root) throw new Error("Unauthorized workspace root");
  return root;
}

function normalizeRelative(input: string): string {
  if (!input || input.includes("\0") || isAbsolute(input) || win32.isAbsolute(input)) throw new Error("Workspace path must be relative");
  const pieces = input.replaceAll("\\", "/").split("/");
  if (pieces.some(piece => piece === "..")) throw new Error("Workspace path traversal is not allowed");
  const cleaned = pieces.filter(piece => piece !== "" && piece !== ".").join("/");
  if (!cleaned && pieces.every(piece => piece === "" || piece === ".")) return ".";
  if (!cleaned) throw new Error("Workspace path must name a child path");
  return cleaned;
}

function normalizePrefix(input: string): string {
  const clean = normalizeRelative(input.replace(/\/+$/, ""));
  return clean;
}

async function resolveInside(root: BoundRoot, input: string): Promise<string> {
  const normalized = normalizeRelative(input);
  const candidate = resolve(root.path, ...normalized.split("/"));
  assertContained(root.path, candidate);
  const actual = await realpath(candidate);
  assertContained(root.path, actual);
  return actual;
}

async function resolveForWrite(root: BoundRoot, normalized: string): Promise<string> {
  const candidate = resolve(root.path, ...normalized.split("/"));
  assertContained(root.path, candidate);
  let cursor = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const actual = await realpath(cursor);
      assertContained(root.path, actual);
      return resolve(actual, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Workspace path escapes its bound root");
}

function assertWritable(requested: string, resolved: string, prefixes: readonly string[]): void {
  const match = (value: string) => prefixes.some(prefix => prefix === "." || value === prefix || value.startsWith(`${prefix}/`));
  if (!match(requested) || !match(resolved)) throw new Error("Workspace write is outside approved write paths");
}

function imageMime(bytes: Buffer): SiwcImage["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function objectArgs(args: Json): Record<string, Json> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Workspace tool arguments must be an object");
  return args as Record<string, Json>;
}
function stringArg(value: Json | undefined, name: string): string {
  if (typeof value !== "string") throw new Error(`Workspace ${name} must be a string`);
  return value;
}
function stringArrayArg(value: Json, name: string): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string")) throw new Error(`Workspace ${name} must be a bounded string array`);
  return value as string[];
}
function assertCommandText(value: string, label: string): void {
  if (typeof value !== "string" || value.includes("\0") || value.length > 8192) throw new Error(`Invalid workspace command ${label}`);
}

function runCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }): Promise<{
  exitCode: number | null; errorCode?: string; stdout: string; stderr: string; timedOut: boolean;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = execFileCallback(command, args, { cwd: options.cwd, env: options.env, signal: options.signal,
      timeout: options.timeoutMs, maxBuffer: MAX_COMMAND_OUTPUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      if (options.signal.aborted) { reject(options.signal.reason ?? new Error("Workspace command canceled")); return; }
      const code = error && "code" in error ? error.code : undefined;
      resolvePromise({ exitCode: typeof code === "number" ? code : error ? null : 0,
        ...(typeof code === "string" ? { errorCode: code } : {}), stdout: String(stdout), stderr: String(stderr), timedOut: code === "ETIMEDOUT" });
    });
    const onAbort = () => child.kill("SIGTERM");
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
    child.once("close", () => options.signal.removeEventListener("abort", onAbort));
  });
}
