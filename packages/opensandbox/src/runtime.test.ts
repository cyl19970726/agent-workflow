import { describe, expect, it } from "vitest";
import type { Sandbox } from "@alibaba-group/opensandbox";
import { defineAgent, MemoryRunStore, runWorkflow, workflow, type AgentRunRequest } from "@signal-room/workflow";
import { createOpenSandboxAgentRunner, openSandboxAgentConfig, type OpenSandboxProfile,
  withSandboxAttempt } from "./runtime.js";
import { createOpenSandboxWorkspaceTools, type SandboxHandle } from "./tools.js";

const image = `python@sha256:${"a".repeat(64)}`;
const endpoint = { domain: "localhost:8080", protocol: "http" as const };
const profile: OpenSandboxProfile = { image, ttlSeconds: 120, resource: { cpu: "1", memory: "1Gi" },
  tools: { workspaceRoot: "/work", writePrefixes: ["scripts"],
    commands: { analyze: { argv: ["python", "/work/scripts/analyze.py"], timeoutSeconds: 10 } },
    maxReadBytes: 1024, maxWriteBytes: 1024, maxOutputBytes: 1024, maxImageBytes: 1024 } };

function fakeSandbox(options: { killFails?: boolean; commandFails?: boolean } = {}) {
  const calls: string[] = [];
  const modeValues: number[] = [];
  const files = new Map<string, Uint8Array>();
  const sandbox = {
    id: "sandbox-test-1",
    files: {
      async createDirectories(entries: {mode?:number}[]) { calls.push("mkdir"); modeValues.push(entries[0]!.mode!); },
      async writeFiles(entries: {path:string;data:Uint8Array;mode?:number}[]) {
        for (const entry of entries) { files.set(entry.path, entry.data); modeValues.push(entry.mode!); }
      },
      async readBytes(path: string, opts?: {limit?:number}) {
        const bytes = files.get(path); if (!bytes) throw new Error("missing file");
        return opts?.limit === undefined ? bytes : bytes.subarray(0, opts.limit);
      },
      async *readBytesStream(path: string, opts?: {range?:string}) {
        const bytes = files.get(path); if (!bytes) throw new Error("missing file");
        const end = opts?.range ? Number(opts.range.split("-")[1]) : bytes.length - 1;
        yield bytes.subarray(0, end + 1);
      },
    },
    commands: {
      async run(argv: string[]) {
        calls.push(`run:${argv.join(" ")}`);
        if (options.commandFails) throw new Error("stream broke");
        return { complete: { timestamp: 1, executionTimeMs: 1 }, exitCode: 0,
          logs: { stdout: [], stderr: [] } };
      },
    },
    async kill() { calls.push("kill"); if (options.killFails) throw new Error("kill failed"); },
    async close() { calls.push("close"); },
  } as unknown as SandboxHandle;
  return { sandbox, calls, files, modeValues };
}

function request(events: string[], signal = new AbortController().signal): AgentRunRequest<{csv:string}> {
  return { runId: "run-1", stepRunId: "step-1", attemptId: "attempt-1", signal,
    definition: { id: "csv", revision: "1", model: "test", reasoningEffort: "low", promptRevision: "1",
      skillsRevision: "none", permissionsRevision: "1", config: openSandboxAgentConfig(profile, endpoint) },
    input: { csv: "sample" }, async emit(type) { events.push(type); } };
}

