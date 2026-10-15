import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ConnectionConfig, Sandbox, SandboxApiException } from "@alibaba-group/opensandbox";
import type { Credential, CredentialBinding, NetworkRule } from "@alibaba-group/opensandbox";
import type { AgentRunRequest } from "@signal-room/workflow";
import type { SandboxCleanupStatus } from "./runtime.js";

const SDK_SEMANTICS = "@alibaba-group/opensandbox@1.1.1:shared-environment-owner-v1";

export interface OpenSandboxEnvironmentProfile {
  /** Host-selected digest-pinned image. */
  image: string;
  ttlSeconds: number;
  resource: { cpu: string; memory: string };
  /** Egress is always default-deny; only these FQDN rules are accepted. */
  networkPolicy?: { egress?: readonly NetworkRule[] };
  /** Native Credential Vault bindings; secret values belong only in `credentials`. */
  credentialBindings?: readonly CredentialBinding[];
}

export interface OpenSandboxEnvironmentConnection {
  domain: string;
  protocol: "http" | "https";
  /** Kept in memory for SDK requests and never included in profile digests/events. */
  apiKey?: string;
}

export interface OpenSandboxEnvironmentBinding {
  readonly sandboxId: string;
  readonly profileDigest: string;
}

export type BorrowedSandboxHandle = Pick<Sandbox, "id" | "files" | "commands">;

export type OpenSandboxEnvironmentEvent = (type: string, data?: Readonly<Record<string, unknown>>) => Promise<void>;

export interface OpenSandboxEnvironmentOwner {
  readonly binding: OpenSandboxEnvironmentBinding;
  use<T>(request: AgentRunRequest<unknown>, callback: (sandbox: BorrowedSandboxHandle) => Promise<T>): Promise<T>;
  /** Prevent any further node from using this environment. The reason is intentionally not retained. */
  invalidate(reason?: unknown): void;
  /** The sole remote-kill authority; repeated and concurrent calls share one cleanup result. */
  dispose(): Promise<SandboxCleanupStatus>;
}

export interface CreateOpenSandboxEnvironmentOptions {
  connection: OpenSandboxEnvironmentConnection;
  profile: OpenSandboxEnvironmentProfile;
  /** Values are read once, used only for Vault creation, then dereferenced. */
  credentials?: () => readonly Pick<Credential, "name" | "source">[] | Promise<readonly Pick<Credential, "name" | "source">[]>;
  signal?: AbortSignal;
  /** Owner lifecycle events; node-use events go through the request's durable attempt emitter. */
  emit?: OpenSandboxEnvironmentEvent;
  createSandbox?: typeof Sandbox.create;
  connectSandbox?: typeof Sandbox.connect;
  cleanupTimeoutMs?: number;
}

export class OpenSandboxEnvironmentError extends Error {
  constructor(readonly code: string, readonly cleanupStatus?: SandboxCleanupStatus, readonly intentId?: string,
    readonly statusCode?: number, readonly providerCode?: string) {
    super(code);
    this.name = "OpenSandboxEnvironmentError";
  }
}

export class OpenSandboxEnvironmentCreateOutcomeUnknownError extends OpenSandboxEnvironmentError {
  constructor(intentId: string) { super("OPEN_SANDBOX_ENVIRONMENT_CREATE_OUTCOME_UNKNOWN", undefined, intentId); }
}

