import { describe, expect, it, vi } from "vitest";
import { SandboxApiException, SandboxError } from "@alibaba-group/opensandbox";
import type { Credential, Sandbox, SandboxCreateOptions, SandboxConnectOptions } from "@alibaba-group/opensandbox";
import type { AgentRunRequest } from "@signal-room/workflow";
import {
  createOpenSandboxEnvironment,
  openSandboxEnvironmentProfileDigest,
  OpenSandboxEnvironmentCreateOutcomeUnknownError,
  type OpenSandboxEnvironmentBinding,
  type OpenSandboxEnvironmentProfile,
} from "./environment.js";

const endpoint = { domain: "sandbox.example.test:8080", protocol: "https" as const, apiKey: "test-api-key-never-traced" };
const image = `local/codex@sha256:${"a".repeat(64)}`;
const profile: OpenSandboxEnvironmentProfile = {
  image,
  ttlSeconds: 90,
  resource: { cpu: "2", memory: "2Gi" },
  networkPolicy: { egress: [{ action: "allow", target: "api.openai.com" }] },
};

function request(binding: OpenSandboxEnvironmentBinding, options: {
  runId?: string; attemptId?: string; signal?: AbortSignal; events?: Array<{ type: string; data?: unknown }>; failEvent?: string;
} = {}): AgentRunRequest<unknown> {
  return {
    runId: options.runId ?? "run-1",
    stepRunId: `step-${options.attemptId ?? "1"}`,
    attemptId: options.attemptId ?? "attempt-1",
    definition: { id: "test", revision: "1", model: "test", reasoningEffort: "low", promptRevision: "1",
      skillsRevision: "1", permissionsRevision: "1" },
    input: { task: "test" },
    signal: options.signal ?? new AbortController().signal,
    runMetadata: { openSandboxEnvironment: binding },
    async emit(type, data) {
      options.events?.push({ type, data });
      if (type === options.failEvent) throw new Error("private event sink response");
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { kill?: () => Promise<void>; ownerClose?: () => Promise<void>; clientClose?: () => Promise<void> } = {}) {
  const files = new Map<string, Uint8Array>();
  const created: SandboxCreateOptions[] = [];
  const connected: SandboxConnectOptions[] = [];
  const calls: string[] = [];
  const vaultRequests: unknown[] = [];
  const sandbox = {
    id: "sandbox-owner-1",
    files: {
      async writeFiles(entries: Array<{ path: string; data?: string | Uint8Array }>) {
        for (const entry of entries) files.set(entry.path, typeof entry.data === "string" ? Buffer.from(entry.data) : entry.data!);
      },
      async readBytes(path: string) {
        const data = files.get(path);
        if (!data) throw new Error("not found");
        return data;
      },
    },
    commands: { async run() { return { complete: { timestamp: 1, executionTimeMs: 1 }, exitCode: 0, logs: { stdout: [], stderr: [] } }; } },
    credentialVault: {
      async create(value: unknown) { calls.push("vault.create"); vaultRequests.push(value); return { revision: 1, credentials: [], bindings: [] }; },
      async get() { return { revision: 1, credentials: [], bindings: [] }; },
      async patch() { return { revision: 1, credentials: [], bindings: [] }; },
      async delete() {}, async listCredentials() { return []; }, async getCredential() { return { name: "", sourceType: "inline", revision: 1 }; },
      async listBindings() { return []; }, async getBinding() { return { name: "", revision: 1 }; },
    },
    async kill() { calls.push("owner.kill"); await options.kill?.(); },
    async close() { calls.push("owner.close"); await options.ownerClose?.(); },
  } as unknown as Sandbox;
  const connectClient = () => ({
    id: sandbox.id,
    files: sandbox.files,
    commands: sandbox.commands,
    credentialVault: sandbox.credentialVault,
    async kill() { calls.push("borrowed.kill"); },
    async close() { calls.push("client.close"); await options.clientClose?.(); },
  } as unknown as Sandbox);
  const createSandbox = vi.fn(async (value: SandboxCreateOptions) => { created.push(value); return sandbox; });
  const connectSandbox = vi.fn(async (value: SandboxConnectOptions) => { connected.push(value); return connectClient(); });
  return { sandbox, files, created, connected, calls, vaultRequests, createSandbox, connectSandbox };
}

async function ownerFor(f: ReturnType<typeof fixture>, overrides: Partial<Parameters<typeof createOpenSandboxEnvironment>[0]> = {}) {
  return createOpenSandboxEnvironment({ connection: endpoint, profile,
    createSandbox: f.createSandbox as typeof Sandbox.create,
    connectSandbox: f.connectSandbox as typeof Sandbox.connect,
    ...overrides,
  });
}

describe("shared OpenSandbox environment owner", () => {
  it("fingerprints profile and endpoint but excludes the connection API key", () => {
    const first = openSandboxEnvironmentProfileDigest(profile, endpoint);
    expect(openSandboxEnvironmentProfileDigest(profile, { ...endpoint, apiKey: "different-secret" })).toBe(first);
    expect(openSandboxEnvironmentProfileDigest({ ...profile, ttlSeconds: 91 }, endpoint)).not.toBe(first);
    expect(openSandboxEnvironmentProfileDigest(profile, { ...endpoint, domain: "other.example.test" })).not.toBe(first);
  });

  it("creates one deny-by-default environment and initializes the native Vault without tracing values", async () => {
    const f = fixture();
    const events: Array<{ type: string; data?: unknown }> = [];
    const bindingProfile: OpenSandboxEnvironmentProfile = {
      ...profile,
      credentialBindings: [{ name: "openai", match: { schemes: ["https"], hosts: ["api.openai.com"], paths: ["/v1/responses"] },
        auth: { type: "bearer", credential: "openai-token" } }],
    };
    const owner = await ownerFor(f, { profile: bindingProfile, credentials: async () => [
      { name: "openai-token", source: { value: "credential-plaintext-must-not-escape" } },
    ], emit: async (type, data) => { events.push({ type, data }); } });
    expect(f.createSandbox).toHaveBeenCalledTimes(1);
    expect(f.created[0]).toMatchObject({
      image,
      entrypoint: ["sleep", "infinity"],
      timeoutSeconds: 90,
      networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "api.openai.com" }] },
      credentialProxy: { enabled: true },
    });
    const remoteMetadata = f.created[0]!.metadata!;
    expect(Object.values(remoteMetadata).every(value => value.length <= 63)).toBe(true);
    expect(remoteMetadata.environmentProfileDigestA + remoteMetadata.environmentProfileDigestB)
      .toBe(owner.binding.profileDigest);
    expect(f.vaultRequests).toEqual([{
      credentials: [{ name: "openai-token", source: { type: "inline", value: "credential-plaintext-must-not-escape" } }],
      bindings: bindingProfile.credentialBindings,
    }]);
    expect(JSON.stringify(events)).not.toContain("credential-plaintext-must-not-escape");
    expect(JSON.stringify(owner.binding)).not.toContain(endpoint.apiKey);
    expect(Object.isFrozen(owner.binding)).toBe(true);
    await owner.dispose();
  });

  it("lets serial node clients share bytes but only the outer owner kills the environment", async () => {
    const f = fixture();
    const events: Array<{ type: string; data?: unknown }> = [];
    const owner = await ownerFor(f, { emit: async (type, data) => { events.push({ type, data }); } });
    const nodeA = request(owner.binding, { attemptId: "attempt-A", events });
    await owner.use(nodeA, async sandbox => {
      expect("kill" in sandbox).toBe(false);
      expect("close" in sandbox).toBe(false);
      await sandbox.files.writeFiles([{ path: "/work/a.txt", data: "bytes-from-A" }]);
      return "A";
    });
    const nodeB = request(owner.binding, { attemptId: "attempt-B", events });
    const seen = await owner.use(nodeB, async sandbox => {
      const bytes = await sandbox.files.readBytes("/work/a.txt");
      await sandbox.files.writeFiles([{ path: "/work/b.txt", data: Buffer.from(bytes).toString("utf8") + ":consumed-by-B" }]);
      return Buffer.from(bytes).toString("utf8");
    });
    expect(seen).toBe("bytes-from-A");
    expect(Buffer.from(await f.sandbox.files.readBytes("/work/b.txt")).toString()).toBe("bytes-from-A:consumed-by-B");
    expect(f.createSandbox).toHaveBeenCalledTimes(1);
    expect(f.connectSandbox).toHaveBeenCalledTimes(2);
    expect(f.connected.map(item => item.sandboxId)).toEqual([owner.binding.sandboxId, owner.binding.sandboxId]);
    expect(f.calls).toEqual(["client.close", "client.close"]);
    expect(events.map(item => item.type)).toEqual([
      "opensandbox.environment.create_intent", "opensandbox.environment.started",
      "opensandbox.environment.use_intent", "opensandbox.environment.connected", "opensandbox.environment.use_completed", "opensandbox.environment.released",
      "opensandbox.environment.use_intent", "opensandbox.environment.connected", "opensandbox.environment.use_completed", "opensandbox.environment.released",
    ]);
    await owner.dispose();
    expect(f.calls.slice(-2)).toEqual(["owner.kill", "owner.close"]);
    expect(f.calls).not.toContain("borrowed.kill");
  });

  it("rejects wrong run/binding and duplicate attempts before connecting", async () => {
    const f = fixture();
    const owner = await ownerFor(f);
    const wrong = { ...owner.binding, sandboxId: "other-sandbox" };
    await expect(owner.use(request(wrong), async () => null)).rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_BINDING_MISMATCH" });
    expect(f.calls).toEqual([]);
    await owner.use(request(owner.binding), async () => "done");
    await expect(owner.use(request(owner.binding), async () => "again"))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_ATTEMPT_ALREADY_USED" });
    await expect(owner.use(request(owner.binding, { runId: "run-2", attemptId: "attempt-2" }), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_RUN_MISMATCH" });
    expect(f.connectSandbox).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });

  it("rejects overlap immediately while allowing the already active use to finish", async () => {
    const f = fixture();
    const owner = await ownerFor(f);
    const work = deferred<string>();
    const first = owner.use(request(owner.binding), async () => work.promise);
    await vi.waitFor(() => expect(f.connectSandbox).toHaveBeenCalledTimes(1));
    await expect(owner.use(request(owner.binding, { attemptId: "attempt-2" }), async () => "second"))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_CONCURRENT_USE" });
    expect(f.calls).not.toContain("owner.kill");
    work.resolve("first");
    await expect(first).resolves.toBe("first");
    expect(f.calls).toEqual(["client.close"]);
    await owner.dispose();
  });

  it("keeps the borrowed client open after cancellation until callback cleanup settles", async () => {
    const f = fixture();
    const owner = await ownerFor(f, { cleanupTimeoutMs: 100 });
    const controller = new AbortController();
    const work = deferred<string>();
    const running = owner.use(request(owner.binding, { signal: controller.signal }), async () => work.promise);
    await vi.waitFor(() => expect(f.connectSandbox).toHaveBeenCalledTimes(1));
    controller.abort(new Error("cancel"));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.calls).not.toContain("client.close");
    work.resolve("ignored late result");
    await expect(running).rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_USE_ABORTED" });
    expect(f.calls).toEqual(["owner.kill", "owner.close", "client.close"]);
    await expect(owner.use(request(owner.binding, { attemptId: "attempt-2" }), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_INVALIDATED" });
    await owner.dispose();
  });

  it("invalidates after callback failure and never exposes its arbitrary error text", async () => {
    const f = fixture();
    const owner = await ownerFor(f);
    let rejected: unknown;
    try {
      await owner.use(request(owner.binding), async () => { throw new Error("secret SDK response body"); });
    } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_NODE_FAILED" });
    expect(String(rejected)).not.toContain("secret SDK response body");
    await expect(owner.use(request(owner.binding, { attemptId: "attempt-2" }), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_INVALIDATED" });
    await owner.dispose();
  });

  it("reports create outcome as unknown without retrying or leaking the provider body", async () => {
    const f = fixture();
    const emit = vi.fn(async () => {});
    const createSandbox = vi.fn(async (_options: SandboxCreateOptions) => { throw new Error("secret provider response body"); });
    let failure: unknown;
    try { await createOpenSandboxEnvironment({ connection: endpoint, profile, createSandbox: createSandbox as typeof Sandbox.create, emit }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OpenSandboxEnvironmentCreateOutcomeUnknownError);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("opensandbox.environment.create_intent", expect.objectContaining({
      intentId: expect.any(String), profileDigest: expect.any(String),
    }));
    expect((failure as OpenSandboxEnvironmentCreateOutcomeUnknownError).intentId)
      .toBe((emit.mock.calls[0]?.[1] as { intentId: string }).intentId);
    expect(createSandbox.mock.calls[0]?.[0].metadata?.openSandboxEnvironmentIntentId)
      .toBe((failure as OpenSandboxEnvironmentCreateOutcomeUnknownError).intentId);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("secret provider response body");
    expect(f.createSandbox).not.toHaveBeenCalled();
  });

  it("reports explicit non-timeout 4xx rejection with only allowlisted diagnostics", async () => {
    const createSandbox = vi.fn(async () => {
      throw new SandboxApiException({ statusCode: 400,
        error: new SandboxError("INVALID_ARGUMENT", "private provider response body") });
    });
    let failure: unknown;
    try { await createOpenSandboxEnvironment({ connection: endpoint, profile,
      createSandbox: createSandbox as typeof Sandbox.create }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_CREATE_REJECTED", statusCode: 400,
      providerCode: "INVALID_ARGUMENT", intentId: expect.any(String) });
    expect(String(failure)).not.toContain("private provider response body");
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP 408 create failures in the unknown-outcome category", async () => {
    const createSandbox = vi.fn(async () => {
      throw new SandboxApiException({ statusCode: 408,
        error: new SandboxError("UNEXPECTED_RESPONSE", "private timeout response") });
    });
    await expect(createOpenSandboxEnvironment({ connection: endpoint, profile,
      createSandbox: createSandbox as typeof Sandbox.create }))
      .rejects.toBeInstanceOf(OpenSandboxEnvironmentCreateOutcomeUnknownError);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it("does not allocate when creation is already canceled", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort("private reason");
    await expect(ownerFor(f, { signal: controller.signal })).rejects.toMatchObject({
      code: "OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED",
    });
    expect(f.createSandbox).not.toHaveBeenCalled();
  });

  it("cleans up a sandbox returned after cancellation and never hands out an owner", async () => {
    const f = fixture();
    const controller = new AbortController();
    const createSandbox = vi.fn(async () => {
      controller.abort("cancelled after create");
      return f.sandbox;
    });
    let failure: unknown;
    try {
      await createOpenSandboxEnvironment({ connection: endpoint, profile, signal: controller.signal,
        createSandbox: createSandbox as typeof Sandbox.create });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_CREATE_ABORTED", cleanupStatus: {
      remoteKill: "succeeded", clientClose: "succeeded",
    } });
    expect(f.calls).toEqual(["owner.kill", "owner.close"]);
  });

  it("bounds credential loading and lifecycle emission before creating a sandbox", async () => {
    const f = fixture();
    const emit = vi.fn(async () => new Promise<void>(() => {}));
    await expect(ownerFor(f, { cleanupTimeoutMs: 5, emit }))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED" });
    expect(f.createSandbox).not.toHaveBeenCalled();

    const bindingProfile: OpenSandboxEnvironmentProfile = {
      ...profile,
      credentialBindings: [{ name: "token", match: { hosts: ["api.example.test"] }, auth: { type: "bearer", credential: "key" } }],
    };
    const pendingCredentials = deferred<readonly Pick<Credential, "name" | "source">[]>();
    await expect(createOpenSandboxEnvironment({ connection: endpoint, profile: bindingProfile, cleanupTimeoutMs: 5,
      credentials: () => pendingCredentials.promise, createSandbox: f.createSandbox as typeof Sandbox.create }))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_CREDENTIAL_SOURCE_FAILED" });
    expect(f.createSandbox).not.toHaveBeenCalled();
  });

  it("cleans a partially initialized Vault environment and sanitizes the failure", async () => {
    const f = fixture({ kill: async () => { throw new Error("secret delete response"); } });
    (f.sandbox.credentialVault as unknown as { create: () => Promise<never> }).create = async () => {
      throw new Error("secret vault response");
    };
    const vaultProfile: OpenSandboxEnvironmentProfile = {
      ...profile,
      credentialBindings: [{ name: "token", match: { hosts: ["api.example.test"] }, auth: { type: "bearer", credential: "key" } }],
    };
    let failure: unknown;
    try {
      await ownerFor(f, { profile: vaultProfile, credentials: () => [{ name: "key", source: { value: "secret" } }] });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "OPEN_SANDBOX_VAULT_SETUP_FAILED", cleanupStatus: {
      remoteKill: "failed", clientClose: "succeeded",
    } });
    expect(String(failure)).not.toContain("secret delete response");
    expect(f.calls).toEqual(["owner.kill", "owner.close"]);
  });

  it("bounds Vault initialization and reports residual cleanup status", async () => {
    const f = fixture();
    (f.sandbox.credentialVault as unknown as { create: () => Promise<never> }).create = async () => new Promise<never>(() => {});
    const vaultProfile: OpenSandboxEnvironmentProfile = {
      ...profile,
      credentialBindings: [{ name: "token", match: { hosts: ["api.example.test"] }, auth: { type: "bearer", credential: "key" } }],
    };
    await expect(ownerFor(f, { profile: vaultProfile, cleanupTimeoutMs: 5,
      credentials: () => [{ name: "key", source: { value: "credential-secret" } }] }))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_VAULT_SETUP_FAILED", cleanupStatus: {
        remoteKill: "succeeded", clientClose: "succeeded",
      } });
    expect(f.calls).toEqual(["owner.kill", "owner.close"]);
  });

  it("kills the environment when an aborted callback will not settle by the cleanup deadline", async () => {
    const f = fixture();
    const owner = await ownerFor(f, { cleanupTimeoutMs: 5 });
    const controller = new AbortController();
    const work = deferred<string>();
    const running = owner.use(request(owner.binding, { signal: controller.signal }), async () => work.promise);
    await vi.waitFor(() => expect(f.connectSandbox).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_ABORT_CLEANUP_TIMEOUT" });
    expect(f.calls).toContain("owner.kill");
    expect(f.calls).toContain("owner.close");
    work.resolve("late result");
    await owner.dispose();
  });

  it("bounds a stalled node connection", async () => {
    const f = fixture();
    const owner = await ownerFor(f, { cleanupTimeoutMs: 5,
      connectSandbox: (async () => new Promise<Sandbox>(() => {})) as typeof Sandbox.connect });
    await expect(owner.use(request(owner.binding), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_CONNECT_TIMEOUT" });
    await expect(owner.use(request(owner.binding, { attemptId: "attempt-2" }), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_INVALIDATED" });
    await owner.dispose();
  });

  it("disposes after a connect failure before entering the host callback", async () => {
    const f = fixture();
    const owner = await ownerFor(f, { connectSandbox: (async () => { throw new Error("private connect response"); }) as typeof Sandbox.connect });
    await expect(owner.use(request(owner.binding), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_CONNECT_FAILED", cleanupStatus: {
        remoteKill: "succeeded", clientClose: "succeeded",
      } });
    expect(f.calls).toEqual(["owner.kill", "owner.close"]);
    expect(f.createSandbox).toHaveBeenCalledTimes(1);
  });

  it("disposes after a connected-event failure and includes safe cleanup receipt", async () => {
    const f = fixture();
    const owner = await ownerFor(f);
    const events: Array<{ type: string; data?: unknown }> = [];
    await expect(owner.use(request(owner.binding, { events, failEvent: "opensandbox.environment.connected" }), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_TRACE_FAILED", cleanupStatus: {
        remoteKill: "succeeded", clientClose: "succeeded",
      } });
    expect(events.find(event => event.type === "opensandbox.environment.use_failed")?.data)
      .toMatchObject({ cleanup: { remoteKill: "succeeded", clientClose: "succeeded" } });
    expect(JSON.stringify(events)).not.toContain("private event sink response");
    expect(f.calls.filter(call => call === "owner.kill")).toHaveLength(1);
    expect(f.calls.filter(call => call === "owner.close")).toHaveLength(1);
  });

  it("rejects an IP address as an egress FQDN", async () => {
    const f = fixture();
    await expect(ownerFor(f, { profile: { ...profile, networkPolicy: { egress: [{ action: "allow", target: "1.2.3.4" }] } } }))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_INVALID_EGRESS_RULE" });
    expect(f.createSandbox).not.toHaveBeenCalled();
  });

  it("bounds and memoizes owner kill/close while returning cleanup failures", async () => {
    const f = fixture({ kill: () => new Promise<void>(() => {}), ownerClose: () => new Promise<void>(() => {}) });
    const owner = await ownerFor(f, { cleanupTimeoutMs: 5 });
    const first = await owner.dispose();
    expect(first).toEqual({ remoteKill: "failed", clientClose: "failed" });
    expect(await owner.dispose()).toBe(first);
    expect(f.calls).toEqual(["owner.kill", "owner.close"]);
  });

  it("invalidates if a borrowed client close times out", async () => {
    const f = fixture({ clientClose: () => new Promise<void>(() => {}) });
    const owner = await ownerFor(f, { cleanupTimeoutMs: 5 });
    await expect(owner.use(request(owner.binding), async () => "done"))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_CLIENT_CLOSE_FAILED" });
    await expect(owner.use(request(owner.binding, { attemptId: "attempt-2" }), async () => null))
      .rejects.toMatchObject({ code: "OPEN_SANDBOX_ENVIRONMENT_INVALIDATED" });
    await owner.dispose();
    expect(f.calls.slice(-2)).toEqual(["owner.kill", "owner.close"]);
  });
});
