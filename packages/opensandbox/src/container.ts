import { createHash } from "node:crypto";
import type { AgentRunRequest, AgentRunResult, AgentRunner } from "@signal-room/workflow";
import type { BorrowedSandboxHandle, OpenSandboxEnvironmentOwner } from "./environment.js";
import { readBoundedSandboxBytes } from "./tools.js";
import { containerAttemptKey, MAX_CONTAINER_JOB_BYTES, validateContainerAgentJob, validateContainerAgentResult,
  type ContainerAgentJob } from "./container-protocol.js";

export interface ContainerAgentPolicy {
  runtime: ContainerAgentJob["runtime"];
  limits: ContainerAgentJob["limits"];
  tools?: ContainerAgentJob["tools"];
}
export interface ContainerAgentContext {
  request: AgentRunRequest<unknown>;
  sandbox: BorrowedSandboxHandle;
  workspaceRoot: string;
}
export interface ContainerAgentRunnerOptions {
  environment: OpenSandboxEnvironmentOwner;
  policy: ContainerAgentPolicy;
  /** Materialize exact inputs; no publication or unbounded host side effects here. */
  prepare?: (context: ContainerAgentContext) => Promise<void>;
  /** Read and independently validate real output bytes before marking a result valid. */
  finish?: (context: ContainerAgentContext & { result: AgentRunResult<unknown> }) => Promise<AgentRunResult<unknown>>;
  pollIntervalMs?: number;
  operationTimeoutMs?: number;
}

const WORKSPACE = "/work/shared";
const WORKER = "/opt/workflow/container-worker.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Freeze both environment and worker policy into the existing Agent config fingerprint. */
export function containerAgentConfig(environmentProfileDigest: string, policy: ContainerAgentPolicy) {
  if (!/^[a-f0-9]{64}$/.test(environmentProfileDigest)) throw new Error("Invalid environment profile digest");
  const job = policyJob(policy);
  validateContainerAgentJob(job);
  const containerAgentPolicyDigest = createHash("sha256").update(JSON.stringify(stable({
    protocolVersion: 1, worker: WORKER, environmentProfileDigest, ...policy,
  }))).digest("hex");
  return { environmentProfileDigest, containerAgentPolicyDigest };
}

function policyJob(policy: ContainerAgentPolicy): ContainerAgentJob {
  return { protocolVersion: 1, runId: "validate", stepRunId: "validate", attemptId: "validate",
    definition: { id: "validate", revision: "1", model: "validate", reasoningEffort: "low", promptRevision: "1",
      skillsRevision: "none", permissionsRevision: "1" }, input: null, workspaceRoot: WORKSPACE, ...policy };
}