export function openSandboxEnvironmentProfileDigest(
  profile: OpenSandboxEnvironmentProfile,
  connection: Pick<OpenSandboxEnvironmentConnection, "domain" | "protocol">,
): string {
  validateProfile(profile);
  const stable = {
    sdk: SDK_SEMANTICS,
    endpoint: `${connection.protocol}://${connection.domain}`,
    image: profile.image,
    ttlSeconds: profile.ttlSeconds,
    resource: { cpu: profile.resource.cpu, memory: profile.resource.memory },
    networkPolicy: { defaultAction: "deny", egress: normalizedRules(profile.networkPolicy?.egress ?? []) },
    credentialBindings: normalizedBindings(profile.credentialBindings ?? []),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function normalizedRules(rules: readonly NetworkRule[]): NetworkRule[] {
  return rules.map(rule => ({ action: rule.action, target: rule.target }));
}

function normalizedBindings(bindings: readonly CredentialBinding[]): CredentialBinding[] {
  // Rebuild the documented shape instead of serializing caller objects with arbitrary extra properties.
  return bindings.map(binding => ({
    name: binding.name,
    match: {
      hosts: [...binding.match.hosts],
      ...(binding.match.schemes ? { schemes: [...binding.match.schemes] } : {}),
      ...(binding.match.ports ? { ports: [...binding.match.ports] } : {}),
      ...(binding.match.methods ? { methods: [...binding.match.methods] } : {}),
      ...(binding.match.paths ? { paths: [...binding.match.paths] } : {}),
    },
    auth: {
      ...("type" in binding.auth ? { type: binding.auth.type } : {}),
      ...(binding.auth.type === "bearer" || binding.auth.type === "basic"
        ? { credential: binding.auth.credential }
        : {}),
      ...(binding.auth.type === "apiKey"
        ? { name: binding.auth.name, credential: binding.auth.credential }
        : {}),
      ...(binding.auth.type === "customHeaders"
        ? { headers: binding.auth.headers.map(header => ({ name: header.name, credential: header.credential })) }
        : {}),
      ...(binding.auth.substitutions ? { substitutions: binding.auth.substitutions.map(item => ({
        credential: item.credential, placeholder: item.placeholder, in: [...item.in],
      })) } : {}),
    },
  })) as CredentialBinding[];
}

function validFqdn(target: string): boolean {
  if (target.length > 253 || target.includes(":") || target.includes("/") || target.includes("\\")) return false;
  const host = target.startsWith("*.") ? target.slice(2) : target;
  if (target.includes("*") && !target.startsWith("*.")) return false;
  if (isIP(host) !== 0) return false;
  if (!host.includes(".")) return false;
  return host.split(".").every(label => label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function validateProfile(profile: OpenSandboxEnvironmentProfile): void {
  if (!/@sha256:[a-f0-9]{64}$/.test(profile.image)) throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_IMAGE");
  if (!Number.isSafeInteger(profile.ttlSeconds) || profile.ttlSeconds < 30 || profile.ttlSeconds > 3600)
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_TTL");
  if (!/^(?:[1-9]\d*(?:\.\d+)?)$/.test(profile.resource.cpu) || !/^[1-9]\d*(?:Mi|Gi)$/.test(profile.resource.memory))
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_RESOURCE");
  const rules = profile.networkPolicy?.egress ?? [];
  if (rules.length > 64 || rules.some(rule => !["allow", "deny"].includes(rule.action) || !validFqdn(rule.target)))
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_EGRESS_RULE");
  const bindings = profile.credentialBindings ?? [];
  if (bindings.length > 64 || bindings.some(binding => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(binding.name) ||
    !binding.match?.hosts?.length || binding.match.hosts.some(host => !validFqdn(host)) ||
    !binding.auth || !["bearer", "basic", "apiKey", "customHeaders", "passthrough"].includes(binding.auth.type)))
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_CREDENTIAL_BINDING");
  if (new Set(bindings.map(binding => binding.name)).size !== bindings.length)
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_DUPLICATE_CREDENTIAL_BINDING");
  if (bindings.some(binding => binding.match.ports?.some(port => port !== 80 && port !== 443)))
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_CREDENTIAL_PORT");
}

function credentialReferences(binding: CredentialBinding): string[] {
  const names: string[] = [];
  if (binding.auth.type === "bearer" || binding.auth.type === "basic" || binding.auth.type === "apiKey") {
    names.push(binding.auth.credential);
  } else if (binding.auth.type === "customHeaders") {
    names.push(...binding.auth.headers.map(header => header.credential));
  }
  names.push(...(binding.auth.substitutions ?? []).map(item => item.credential));
  return names;
}

function waitBounded<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<
  { ok: true; value: T } | { ok: false; reason: "failed" | "timeout" | "aborted" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = signal ? new Promise<{ ok: false; reason: "aborted" }>(resolve => {
    onAbort = () => resolve({ ok: false, reason: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }) : new Promise<never>(() => undefined);
  return Promise.race([
    operation.then(value => ({ ok: true as const, value }), () => ({ ok: false as const, reason: "failed" as const })),
    new Promise<{ ok: false; reason: "timeout" }>(resolve => { timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs); }),
    aborted,
  ]).then(result => result.ok ? result : { ...result, reason: result.reason ?? "failed" })
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    });
}

function bounded<T>(operation: () => Promise<T> | T, timeoutMs: number, signal?: AbortSignal) {
  return waitBounded(Promise.resolve().then(operation), timeoutMs, signal);
}

function bindingFromMetadata(request: AgentRunRequest<unknown>): OpenSandboxEnvironmentBinding | undefined {
  const value = request.runMetadata?.openSandboxEnvironment;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sandboxId !== "string" || typeof candidate.profileDigest !== "string") return undefined;
  return { sandboxId: candidate.sandboxId, profileDigest: candidate.profileDigest };
}

export async function createOpenSandboxEnvironment(
  options: CreateOpenSandboxEnvironmentOptions,
): Promise<OpenSandboxEnvironmentOwner> {
  validateProfile(options.profile);
  if (!options.connection.domain || options.connection.domain.includes("@") ||
    !["http", "https"].includes(options.connection.protocol))
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_ENDPOINT");
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30_000)
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_CLEANUP_TIMEOUT");

  const profile = structuredClone(options.profile);
  const connection = { ...options.connection };
  const profileDigest = openSandboxEnvironmentProfileDigest(profile, connection);
  const bindings = normalizedBindings(profile.credentialBindings ?? []);
  const credentialLoader = options.credentials;
  if (Boolean(bindings.length) !== Boolean(credentialLoader))
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_CREDENTIALS_AND_BINDINGS_REQUIRED_TOGETHER");

  const ownerIntentId = randomUUID();
  let credentials: Credential[] = [];
  if (credentialLoader) {
    const loaded = await bounded(credentialLoader, cleanupTimeoutMs, options.signal);
    if (!loaded.ok) throw new OpenSandboxEnvironmentError(
      loaded.reason === "aborted" ? "OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED" : "OPEN_SANDBOX_CREDENTIAL_SOURCE_FAILED",
      undefined,
      ownerIntentId,
    );
    const provided = loaded.value;
    try {
      credentials = provided.map(item => ({ name: item.name, source: { type: "inline", value: item.source.value } }));
    } catch {
      throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_CREDENTIALS");
    }
    if (!credentials.length || credentials.some(item => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.name) ||
      typeof item.source.value !== "string" || !item.source.value) ||
      new Set(credentials.map(item => item.name)).size !== credentials.length)
      throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_INVALID_CREDENTIALS");
    const available = new Set(credentials.map(item => item.name));
    if (bindings.some(binding => credentialReferences(binding).some(name => !available.has(name))))
      throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_CREDENTIAL_BINDING_REFERENCE_MISSING");
  }

  const create = options.createSandbox ?? Sandbox.create;
  const config = new ConnectionConfig({ ...connection, requestTimeoutSeconds: 30, disableMetrics: true });
  if (options.signal?.aborted) {
    credentials = [];
    await config.closeTransport().catch(() => undefined);
    throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED");
  }
  const intentEmitted = await bounded(() => options.emit?.("opensandbox.environment.create_intent", {
    intentId: ownerIntentId, profileDigest,
  }), cleanupTimeoutMs, options.signal);
  if (!intentEmitted.ok) {
    credentials = [];
    await config.closeTransport().catch(() => undefined);
    throw new OpenSandboxEnvironmentError(
      intentEmitted.reason === "aborted" ? "OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED" : "OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED",
      undefined,
      ownerIntentId,
    );
  }
  let sandbox: Sandbox;
  try {
    if (options.signal?.aborted) throw new Error("aborted");
    sandbox = await create({ connectionConfig: config, image: profile.image, entrypoint: ["sleep", "infinity"], timeoutSeconds: profile.ttlSeconds,
      resource: profile.resource,
      networkPolicy: { defaultAction: "deny", egress: normalizedRules(profile.networkPolicy?.egress ?? []) },
      ...(bindings.length ? { credentialProxy: { enabled: true } } : {}),
      signal: options.signal,
      metadata: { purpose: "workflow-shared-environment", environmentProfileDigestA: profileDigest.slice(0, 32),
        environmentProfileDigestB: profileDigest.slice(32),
        openSandboxEnvironmentIntentId: ownerIntentId } });
  } catch (error) {
    await config.closeTransport().catch(() => undefined);
    if (error instanceof SandboxApiException && typeof error.statusCode === "number" &&
      error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408) {
      const rawCode = error.error?.code;
      const providerCode = typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : undefined;
      throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_ENVIRONMENT_CREATE_REJECTED", undefined,
        ownerIntentId, error.statusCode, providerCode);
    }
    throw new OpenSandboxEnvironmentCreateOutcomeUnknownError(ownerIntentId);
  }

  const binding = Object.freeze({ sandboxId: sandbox.id, profileDigest });
  const cleanupCreated = async (): Promise<SandboxCleanupStatus> => {
    const status: SandboxCleanupStatus = { remoteKill: "succeeded", clientClose: "succeeded" };
    if (!(await waitBounded(Promise.resolve().then(() => sandbox.kill()), cleanupTimeoutMs)).ok) status.remoteKill = "failed";
    if (!(await waitBounded(Promise.resolve().then(() => sandbox.close()), cleanupTimeoutMs)).ok) status.clientClose = "failed";
    if (!(await waitBounded(config.closeTransport(), cleanupTimeoutMs)).ok) status.clientClose = "failed";
    return status;
  };
  try {
    if (options.signal?.aborted) throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED");
    if (bindings.length) {
      const vault = await bounded(() => sandbox.credentialVault.create({ credentials, bindings }), cleanupTimeoutMs, options.signal);
      if (!vault.ok) throw new OpenSandboxEnvironmentError(
        vault.reason === "aborted" ? "OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED" : "OPEN_SANDBOX_VAULT_SETUP_FAILED",
      );
      credentials = [];
    }
    const started = await bounded(() => options.emit?.("opensandbox.environment.started", {
      ...binding, intentId: ownerIntentId,
    }), cleanupTimeoutMs, options.signal);
    if (!started.ok) throw new OpenSandboxEnvironmentError(
      started.reason === "aborted" ? "OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED" : "OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED",
    );
    if (options.signal?.aborted) throw new OpenSandboxEnvironmentError("OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED");
  } catch (error) {
    credentials = [];
    const cleanupStatus = await cleanupCreated();
    throw new OpenSandboxEnvironmentError(
      error instanceof OpenSandboxEnvironmentError ? error.code : "OPEN_SANDBOX_ENVIRONMENT_SETUP_FAILED",
      cleanupStatus,
      ownerIntentId,
    );
  }

  return makeOwner({ sandbox, binding, connection, config, intentId: ownerIntentId, cleanupTimeoutMs,
    connect: options.connectSandbox ?? Sandbox.connect, emit: options.emit });
}

