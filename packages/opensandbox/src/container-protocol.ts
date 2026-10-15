import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { AgentDefinition } from "@signal-room/workflow/contracts";

export const CONTAINER_PROTOCOL_VERSION = 1 as const;
export const CONTAINER_WORKSPACE_ROOT = "/work/shared" as const;
export const CONTAINER_WORKER_PATH = "/opt/workflow/container-worker.js" as const;
export const MAX_CONTAINER_JOB_BYTES = 256 * 1024;

export function containerAttemptKey(ids: Pick<ContainerAgentJob, "runId" | "stepRunId" | "attemptId">): string {
  return createHash("sha256").update(JSON.stringify([ids.runId, ids.stepRunId, ids.attemptId])).digest("hex");
}

export interface ContainerWorkspaceTools {
  /** Relative paths below workspaceRoot. This is an application policy, not an OS boundary. */
  writePaths: string[];
  commands: Record<string, { argv: [string, ...string[]]; timeoutSeconds: number }>;
}

export interface ContainerAgentJob {
  protocolVersion: typeof CONTAINER_PROTOCOL_VERSION;
  runId: string;
  stepRunId: string;
  attemptId: string;
  runtime: "codex-cli" | "agents-sdk";
  definition: AgentDefinition<unknown, unknown>;
  input: unknown;
  workspaceRoot: typeof CONTAINER_WORKSPACE_ROOT;
  limits: { timeoutMs: number; maxTurns: number; maxToolCalls: number; maxOutputBytes: number };
  tools?: ContainerWorkspaceTools;
}

export interface ContainerAgentResult {
  protocolVersion: typeof CONTAINER_PROTOCOL_VERSION;
  runId: string;
  stepRunId: string;
  attemptId: string;
  status: "succeeded" | "failed";
  output?: unknown;
  metadata?: { runtime: ContainerAgentJob["runtime"]; turns?: number; toolCalls?: number; commandStarts?: number };
  failureCode?: "ABORTED" | "TIMEOUT" | "LIMIT" | "MODEL_FAILED" | "WORKER_FAILED";
}

export interface ContainerAgentEvent {
  type: "event";
  eventType: string;
  /** Safe scalar receipt only. Usage keys use ContainerTokenMetrics; never model text or credentials. */
  data?: Record<string, string | number | boolean | null>;
}

export interface ContainerTokenMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.includes("\0")) throw new Error(`Invalid ${name}`);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${name}`);
  return value as number;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unexpected container protocol field");
}
function relative(value: unknown): string {
  const path = nonempty(value, "workspace path");
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("Invalid workspace path");
  return path;
}
function plainJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => plainJson(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(item => plainJson(item, depth + 1));
}

/** Validate before staging a job file or creating a remote process. No callback can cross this protocol. */
export function validateContainerAgentJob(value: unknown): asserts value is ContainerAgentJob {
  if (!plainJson(value)) throw new Error("Container job must contain only JSON data");
  const job = record(value);
  onlyKeys(job, ["protocolVersion", "runId", "stepRunId", "attemptId", "runtime", "definition", "input", "workspaceRoot", "limits", "tools"]);
  if (job.protocolVersion !== CONTAINER_PROTOCOL_VERSION ||
      (job.runtime !== "codex-cli" && job.runtime !== "agents-sdk") ||
      job.workspaceRoot !== CONTAINER_WORKSPACE_ROOT) throw new Error("Unsupported container job");
  const definition = record(job.definition);
  for (const key of ["id", "revision", "model", "reasoningEffort", "promptRevision", "skillsRevision", "permissionsRevision"])
    nonempty(definition[key], `definition.${key}`);
  if (definition.config !== undefined) record(definition.config);
  const limits = record(job.limits);
  onlyKeys(limits, ["timeoutMs", "maxTurns", "maxToolCalls", "maxOutputBytes"]);
  integer(limits.timeoutMs, "timeoutMs", 1_000, 300_000);
  integer(limits.maxTurns, "maxTurns", 1, 32);
  integer(limits.maxToolCalls, "maxToolCalls", 1, 128);
  integer(limits.maxOutputBytes, "maxOutputBytes", 1_024, 1024 * 1024);
  if (job.runtime === "codex-cli" && job.tools !== undefined)
    throw new Error("Codex native shell cannot enforce SDK workspace tool policy");
  if (job.tools !== undefined) {
    const tools = record(job.tools);
    onlyKeys(tools, ["writePaths", "commands"]);
    if (!Array.isArray(tools.writePaths) || tools.writePaths.length > 64) throw new Error("Invalid write paths");
    for (const path of tools.writePaths) relative(path);
    const commands = record(tools.commands);
    if (Object.keys(commands).length > 64) throw new Error("Too many commands");
    for (const [name, commandValue] of Object.entries(commands)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) throw new Error("Invalid command name");
      const command = record(commandValue);
      onlyKeys(command, ["argv", "timeoutSeconds"]);
      if (!Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 32 ||
          command.argv.some(arg => typeof arg !== "string" || !arg || arg.length > 1024 || arg.includes("\0")))
        throw new Error("Invalid command arguments");
      integer(command.timeoutSeconds, "command timeout", 1, 300);
    }
  }
  for (const key of ["runId", "stepRunId", "attemptId"]) nonempty(job[key], key);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTAINER_JOB_BYTES) throw new Error("Container job too large");
}

export function parseContainerAgentJob(value: unknown): ContainerAgentJob {
  validateContainerAgentJob(value);
  return value;
}

export function validateContainerAgentResult(value: unknown, job: ContainerAgentJob): asserts value is ContainerAgentResult {
  if (!plainJson(value)) throw new Error("Container result must be JSON");
  const result = record(value);
  onlyKeys(result, ["protocolVersion", "runId", "stepRunId", "attemptId", "status", "output", "metadata", "failureCode"]);
  if (result.protocolVersion !== CONTAINER_PROTOCOL_VERSION || result.runId !== job.runId ||
      result.stepRunId !== job.stepRunId || result.attemptId !== job.attemptId ||
      (result.status !== "succeeded" && result.status !== "failed")) throw new Error("Container result correlation mismatch");
  if (result.status === "failed" && !["ABORTED", "TIMEOUT", "LIMIT", "MODEL_FAILED", "WORKER_FAILED"].includes(result.failureCode as string))
    throw new Error("Invalid container failure code");
  if (result.status === "succeeded" && (!Object.hasOwn(result, "output") || result.failureCode !== undefined))
    throw new Error("Invalid successful container result");
  if (result.metadata !== undefined) {
    const metadata = record(result.metadata);
    onlyKeys(metadata, ["runtime", "turns", "toolCalls", "commandStarts"]);
    if (metadata.runtime !== job.runtime) throw new Error("Container runtime mismatch");
    for (const key of ["turns", "toolCalls", "commandStarts"]) if (metadata[key] !== undefined) integer(metadata[key], key, 0, 1_000_000);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > job.limits.maxOutputBytes) throw new Error("Container result exceeds limit");
}

export function parseContainerAgentResult(value: unknown, job: ContainerAgentJob): ContainerAgentResult {
  validateContainerAgentResult(value, job);
  return value;
}

export function workspacePath(root: typeof CONTAINER_WORKSPACE_ROOT, relativePath: string): string {
  return posix.join(root, relative(relativePath));
}
