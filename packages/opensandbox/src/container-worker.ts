/** Fixed image entrypoint. All model loops and tools execute inside the sandbox. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkspaceTools, OpenAIAgentsSdkRunner } from "@signal-room/workflow-agent-sdk";
import { CONTAINER_PROTOCOL_VERSION, MAX_CONTAINER_JOB_BYTES, parseContainerAgentJob,
  parseContainerAgentResult, containerAttemptKey, type ContainerAgentEvent, type ContainerAgentJob,
  type ContainerAgentResult, type ContainerTokenMetrics } from "./container-protocol.js";

const PLACEHOLDER = "opensandbox-vault-placeholder";
const MAX_EVENT_BYTES = 256 * 1024;
type FailureCode = NonNullable<ContainerAgentResult["failureCode"]>;
export class ContainerWorkerFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}

let eventBudget = Number.POSITIVE_INFINITY;
let emittedBytes = 0;
function emit(eventType: string, data?: ContainerAgentEvent["data"]): void {
  const line = `${JSON.stringify({ type: "event", eventType, ...(data ? { data } : {}) })}\n`;
  emittedBytes += Buffer.byteLength(line);
  if (emittedBytes > eventBudget) throw new ContainerWorkerFailure("LIMIT");
  process.stdout.write(line);
}
function childEnv(home: string): NodeJS.ProcessEnv {
  const allow = ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];
  return { ...Object.fromEntries(allow.filter(name => process.env[name]).map(name => [name, process.env[name]])),
    HOME: home, CODEX_HOME: posix.join(home, ".codex"), SANDBOX_MODEL_TOKEN: PLACEHOLDER };
}
function config(key: string, value: string | number | boolean): string[] { return ["-c", `${key}=${JSON.stringify(value)}`]; }
function boundedText(value: string, max: number): string {
  if (Buffer.byteLength(value) > max) throw new ContainerWorkerFailure("LIMIT");
  return value;
}
function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function usageMetrics(value: unknown): ContainerTokenMetrics {
  const usage = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details as Record<string, unknown> : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details as Record<string, unknown> : {};
  const input = safeCount(usage.input_tokens), output = safeCount(usage.output_tokens);
  const cached = safeCount(usage.cached_input_tokens) ?? safeCount(inputDetails.cached_tokens);
  const reasoning = safeCount(usage.reasoning_output_tokens) ?? safeCount(outputDetails.reasoning_tokens);
  const total = safeCount(usage.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  return { ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    ...(total !== undefined && Number.isSafeInteger(total) ? { totalTokens: total } : {}) };
}

/** Projection used by the in-container Agents SDK event sink. */
export function projectSdkEventData(type: string, value: unknown): ContainerAgentEvent["data"] {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { ...(safeCount(row.turn) !== undefined ? { turn: safeCount(row.turn)! } : {}),
    ...(safeCount(row.status) !== undefined ? { status: safeCount(row.status)! } : {}),
    ...(typeof row.name === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(row.name) ? { name: row.name } : {}),
    ...(type === "siwc.response" ? { ...(safeIdentifier(row.responseId) ? { responseId: safeIdentifier(row.responseId)! } : {}),
      ...usageMetrics(row.usage) } : {}) };
}