function makeOwner(options: {
  sandbox: Sandbox;
  binding: OpenSandboxEnvironmentBinding;
  connection: OpenSandboxEnvironmentConnection;
  config: ConnectionConfig;
  intentId: string;
  cleanupTimeoutMs: number;
  connect: typeof Sandbox.connect;
  emit?: OpenSandboxEnvironmentEvent;
}): OpenSandboxEnvironmentOwner {
  let disposed = false;
  let invalidated = false;
  let locked = false;
  let boundRunId: string | undefined;
  const usedAttempts = new Set<string>();
  let disposePromise: Promise<SandboxCleanupStatus> | undefined;
  const clients = new Map<Sandbox, ConnectionConfig>();

  const invalid = (code: string): OpenSandboxEnvironmentError => new OpenSandboxEnvironmentError(code);
  const owner: OpenSandboxEnvironmentOwner = {
    binding: options.binding,
    invalidate(_reason?: unknown) { invalidated = true; },
    async use<T>(request: AgentRunRequest<unknown>, callback: (sandbox: BorrowedSandboxHandle) => Promise<T>): Promise<T> {
      if (invalidated) throw invalid("OPEN_SANDBOX_ENVIRONMENT_INVALIDATED");
      if (disposed) throw invalid("OPEN_SANDBOX_ENVIRONMENT_DISPOSED");
      const suppliedBinding = bindingFromMetadata(request);
      if (!suppliedBinding || suppliedBinding.sandboxId !== options.binding.sandboxId ||
        suppliedBinding.profileDigest !== options.binding.profileDigest)
        throw invalid("OPEN_SANDBOX_ENVIRONMENT_BINDING_MISMATCH");
      if (boundRunId !== undefined && boundRunId !== request.runId)
        throw invalid("OPEN_SANDBOX_ENVIRONMENT_RUN_MISMATCH");
      if (locked) throw invalid("OPEN_SANDBOX_ENVIRONMENT_CONCURRENT_USE");
      if (usedAttempts.has(request.attemptId)) throw invalid("OPEN_SANDBOX_ENVIRONMENT_ATTEMPT_ALREADY_USED");
      if (request.signal.aborted) throw invalid("OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED");
      boundRunId ??= request.runId;
      usedAttempts.add(request.attemptId);
      locked = true;
      const identity = { runId: request.runId, stepRunId: request.stepRunId, attemptId: request.attemptId,
        sandboxId: options.binding.sandboxId, profileDigest: options.binding.profileDigest };
      let client: Sandbox | undefined;
      let clientConfig: ConnectionConfig | undefined;
      let primaryFailure: OpenSandboxEnvironmentError | undefined;
      try {
        const useIntent = await bounded(() => request.emit("opensandbox.environment.use_intent", identity), options.cleanupTimeoutMs, request.signal);
        if (!useIntent.ok) throw invalid(useIntent.reason === "aborted"
          ? "OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED" : "OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED");
        clientConfig = new ConnectionConfig({ ...options.connection, requestTimeoutSeconds: 30, disableMetrics: true });
        const connectOperation = Promise.resolve().then(() => options.connect({
          connectionConfig: clientConfig!, sandboxId: options.binding.sandboxId, signal: request.signal,
        }));
        const connected = await waitBounded(connectOperation, options.cleanupTimeoutMs, request.signal);
        if (!connected.ok) {
          // A custom connector may ignore abort/timeout and produce a late client; close it when it eventually arrives.
          void connectOperation.then(late => {
            void waitBounded(Promise.resolve().then(() => late.close()), options.cleanupTimeoutMs);
          }, () => undefined);
          await waitBounded(clientConfig.closeTransport(), options.cleanupTimeoutMs);
          throw invalid(connected.reason === "aborted" ? "OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED" :
            connected.reason === "timeout" ? "OPEN_SANDBOX_ENVIRONMENT_CONNECT_TIMEOUT" : "OPEN_SANDBOX_ENVIRONMENT_CONNECT_FAILED");
        }
        client = connected.value;
        clients.set(client, clientConfig);
        if (disposed || invalidated || request.signal.aborted)
          throw invalid(request.signal.aborted ? "OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED" : "OPEN_SANDBOX_ENVIRONMENT_INVALIDATED");
        const connectedEvent = await bounded(() => request.emit("opensandbox.environment.connected", identity), options.cleanupTimeoutMs, request.signal);
        if (!connectedEvent.ok) throw invalid(connectedEvent.reason === "aborted"
          ? "OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED" : "OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED");
        const borrowed = { id: client.id, files: client.files, commands: client.commands };
        const work = Promise.resolve().then(() => callback(borrowed));
        // Observe the callback even when the caller aborts so a later rejection is never unhandled.
        const observedWork = work.then(value => ({ kind: "value" as const, value }), () => ({ kind: "error" as const }));
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<{ kind: "abort" }>(resolve => {
          onAbort = () => resolve({ kind: "abort" });
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) onAbort();
        });
        const outcome = await Promise.race([observedWork, aborted]);
        if (onAbort) request.signal.removeEventListener("abort", onAbort);
        if (outcome.kind === "abort") {
          invalidated = true;
          // Keep the client alive long enough for the callback/host runner to interrupt its active command.
          const settled = await waitBounded(observedWork, options.cleanupTimeoutMs);
          if (!settled.ok) {
            await owner.dispose();
            throw invalid("OPEN_SANDBOX_ENVIRONMENT_ABORT_CLEANUP_TIMEOUT");
          }
          throw invalid("OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED");
        }
        if (outcome.kind === "error") throw invalid("OPEN_SANDBOX_ENVIRONMENT_NODE_FAILED");
        if (invalidated || disposed) throw invalid("OPEN_SANDBOX_ENVIRONMENT_INVALIDATED");
        request.signal.throwIfAborted();
        const completedEvent = await bounded(() => request.emit("opensandbox.environment.use_completed", identity), options.cleanupTimeoutMs);
        if (!completedEvent.ok) throw invalid("OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED");
        return outcome.value;
      } catch (error) {
        invalidated = true;
        const failure = error instanceof OpenSandboxEnvironmentError
          ? error
          : invalid(request.signal.aborted ? "OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED" : "OPEN_SANDBOX_ENVIRONMENT_NODE_FAILED");
        // This catch is reachable only after the use lock and binding checks passed. Dispose here
        // as well as at the outer run boundary so failures before the host callback cannot leak a
        // newly created environment until TTL. Abort handling above waits for callback cleanup first.
        const cleanupStatus = await owner.dispose();
        primaryFailure = new OpenSandboxEnvironmentError(failure.code, cleanupStatus, options.intentId);
        try { await bounded(() => request.emit("opensandbox.environment.use_failed", {
          ...identity, code: primaryFailure!.code, cleanup: cleanupStatus,
        }), options.cleanupTimeoutMs); }
        catch { /* Trace failure must not reveal or replace the primary safe code. */ }
        throw primaryFailure;
      } finally {
        try {
          if (client && clients.has(client)) {
            const closed = await waitBounded(Promise.resolve().then(() => client!.close()), options.cleanupTimeoutMs);
            clients.delete(client);
            if (clientConfig) {
              const configClosed = await waitBounded(clientConfig.closeTransport(), options.cleanupTimeoutMs);
              if (!configClosed.ok) {
                invalidated = true;
                if (!primaryFailure) throw invalid("OPEN_SANDBOX_ENVIRONMENT_CLIENT_CLOSE_FAILED");
              }
            }
            if (!closed.ok) {
              invalidated = true;
              if (!primaryFailure) throw invalid("OPEN_SANDBOX_ENVIRONMENT_CLIENT_CLOSE_FAILED");
            }
            const released = await bounded(() => request.emit("opensandbox.environment.released", identity), options.cleanupTimeoutMs);
            if (!released.ok) {
              invalidated = true;
              if (!primaryFailure) throw invalid("OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED");
            }
          }
        } finally {
          locked = false;
        }
      }
    },
    async dispose(): Promise<SandboxCleanupStatus> {
      if (disposePromise) return disposePromise;
      disposed = true;
      invalidated = true;
      disposePromise = (async () => {
        const status: SandboxCleanupStatus = { remoteKill: "succeeded", clientClose: "succeeded" };
        const kill = await waitBounded(Promise.resolve().then(() => options.sandbox.kill()), options.cleanupTimeoutMs);
        if (!kill.ok) status.remoteKill = "failed";
        const close = await waitBounded(Promise.resolve().then(() => options.sandbox.close()), options.cleanupTimeoutMs);
        if (!close.ok) status.clientClose = "failed";
        const ownerConfigClose = await waitBounded(options.config.closeTransport(), options.cleanupTimeoutMs);
        if (!ownerConfigClose.ok) status.clientClose = "failed";
        for (const [client, config] of clients) {
          const clientClose = await waitBounded(Promise.resolve().then(() => client.close()), options.cleanupTimeoutMs);
          if (!clientClose.ok) status.clientClose = "failed";
          const configClose = await waitBounded(config.closeTransport(), options.cleanupTimeoutMs);
          if (!configClose.ok) status.clientClose = "failed";
          clients.delete(client);
        }
        try { await bounded(() => options.emit?.("opensandbox.environment.cleanup", {
          ...options.binding, ...status, intentId: options.intentId,
        }), options.cleanupTimeoutMs); }
        catch { /* Lifecycle cleanup receipts are best-effort; do not turn cleanup into a secret-bearing error. */ }
        return status;
      })();
      return disposePromise;
    },
  };
  return Object.freeze(owner);
}