/** A transport timeout is unknown execution, never evidence that a command did not start. */
function bounded<T>(action: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const abort = () => fail(new Error("Container agent aborted"));
    const timer = setTimeout(() => fail(new Error("Container operation outcome unknown")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else Promise.resolve().then(action).then(value => { cleanup(); resolve(value); },
      () => fail(new Error("Container operation failed")));
  });
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Container agent aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("Container agent aborted")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Entire model/tool loop runs in the pinned image. No host tool callback or host runtime fallback. */
export function createContainerAgentRunner(options: ContainerAgentRunnerOptions): AgentRunner {
  const policy = structuredClone(options.policy);
  const config = containerAgentConfig(options.environment.binding.profileDigest, policy);
  const pollMs = options.pollIntervalMs ?? 250;
  const operationMs = options.operationTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5_000 ||
    !Number.isSafeInteger(operationMs) || operationMs < 1 || operationMs > 30_000) throw new Error("Invalid container timing limits");
  return {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      for (const [key, expected] of Object.entries(config)) {
        if (request.definition.config?.[key] !== expected) throw new Error("Container agent policy and definition disagree");
      }
      // Digest-derived directory cannot be supplied as a traversal path and is unique per attempt.
      const attemptKey = containerAttemptKey(request);
      const control = `/work/.workflow/${attemptKey}`;
      const jobPath = `${control}/job.json`, resultPath = `${control}/result.json`;
      const job: ContainerAgentJob = { ...policyJob(policy), runId: request.runId, stepRunId: request.stepRunId,
        attemptId: request.attemptId, definition: request.definition, input: request.input };
      validateContainerAgentJob(job);
      const serialized = Buffer.from(JSON.stringify(job));
      if (serialized.length > MAX_CONTAINER_JOB_BYTES) throw new Error("Container job exceeds input limit");
      return options.environment.use(request, async sandbox => {
        const controller = new AbortController();
        const signal = AbortSignal.any([request.signal, controller.signal]);
        const deadline = setTimeout(() => controller.abort(), policy.limits.timeoutMs + 5_000);
        const invoke = <T>(action: () => Promise<T>) => bounded(action, operationMs, signal);
        const context: ContainerAgentContext = { request: request as AgentRunRequest<unknown>, sandbox, workspaceRoot: WORKSPACE };
        let commandId: string | undefined;
        let launched = false, commandFinished = false;
        try {
          await invoke(() => sandbox.files.createDirectories([{ path: WORKSPACE, mode: 700 }, { path: control, mode: 700 }]));
          if (options.prepare) await invoke(() => options.prepare!(context));
          signal.throwIfAborted();
          await invoke(() => sandbox.files.writeFiles([{ path: jobPath, data: serialized, mode: 600 }]));
          await invoke(() => request.emit("sandbox.agent_starting", { sandboxId: sandbox.id,
            runtime: policy.runtime, environmentProfileDigest: config.environmentProfileDigest, containerAgentPolicyDigest: config.containerAgentPolicyDigest }));
          launched = true;
          const execution = await invoke(() => sandbox.commands.run(["node", WORKER, jobPath, resultPath], {
            background: true, workingDirectory: WORKSPACE, timeoutSeconds: Math.ceil(policy.limits.timeoutMs / 1000) + 3,
          }));
          if (!execution.id) throw new Error("Container command identity missing");
          commandId = execution.id;
          await invoke(() => request.emit("sandbox.command_started", { sandboxId: sandbox.id, commandId, runtime: policy.runtime }));
          let cursor = 0, bytes = 0, partial = "";
          let codexThreadId = commandId;
          const collectLogs = async () => {
            const logs = await invoke(() => sandbox.commands.getBackgroundCommandLogs(commandId!, cursor));
            bytes += Buffer.byteLength(logs.content);
            if (bytes > policy.limits.maxOutputBytes) throw new Error("Container events exceed limit");
            if (logs.content && (!Number.isSafeInteger(logs.cursor) || logs.cursor! <= cursor))
              throw new Error("Container log cursor did not advance");
            if (logs.cursor !== undefined) cursor = logs.cursor;
            partial += logs.content;
            let index: number;
            while ((index = partial.indexOf("\n")) >= 0) {
              const line = partial.slice(0, index); partial = partial.slice(index + 1);
              if (!line.trim()) continue;
              let event: { type?: unknown; eventType?: unknown; data?: unknown };
              try { event = JSON.parse(line); } catch { throw new Error("Invalid container event"); }
              if (event.type !== "event" || typeof event.eventType !== "string" ||
                !/^[a-z][a-z0-9_.]{0,80}$/.test(event.eventType)) throw new Error("Invalid container event");
              await invoke(() => request.emit("sandbox.agent_event", { sandboxId: sandbox.id, commandId,
                runtime: policy.runtime, eventType: event.eventType, data: event.data ?? null }));
              const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
                ? event.data as Record<string, unknown> : {};
              // Project sanitized worker receipts into the existing accounting events; no core format changes.
              const usage = Object.fromEntries(["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"]
                .filter(key => Number.isSafeInteger(data[key]) && (data[key] as number) >= 0).map(key => [key, data[key]]));
              if (policy.runtime === "agents-sdk" && event.eventType === "siwc.request")
                await invoke(() => request.emit("siwc.request", { sandboxId: sandbox.id, commandId }));
              if (policy.runtime === "agents-sdk" && event.eventType === "siwc.response")
                await invoke(() => request.emit("siwc.response", { sandboxId: sandbox.id, commandId,
                  ...(typeof data.responseId === "string" ? { responseId: data.responseId } : {}), usage }));
              if (policy.runtime === "codex-cli" && event.eventType === "codex.thread.started" && typeof data.threadId === "string")
                codexThreadId = data.threadId;
              if (policy.runtime === "codex-cli" && event.eventType === "codex.turn.completed")
                await invoke(() => request.emit("agent.usage", { sandboxId: sandbox.id, commandId, threadId: codexThreadId, usage }));
            }
          };
          while (true) {
            signal.throwIfAborted();
            const status = await invoke(() => sandbox.commands.getCommandStatus(commandId!));
            await collectLogs();
            if (status.running === false) {
              commandFinished = true;
              await invoke(() => request.emit("sandbox.command_finished", { sandboxId: sandbox.id, commandId, exitCode: status.exitCode ?? null }));
              if (status.exitCode !== 0) throw new Error("Container agent process failed");
              if (partial.trim()) throw new Error("Incomplete container event stream");
              break;
            }
            if (status.running !== true) throw new Error("Container command status unknown");
            await delay(pollMs, signal);
          }
          const resultBytes = await invoke(() => readBoundedSandboxBytes(sandbox, resultPath, policy.limits.maxOutputBytes, signal));
          let result: unknown;
          try { result = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(resultBytes)); }
          catch { throw new Error("Invalid container agent result"); }
          validateContainerAgentResult(result, job);
          if (result.status !== "succeeded") throw new Error("Container agent reported failure");
          const candidate: AgentRunResult<unknown> = { output: result.output, validation: "pending", metadata: result.metadata };
          const checked = options.finish ? await invoke(() => options.finish!({ ...context, result: candidate })) : candidate;
          signal.throwIfAborted();
          await invoke(() => request.emit("sandbox.agent_completed", { sandboxId: sandbox.id, commandId,
            runtime: policy.runtime, validation: checked.validation ?? "pending", metadata: result.metadata ?? {} }));
          return checked as AgentRunResult<Output>;
        } catch (error) {
          options.environment.invalidate("agent attempt failed or command outcome unknown");
          // Cancel the actual process, not merely its observer. If its stop cannot be proved,
          // ask the owner to delete the whole (now invalid) shared environment.
          let stopped = commandFinished;
          if (commandId && !stopped) {
            try {
              await bounded(() => sandbox.commands.interrupt(commandId!), operationMs);
              const status = await bounded(() => sandbox.commands.getCommandStatus(commandId!), operationMs);
              stopped = status.running === false;
            } catch { stopped = false; }
          }
          let cleanup: unknown;
          // Shared state is invalid after failure. Deleting through its owner also stops any
          // detached descendants which a command-status receipt cannot account for.
          if (launched) cleanup = await options.environment.dispose();
          try { await bounded(() => request.emit("sandbox.agent_failed", { sandboxId: sandbox.id, commandId: commandId ?? null,
            aborted: signal.aborted, processStopped: stopped, ...(cleanup ? { cleanup } : {}) }), operationMs); }
          catch { /* Preserve execution failure if the event sink is unavailable. */ }
          throw error;
        } finally { clearTimeout(deadline); }
      });
    },
  };
}
