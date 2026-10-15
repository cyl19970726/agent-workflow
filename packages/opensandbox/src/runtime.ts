import { createHash } from "node:crypto";
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import type { AgentRunRequest, AgentRunResult, AgentRunner } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner, type SiwcRunnerOptions, type SiwcTool } from "@signal-room/workflow-agent-sdk";
import { AttemptTerminalError, createOpenSandboxWorkspaceTools, validateOpenSandboxToolPolicy,
  type AttemptGate, type OpenSandboxToolPolicy, type SandboxHandle } from "./tools.js";

export interface OpenSandboxProfile {
  /** Host-selected digest-pinned image; never model supplied. */
  image: string;
  ttlSeconds: number;
  resource: { cpu: string; memory: string };
  tools: OpenSandboxToolPolicy;
}
export interface OpenSandboxRunnerOptions {
  connection: { domain: string; protocol: "http" | "https"; apiKey?: string };
  profile: OpenSandboxProfile;
  auth: SiwcRunnerOptions["auth"];
  siwc?: Omit<SiwcRunnerOptions, "auth" | "tools">;
  createSandbox?: typeof Sandbox.create;
  /** Test injection; production omits this to use the official Agents SDK. */
  agentRunnerFactory?: (tools: readonly SiwcTool[]) => AgentRunner;
  /** Host business tools are bound to the same exact request attempt; names must not overlap workspace tools. */
  hostTools?: (request: AgentRunRequest<unknown>) => readonly SiwcTool[] | Promise<readonly SiwcTool[]>;
  /** Kill and close are each bounded. A timed-out operation may continue in the background. */
  cleanupTimeoutMs?: number;
  /** Trusted host stages exact input bytes after workspace creation, before any model tool call. */
  prepare?: (context: { request: AgentRunRequest<unknown>; sandbox: SandboxHandle }) => Promise<void>;
  /** Trusted host collects/validates bytes here before cleanup. No implicit publication. */
  finish?: (context: { request: AgentRunRequest<unknown>; sandbox: SandboxHandle;
    result: AgentRunResult<unknown> }) => Promise<AgentRunResult<unknown>>;
}
export interface SandboxCleanupStatus { remoteKill: "succeeded" | "failed"; clientClose: "succeeded" | "failed"; }
export class OpenSandboxCreateOutcomeUnknownError extends Error {
  readonly code = "OPEN_SANDBOX_CREATE_OUTCOME_UNKNOWN";
  constructor(readonly attemptId: string) { super("OpenSandbox create outcome unknown; reconcile by attempt metadata before retry"); }
}

function validateProfile(profile: OpenSandboxProfile): void {
  if (!/@sha256:[a-f0-9]{64}$/.test(profile.image)) throw new Error("OpenSandbox image must be pinned by sha256 digest");
  if (!Number.isSafeInteger(profile.ttlSeconds) || profile.ttlSeconds < 30 || profile.ttlSeconds > 3600)
    throw new Error("Invalid OpenSandbox TTL");
  if (!/^(?:[1-9]\d*(?:\.\d+)?)$/.test(profile.resource.cpu) || !/^[1-9]\d*(?:Mi|Gi)$/.test(profile.resource.memory))
    throw new Error("Invalid OpenSandbox resource limits");
  if (!profile.tools.workspaceRoot.startsWith("/") || profile.tools.workspaceRoot.includes(".."))
    throw new Error("Invalid OpenSandbox workspace root");
  validateOpenSandboxToolPolicy(profile.tools);
}