describe("OpenSandbox attempt", () => {
  it("rejects a mismatched environment before creating a sandbox", async () => {
    let creates = 0;
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { throw new Error("should not authenticate"); } },
      createSandbox: async () => { creates++; throw new Error("should not create"); } });
    const events: string[] = [];
    const mismatched = request(events);
    mismatched.definition.config!.environmentProfileDigest = "wrong";
    await expect(runner.run(mismatched)).rejects.toThrow("environment profile disagree");
    expect(creates).toBe(0);
  });

  it("rejects invalid tool policy before remote creation", () => {
    let creates = 0;
    const bad = structuredClone(profile);
    bad.tools.writePrefixes = ["../escape"];
    expect(() => createOpenSandboxAgentRunner({ profile: bad, connection: endpoint,
      auth: { async accessToken() { return "unused"; } },
      createSandbox: async () => { creates++; throw new Error("should not create"); } })).toThrow("traversal");
    expect(creates).toBe(0);
  });

  it("combines exact-attempt host and sandbox tools without moving credentials", async () => {
    const { sandbox } = fakeSandbox();
    const seen: string[] = [];
    const runner = createOpenSandboxAgentRunner({ profile, connection: { ...endpoint, apiKey: "host-only-test-key" },
      auth: { async accessToken() { throw new Error("model must not run"); } },
      createSandbox: async () => sandbox as Sandbox,
      hostTools: request => {
        expect(request.attemptId).toBe("attempt-1");
        return [{ name: "business_lookup", description: "Host lookup", parameters: { type: "object", properties: {} },
          async execute() { seen.push("host"); return { ok: true }; } }];
      },
      agentRunnerFactory: tools => ({ async run() {
        expect(tools.map(tool => tool.name)).toContain("read_file");
        const host = tools.find(tool => tool.name === "business_lookup")!;
        await host.execute({}, new AbortController().signal);
        seen.push("sandbox-tools-present");
        return { output: { ok: true } };
      } }),
    });
    await runner.run(request([]));
    expect(seen).toEqual(["host", "sandbox-tools-present"]);
  });

  it("rejects duplicate host tool names before the SDK starts", async () => {
    const { sandbox, calls } = fakeSandbox();
    let ran = false;
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { return "unused"; } }, createSandbox: async () => sandbox as Sandbox,
      hostTools: () => [{ name: "read_file", description: "collision", parameters: {}, async execute() { return null; } }],
      agentRunnerFactory: () => ({ async run() { ran = true; return { output: null }; } }),
    });
    await expect(runner.run(request([]))).rejects.toThrow("Duplicate");
    expect(ran).toBe(false);
    expect(calls.slice(-2)).toEqual(["kill", "close"]);
  });

  it("denies host tools after a remote command outcome becomes unknown", async () => {
    const { sandbox, calls } = fakeSandbox({ commandFails: true });
    let hostCalls = 0;
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { return "unused"; } }, createSandbox: async () => sandbox as Sandbox,
      hostTools: () => [{ name: "business_lookup", description: "host", parameters: {},
        async execute() { hostCalls++; return { ok: true }; } }],
      agentRunnerFactory: tools => ({ async run() {
        await expect(tools.find(tool => tool.name === "exec_allowed")!
          .execute({ name: "analyze" }, new AbortController().signal)).rejects.toThrow("outcome unknown");
        await expect(tools.find(tool => tool.name === "business_lookup")!
          .execute({}, new AbortController().signal)).rejects.toThrow("unknown command outcome");
        return { output: { claimed: "success" } };
      } }),
    });
    await expect(runner.run(request([]))).rejects.toThrow("unknown command outcome");
    expect(hostCalls).toBe(0);
    expect(calls.slice(-2)).toEqual(["kill", "close"]);
  });

  it("runs one attempt, preserves a successful result with explicit cleanup failure", async () => {
    const { sandbox, calls, files, modeValues } = fakeSandbox({ killFails: true });
    const events: string[] = [];
    let created: Parameters<typeof Sandbox.create>[0] | undefined;
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { throw new Error("model must not run"); } },
      createSandbox: async options => { created = options; return sandbox as Sandbox; },
      agentRunnerFactory: tools => ({ async run() {
        const write = tools.find(tool => tool.name === "write_file")!;
        await write.execute({ path: "scripts/analyze.py", content: "print(1)" }, new AbortController().signal);
        const exec = tools.find(tool => tool.name === "exec_allowed")!;
        await exec.execute({ name: "analyze" }, new AbortController().signal);
        files.set("/work/summary.json", Buffer.from('{"total":1}'));
        return { output: { answer: 1 } };
      } }),
      async finish({ sandbox: handle, result }) {
        const bytes = await handle.files.readBytes("/work/summary.json", { limit: 1025 });
        expect(Buffer.from(bytes).toString()).toBe('{"total":1}');
        return result;
      },
    });
    const result = await runner.run(request(events));
    expect(result.output).toEqual({ answer: 1 });
    expect(result.metadata?.sandboxCleanup).toEqual({ remoteKill: "failed", clientClose: "succeeded" });
    expect(calls).toEqual(["mkdir", "run:python /work/scripts/analyze.py", "kill", "close"]);
    expect(modeValues).toEqual([700, 600]);
    expect(events).toContain("sandbox.cleanup_failed");
    expect(created?.metadata).toEqual({ workflowRunId: "run-1", stepRunId: "step-1", attemptId: "attempt-1" });
    expect(created?.networkPolicy).toEqual({ defaultAction: "deny", egress: [] });
  });

  it("latches an unknown command outcome and denies later tools", async () => {
    const { sandbox, calls } = fakeSandbox({ commandFails: true });
    await expect(withSandboxAttempt(sandbox, async gate => {
      const tools = createOpenSandboxWorkspaceTools(sandbox, profile.tools, gate);
      const exec = tools.find(tool => tool.name === "exec_allowed")!;
      const read = tools.find(tool => tool.name === "read_file")!;
      await expect(exec.execute({ name: "analyze" }, new AbortController().signal)).rejects.toThrow("outcome unknown");
      await expect(read.execute({ path: "input.csv" }, new AbortController().signal)).rejects.toThrow("unknown command outcome");
    }, new AbortController().signal)).resolves.toMatchObject({ cleanup: { remoteKill: "succeeded" } });
    expect(calls.filter(item => item.startsWith("run:"))).toHaveLength(1);
  });

  it("kills on abort, closes, and keeps original plus cleanup errors", async () => {
    const controller = new AbortController();
    const { sandbox, calls } = fakeSandbox({ killFails: true });
    const reason = new Error("cancelled");
    await expect(withSandboxAttempt(sandbox, async () => { controller.abort(reason); throw new Error("late work error"); }, controller.signal))
      .rejects.toMatchObject({ errors: [reason, expect.objectContaining({ message: "Sandbox kill failed" })] });
    expect(calls).toEqual(["kill", "close"]);
  });

  it("keeps a non-abort work error when cleanup also fails", async () => {
    const { sandbox } = fakeSandbox({ killFails: true });
    const original = new Error("work failed");
    await expect(withSandboxAttempt(sandbox, async () => { throw original; }, new AbortController().signal))
      .rejects.toMatchObject({ errors: [original, expect.any(Error)], cause: original });
  });

  it("records cleanup after a primary Agent failure", async () => {
    const { sandbox, calls } = fakeSandbox();
    const events: string[] = [];
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { return "unused"; } }, createSandbox: async () => sandbox as Sandbox,
      agentRunnerFactory: () => ({ async run() { throw new Error("agent failed"); } }),
    });
    await expect(runner.run(request(events))).rejects.toThrow("agent failed");
    expect(calls.slice(-2)).toEqual(["kill", "close"]);
    expect(events).toContain("sandbox.stopped");
  });

  it("reuses a host-validated Agent step and retains its published artifact on resume", async () => {
    const { sandbox, files } = fakeSandbox();
    const store = new MemoryRunStore();
    let creations = 0;
    let sdkRuns = 0;
    const agent = defineAgent<{csv:string}, {totals:{A:number;B:number}}>({
      id: "csv", revision: "1", model: "fake", reasoningEffort: "low", promptRevision: "1",
      skillsRevision: "none", permissionsRevision: "sandbox-test-v2",
      config: { ...openSandboxAgentConfig(profile, endpoint), instructions: "test", outputFormat: "json" },
    });
    const definition = workflow<{csv:string}, unknown>("sandbox.csv-replay", { revision: "2" }, async (ctx, input) => {
      const summary = await ctx.agent("summarize", agent, input);
      return ctx.publish("summary", "csv-summary", summary, { revision: "1", validation: "valid", review: "pending" });
    });
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { throw new Error("real model must not run"); } },
      createSandbox: async () => { creations++; return sandbox as Sandbox; },
      agentRunnerFactory: () => ({ async run() {
        sdkRuns++;
        files.set("/work/summary.json", Buffer.from('{"totals":{"A":3,"B":5}}'));
        return { output: { provisional: true }, validation: "pending" };
      } }),
      async finish({ sandbox: handle, result }) {
        const raw = await handle.files.readBytes("/work/summary.json");
        const checked = JSON.parse(Buffer.from(raw).toString()) as {totals:{A:number;B:number}};
        expect(checked.totals).toEqual({ A: 3, B: 5 });
        return { ...result, validation: "valid", output: checked };
      },
    });
    const first = await runWorkflow({ workflow: definition, input: { csv: "sample" }, store, agentRunner: runner });
    expect(first.run.state).toBe("succeeded");
    expect(creations).toBe(1);
    expect(sdkRuns).toBe(1);
    expect(first.output).toMatchObject({ type: "csv-summary" });
    const replayed = await runWorkflow({ workflow: definition, input: { csv: "sample" }, store,
      resumeRunId: first.run.id,
      agentRunner: { async run() { throw new Error("Agent must not re-execute during replay"); } } });
    expect(replayed.run.state).toBe("succeeded");
    expect(replayed.output).toEqual(first.output);
    expect(creations).toBe(1);
    expect(sdkRuns).toBe(1);
    expect((await store.listArtifacts(first.run.id)).length).toBe(1);
  });

  it("does not replace a primary failure when cleanup receipt writing fails", async () => {
    const { sandbox } = fakeSandbox();
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { return "unused"; } }, createSandbox: async () => sandbox as Sandbox,
      agentRunnerFactory: () => ({ async run() { throw new Error("original failure"); } }),
    });
    const req = request([]);
    req.emit = async type => { if (type === "sandbox.stopped") throw new Error("event sink down"); };
    await expect(runner.run(req)).rejects.toThrow("original failure");
  });

  it("bounds kill and close even when neither promise settles", async () => {
    const never = () => new Promise<void>(() => {});
    const sandbox = { kill: never, close: never } as Pick<Sandbox, "kill" | "close">;
    const completed = await withSandboxAttempt(sandbox, async () => 7, new AbortController().signal, 5);
    expect(completed.result).toBe(7);
    expect(completed.cleanup).toEqual({ remoteKill: "failed", clientClose: "failed" });
  });

  it("aborts a non-cooperative work callback and ignores its late result", async () => {
    const controller = new AbortController();
    const { sandbox, calls } = fakeSandbox();
    let finishLate!: (value: number) => void;
    const neverUntilLate = new Promise<number>(resolve => { finishLate = resolve; });
    const running = withSandboxAttempt(sandbox, async () => neverUntilLate, controller.signal, 10);
    controller.abort(new Error("cancelled"));
    await expect(running).rejects.toThrow("cancelled");
    finishLate(42);
    expect(calls).toEqual(["kill", "close"]);
  });

  it("passes cancellation into create and reports unknown outcome safely", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { return "unused"; } },
      createSandbox: async options => {
        expect(options.signal).toBe(controller.signal);
        controller.abort(new Error("stop"));
        throw new Error("sensitive response body should not escape");
      },
    });
    await expect(runner.run(request(events, controller.signal))).rejects.toMatchObject({
      code: "OPEN_SANDBOX_CREATE_OUTCOME_UNKNOWN", attemptId: "attempt-1",
    });
    expect(events).toContain("sandbox.create_outcome_unknown");
  });

  it("keeps typed create-unknown error when its trace receipt fails", async () => {
    const runner = createOpenSandboxAgentRunner({ profile, connection: endpoint,
      auth: { async accessToken() { return "unused"; } },
      createSandbox: async () => { throw new Error("sensitive provider response"); },
    });
    const req = request([]);
    req.emit = async type => { if (type === "sandbox.create_outcome_unknown") throw new Error("sink failed"); };
    await expect(runner.run(req)).rejects.toMatchObject({ code: "OPEN_SANDBOX_CREATE_OUTCOME_UNKNOWN" });
  });
});