/** Parse only lifecycle/usage fields; raw model text and command arguments never enter worker events. */
export function observeCodexEvent(value: unknown, state: { thread: boolean; turn: boolean; complete: boolean;
  commandStarts: number; turns: number; lastMessage: string; metadataWarning?: boolean }, job: ContainerAgentJob): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContainerWorkerFailure("MODEL_FAILED");
  const event = value as { type?: unknown; item?: { type?: unknown; text?: unknown; command?: unknown;
    exit_code?: unknown; message?: unknown };
    thread_id?: unknown; usage?: unknown };
  if (event.type === "thread.started") {
    if (state.thread) throw new ContainerWorkerFailure("MODEL_FAILED");
    state.thread = true; emit("codex.thread.started", safeIdentifier(event.thread_id) ?
      { threadId: safeIdentifier(event.thread_id)! } : undefined);
  }
  if (event.type === "turn.started") {
    if (!state.thread || (state.turn && !state.complete)) throw new ContainerWorkerFailure("MODEL_FAILED");
    state.turn = true; state.complete = false; state.turns++;
    if (state.turns > job.limits.maxTurns) throw new ContainerWorkerFailure("LIMIT");
    emit("codex.turn.started", { turn: state.turns });
  }
  if (event.type === "item.started" && event.item?.type === "command_execution") {
    if (!state.turn || state.complete) throw new ContainerWorkerFailure("MODEL_FAILED");
    state.commandStarts++;
    if (state.commandStarts > job.limits.maxToolCalls) throw new ContainerWorkerFailure("LIMIT");
    const command = typeof event.item.command === "string" ? event.item.command : "";
    emit("codex.command.started", { count: state.commandStarts, name: command.split(/\s+/, 1)[0]?.slice(0, 80) ?? "unknown",
      commandHash: createHash("sha256").update(command).digest("hex"), status: "started" });
  }
  if (event.type === "item.completed" && event.item?.type === "command_execution")
    emit("codex.command.completed", { name: typeof event.item.command === "string" ?
      event.item.command.split(/\s+/, 1)[0]?.slice(0, 80) ?? "unknown" : "unknown",
      status: "completed", exitCode: typeof event.item.exit_code === "number" ? event.item.exit_code : null });
  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string")
    state.lastMessage = boundedText(event.item.text, job.limits.maxOutputBytes);
  if (event.type === "item.completed" && event.item?.type === "error" &&
      typeof event.item.message === "string" && /Model metadata for [`'"\w-]+ not found/.test(event.item.message) &&
      !state.metadataWarning) {
    state.metadataWarning = true;
    emit("codex.model_metadata_fallback", { model: job.definition.model });
  }
  if (event.type === "turn.completed") {
    if (!state.turn || state.complete) throw new ContainerWorkerFailure("MODEL_FAILED");
    state.complete = true;
    emit("codex.turn.completed", { ...usageMetrics(event.usage) });
  }
  if (event.type === "turn.failed") throw new ContainerWorkerFailure("MODEL_FAILED");
}

async function runCodex(job: ContainerAgentJob, signal: AbortSignal, home: string): Promise<Pick<ContainerAgentResult, "output" | "metadata">> {
  const instructions = job.definition.config?.instructions;
  if (instructions !== undefined && typeof instructions !== "string") throw new ContainerWorkerFailure("WORKER_FAILED");
  const prompt = boundedText(`${instructions ?? ""}\n\nInput:\n${JSON.stringify(job.input)}`, 64 * 1024);
  const disabled = ["apps", "plugins", "hooks", "multi_agent", "multi_agent_v2", "code_mode_host",
    "browser_use", "computer_use", "image_generation"];
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json",
    "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", job.workspaceRoot,
    "-m", job.definition.model, ...config("model_reasoning_effort", job.definition.reasoningEffort),
    ...config("approval_policy", "never"), ...config("project_doc_max_bytes", 0),
    ...config("web_search", "disabled"), ...config("model_provider", "vault"),
    ...config("model_providers.vault.name", "OpenSandbox Vault"),
    ...config("model_providers.vault.base_url", "https://chatgpt.com/backend-api/codex"),
    ...config("model_providers.vault.env_key", "SANDBOX_MODEL_TOKEN"),
    ...config("model_providers.vault.wire_api", "responses"),
    ...config("model_providers.vault.requires_openai_auth", false),
    ...config("model_providers.vault.supports_websockets", false),
    ...config("model_providers.vault.request_max_retries", 0),
    ...config("model_providers.vault.stream_max_retries", 0),
    ...disabled.flatMap(feature => ["--disable", feature]), prompt];
  const child = spawn("codex", args, { cwd: job.workspaceRoot, env: childEnv(home), detached: true,
    stdio: ["ignore", "pipe", "pipe"] });
  const state = { thread: false, turn: false, complete: false, commandStarts: 0, turns: 0, lastMessage: "", metadataWarning: false };
  let bytes = 0, stderrBytes = 0, partial = "", stderrTail = "";
  let failure: ContainerWorkerFailure | undefined;
  let stopping = false;
  const stop = (reason: ContainerWorkerFailure) => {
    failure ??= reason;
    if (stopping || child.pid === undefined) return;
    stopping = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
    const escalation = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, 2_000);
    escalation.unref();
  };
  const onAbort = () => stop(new ContainerWorkerFailure(signal.reason instanceof ContainerWorkerFailure ? signal.reason.code : "ABORTED"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_EVENT_BYTES) { stop(new ContainerWorkerFailure("LIMIT")); return; }
    partial += chunk.toString("utf8");
    let newline: number;
    while ((newline = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
      try { observeCodexEvent(JSON.parse(line), state, job); }
      catch (error) { stop(error instanceof ContainerWorkerFailure ? error : new ContainerWorkerFailure("MODEL_FAILED")); return; }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_EVENT_BYTES) stop(new ContainerWorkerFailure("LIMIT"));
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-512);
    if (!state.metadataWarning && /Model metadata for [`'"\w-]+ not found/.test(stderrTail)) {
      state.metadataWarning = true;
      try { emit("codex.model_metadata_fallback", { model: job.definition.model }); }
      catch (error) { stop(error instanceof ContainerWorkerFailure ? error : new ContainerWorkerFailure("LIMIT")); }
    }
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
    });
  } finally { signal.removeEventListener("abort", onAbort); }
  if (failure) throw failure;
  if (exit.code !== 0 || partial.trim() || !state.thread || !state.turn || !state.complete || !state.lastMessage)
    throw new ContainerWorkerFailure("MODEL_FAILED");
  const output = job.definition.config?.outputFormat === "json" ? JSON.parse(state.lastMessage) : state.lastMessage;
  return { output, metadata: { runtime: "codex-cli", turns: state.turns,
    toolCalls: state.commandStarts, commandStarts: state.commandStarts } };
}