export function openSandboxProfileDigest(profile: OpenSandboxProfile, endpoint: {domain:string;protocol:"http"|"https"}): string {
  validateProfile(profile);
  const commands = Object.entries(profile.tools.commands).sort(([a], [b]) => a.localeCompare(b));
  const stable = { sdk: "@alibaba-group/opensandbox@1.1.1", adapterToolSemantics: "workspace-absolute-v2",
    endpoint: `${endpoint.protocol}://${endpoint.domain}`,
    image: profile.image, ttlSeconds: profile.ttlSeconds, resource: profile.resource,
    networkPolicy: { defaultAction: "deny", egress: [] },
    tools: { ...profile.tools, writePrefixes: [...profile.tools.writePrefixes].sort(), commands } };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** Merge this into defineAgent(...).config, so the core's config fingerprint tracks the environment. */
export function openSandboxAgentConfig(profile: OpenSandboxProfile, endpoint: {domain:string;protocol:"http"|"https"}) {
  return { environmentProfileDigest: openSandboxProfileDigest(profile, endpoint) };
}

/** A successful work result remains available even when remote cleanup reports failure. */
export async function withSandboxAttempt<T>(sandbox: Pick<SandboxHandle, "kill" | "close">,
  work: (gate: AttemptGate) => Promise<T>, signal: AbortSignal, cleanupTimeoutMs = 10_000,
  onCleanup?: (cleanup: SandboxCleanupStatus, workFailed: boolean) => Promise<void>):
  Promise<{ result: T; cleanup: SandboxCleanupStatus; cleanupEventRecorded: boolean }> {
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30_000)
    throw new Error("Invalid sandbox cleanup timeout");
  let terminal = false;
  const gate: AttemptGate = {
    assertOpen(current) { if (terminal) throw new AttemptTerminalError(); current.throwIfAborted(); },
    terminal() { terminal = true; },
  };
  type KillOutcome = { ok: true } | { ok: false; error: unknown };
  const boundedCleanup = async (name: "kill" | "close"): Promise<KillOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const action = Promise.resolve().then(() => sandbox[name]()).then(
      (): KillOutcome => ({ ok: true }), (): KillOutcome => ({ ok: false, error: new Error(`Sandbox ${name} failed`) }));
    const timeout = new Promise<KillOutcome>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, error: new Error(`Sandbox ${name} timed out`) }), cleanupTimeoutMs);
    });
    try { return await Promise.race([action, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  };
  let abortKill: Promise<KillOutcome> | undefined;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const onAbort = () => {
    terminal = true;
    abortKill ??= boundedCleanup("kill");
    rejectAbort?.(signal.reason ?? new Error("Agent attempt aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let result!: T;
  let primary: unknown;
  let failed = false;
  try {
    gate.assertOpen(signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      if (signal.aborted) reject(signal.reason ?? new Error("Agent attempt aborted"));
    });
    result = await Promise.race([Promise.resolve().then(() => work(gate)), aborted]);
    signal.throwIfAborted();
  }
  catch (error) { primary = error; failed = true; }
  signal.removeEventListener("abort", onAbort);
  rejectAbort = undefined;
  const cleanupErrors: unknown[] = [];
  const cleanup: SandboxCleanupStatus = { remoteKill: "succeeded", clientClose: "succeeded" };
  try {
    const killOutcome = await (abortKill ?? boundedCleanup("kill"));
    if (!killOutcome.ok) { cleanup.remoteKill = "failed"; cleanupErrors.push(killOutcome.error); }
  } finally {
    const closeOutcome = await boundedCleanup("close");
    if (!closeOutcome.ok) { cleanup.clientClose = "failed"; cleanupErrors.push(closeOutcome.error); }
  }
  let cleanupEventRecorded = false;
  if (onCleanup) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receipt = Promise.resolve().then(() => onCleanup(cleanup, failed)).then(() => true, () => false);
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), cleanupTimeoutMs); });
    try { cleanupEventRecorded = await Promise.race([receipt, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
  if (failed) {
    if (cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], "Agent attempt and sandbox cleanup failed", { cause: primary });
    throw primary;
  }
  return { result, cleanup, cleanupEventRecorded };
}

/** The official Agents SDK and SIWC credentials remain on the host. */
export function createOpenSandboxAgentRunner(options: OpenSandboxRunnerOptions): AgentRunner {
  const profile = structuredClone(options.profile);
  const connection = { ...options.connection };
  const digest = openSandboxProfileDigest(profile, connection);
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30_000)
    throw new Error("Invalid sandbox cleanup timeout");
  const create = options.createSandbox ?? Sandbox.create;
  return {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      if (request.definition.config?.environmentProfileDigest !== digest)
        throw new Error("Agent definition and OpenSandbox environment profile disagree");
      request.signal.throwIfAborted();
      // Write the intent before create; a transport failure may mean a remote sandbox exists.
      await request.emit("sandbox.create_intent", { runId: request.runId, stepRunId: request.stepRunId,
        attemptId: request.attemptId, environmentProfileDigest: digest });
      let sandbox: Sandbox;
      try {
        const config = new ConnectionConfig({ domain: connection.domain, protocol: connection.protocol,
          apiKey: connection.apiKey, requestTimeoutSeconds: 30, disableMetrics: true });
        sandbox = await create({ connectionConfig: config, image: profile.image, timeoutSeconds: profile.ttlSeconds,
          resource: profile.resource, networkPolicy: { defaultAction: "deny", egress: [] },
          signal: request.signal,
          metadata: { workflowRunId: request.runId, stepRunId: request.stepRunId, attemptId: request.attemptId } });
      } catch {
        try { await request.emit("sandbox.create_outcome_unknown", { attemptId: request.attemptId }); }
        catch { /* The typed unknown-outcome error must survive a trace sink failure. */ }
        throw new OpenSandboxCreateOutcomeUnknownError(request.attemptId);
      }
      const completed = await withSandboxAttempt(sandbox, async gate => {
        await request.emit("sandbox.started", { sandboxId: sandbox.id, attemptId: request.attemptId,
          environmentProfileDigest: digest });
        gate.assertOpen(request.signal);
        // OpenSandbox 1.1.1 serializes permission digits as decimal (700), not JS octal (0o700 = 448).
        await sandbox.files.createDirectories([{ path: profile.tools.workspaceRoot, mode: 700 }]);
        gate.assertOpen(request.signal);
        await options.prepare?.({ request: request as AgentRunRequest<unknown>, sandbox });
        gate.assertOpen(request.signal);
        const tools = createOpenSandboxWorkspaceTools(sandbox, profile.tools, gate);
        const hostTools = [...(await options.hostTools?.(request as AgentRunRequest<unknown>) ?? [])];
        gate.assertOpen(request.signal);
        const names = new Set(tools.map(tool => tool.name));
        for (const tool of hostTools) {
          if (names.has(tool.name)) throw new Error(`Duplicate OpenSandbox/host tool name: ${tool.name}`);
          names.add(tool.name);
        }
        tools.push(...hostTools.map(tool => ({ ...tool, async execute(args: Parameters<SiwcTool["execute"]>[0],
          signal: Parameters<SiwcTool["execute"]>[1]) {
          gate.assertOpen(signal);
          try {
            const value = await tool.execute(args, signal);
            gate.assertOpen(signal);
            return value;
          } catch (error) { gate.terminal(); throw error; }
        } })));
        const runner = options.agentRunnerFactory?.(tools) ??
          new OpenAIAgentsSdkRunner({ ...options.siwc, auth: options.auth, tools: () => tools });
        const result = await runner.run(request);
        gate.assertOpen(request.signal);
        const finished = options.finish ? await options.finish({ request: request as AgentRunRequest<unknown>, sandbox,
          result: result as AgentRunResult<unknown> }) : result;
        gate.assertOpen(request.signal);
        return finished as AgentRunResult<Output>;
      }, request.signal, cleanupTimeoutMs, async (cleanup, workFailed) => {
        const event = cleanup.remoteKill === "failed" || cleanup.clientClose === "failed" ? "sandbox.cleanup_failed" : "sandbox.stopped";
        await request.emit(event, { sandboxId: sandbox.id, attemptId: request.attemptId, workFailed, ...cleanup });
      });
      const cleanup = completed.cleanup;
      return { ...completed.result, metadata: { ...completed.result.metadata,
        sandboxRuntime: "opensandbox", sandboxId: sandbox.id, environmentProfileDigest: digest,
        sandboxCleanup: cleanup, cleanupEventRecorded: completed.cleanupEventRecorded } };
    },
  };
}