async function createLocalTools(job: ContainerAgentJob) {
  const policy = job.tools;
  if (!policy) return [];
  return createWorkspaceTools({ root: job.workspaceRoot, writePaths: policy.writePaths,
    commands: Object.fromEntries(Object.entries(policy.commands).map(([name, command]) => [name, {
      command: command.argv[0], args: command.argv.slice(1),
      timeoutMs: command.timeoutSeconds * 1000, allowAdditionalArgs: false,
      env: {
        ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
        ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
      },
    }])) });
}

async function runAgentsSdk(job: ContainerAgentJob, signal: AbortSignal): Promise<Pick<ContainerAgentResult, "output" | "metadata">> {
  const runner = new OpenAIAgentsSdkRunner({
    auth: { async accessToken() { return PLACEHOLDER; } },
    tools: () => createLocalTools(job),
    maxTurns: job.limits.maxTurns, maxToolCalls: job.limits.maxToolCalls,
    timeoutMs: job.limits.timeoutMs,
    enforceJsonObject: job.definition.config?.outputFormat === "json",
    requestTimeoutMs: job.limits.timeoutMs,
  });
  const result = await runner.run({ runId: job.runId, stepRunId: job.stepRunId, attemptId: job.attemptId,
    definition: job.definition, input: job.input, signal,
    async emit(type, data) { emit(type, projectSdkEventData(type, data)); } });
  return { output: result.output, metadata: { runtime: "agents-sdk",
    ...(typeof result.metadata?.turns === "number" ? { turns: result.metadata.turns } : {}),
    ...(typeof result.metadata?.toolCalls === "number" ? { toolCalls: result.metadata.toolCalls } : {}) } };
}

export async function runContainerAgentJob(job: ContainerAgentJob, signal: AbortSignal, home: string): Promise<ContainerAgentResult> {
  parseContainerAgentJob(job);
  eventBudget = job.limits.maxOutputBytes - 256;
  emittedBytes = 0;
  try {
    const value = job.runtime === "codex-cli" ? await runCodex(job, signal, home) : await runAgentsSdk(job, signal);
    signal.throwIfAborted();
    const result: ContainerAgentResult = { protocolVersion: CONTAINER_PROTOCOL_VERSION, runId: job.runId,
      stepRunId: job.stepRunId, attemptId: job.attemptId, status: "succeeded", ...value };
    if (Buffer.byteLength(JSON.stringify(result)) > job.limits.maxOutputBytes) throw new ContainerWorkerFailure("LIMIT");
    return parseContainerAgentResult(JSON.parse(JSON.stringify(result)), job);
  } catch (error) {
    const failureCode: FailureCode = signal.aborted ?
      signal.reason instanceof ContainerWorkerFailure ? signal.reason.code : "ABORTED" :
      error instanceof ContainerWorkerFailure ? error.code : "WORKER_FAILED";
    return { protocolVersion: CONTAINER_PROTOCOL_VERSION, runId: job.runId, stepRunId: job.stepRunId,
      attemptId: job.attemptId, status: "failed", failureCode };
  }
}

/** The production entry uses the fixed root; the injected worker is only for offline protocol tests. */
export async function executeContainerWorkerFiles(jobPath: string, resultPath: string, options: {
  controlRoot?: string;
  run?: typeof runContainerAgentJob;
} = {}): Promise<ContainerAgentResult> {
  const controlRoot = options.controlRoot ?? "/work/.workflow";
  if (!jobPath.startsWith(`${controlRoot}/`) || !resultPath.startsWith(`${controlRoot}/`) ||
      dirname(jobPath) !== dirname(resultPath)) throw new Error("Invalid worker control paths");
  const bytes = await readFile(jobPath);
  if (bytes.length > MAX_CONTAINER_JOB_BYTES) throw new Error("Container job file too large");
  const job = parseContainerAgentJob(JSON.parse(bytes.toString("utf8")));
  const expected = `${controlRoot}/${containerAttemptKey(job)}`;
  if (jobPath !== `${expected}/job.json` || resultPath !== `${expected}/result.json`)
    throw new Error("Control directory does not match attempt");
  const home = posix.join(dirname(jobPath), "home");
  // Codex 0.154.0 requires CODEX_HOME to exist before startup; it does not create it.
  await mkdir(posix.join(home, ".codex"), { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ContainerWorkerFailure("TIMEOUT")), job.limits.timeoutMs);
  const onTerm = () => controller.abort(new ContainerWorkerFailure("ABORTED"));
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onTerm);
  let result: ContainerAgentResult;
  try { result = await (options.run ?? runContainerAgentJob)(job, controller.signal, home); }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onTerm); }
  parseContainerAgentResult(result, job);
  const temporary = `${resultPath}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
  await rename(temporary, resultPath);
  eventBudget = job.limits.maxOutputBytes;
  emit("worker.finished", { status: result.status, ...(result.failureCode ? { failureCode: result.failureCode } : {}) });
  return result;
}

async function main(): Promise<void> {
  const [jobPath, resultPath] = process.argv.slice(2);
  if (!jobPath || !resultPath) throw new Error("Missing worker paths");
  const result = await executeContainerWorkerFiles(jobPath, resultPath);
  if (result.status === "failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    try { emit("worker.failed", { failureCode: "WORKER_FAILED" }); } catch { /* event bound already reached */ }
    process.exitCode = 1;
  });
}
