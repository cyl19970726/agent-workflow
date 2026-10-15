import { describe, expect, it } from "vitest";
import { defineAgent, MemoryRunStore, runWorkflow, workflow, type AgentRunRequest } from "@signal-room/workflow";
import { containerAgentConfig, createContainerAgentRunner, type ContainerAgentPolicy } from "./container.js";
import type { BorrowedSandboxHandle, OpenSandboxEnvironmentOwner } from "./environment.js";
import type { ContainerAgentJob } from "./container-protocol.js";

const policy: ContainerAgentPolicy = { runtime: "codex-cli",
  limits: { timeoutMs: 1000, maxTurns: 4, maxToolCalls: 4, maxOutputBytes: 4096 } };
const digest = "a".repeat(64);
const config = containerAgentConfig(digest, policy);
const definition = defineAgent({ id: "first", revision: "1", model: "test-model", reasoningEffort: "low",
  promptRevision: "1", skillsRevision: "none", permissionsRevision: "1", config });

function fixture(options: { running?: boolean; launchUnknown?: boolean; invalidResult?: boolean;
  exitCode?: number; tooManyLogs?: boolean; interruptUnknown?: boolean;
  workerEvents?: Array<{ eventType: string; data: Record<string, unknown> }> } = {}) {
  const calls: string[] = [], events: Array<{type:string;data:unknown}> = [];
  const files = new Map<string, Uint8Array>();
  let job: ContainerAgentJob | undefined;
  let running = options.running ?? false;
  let invalid = false;
  const sandbox = { id: "shared-test", files: {
    async createDirectories() {},
    async writeFiles(entries: Array<{path:string;data:Uint8Array}>) { for (const e of entries) files.set(e.path, e.data); },
    async *readBytesStream(path: string) { const bytes = files.get(path); if (!bytes) throw new Error("missing file"); yield bytes; },
  }, commands: {
    async run(argv: string[]) {
      calls.push("run");
      expect(argv.slice(0,2)).toEqual(["node", "/opt/workflow/container-worker.js"]);
      if (options.launchUnknown) throw new Error("private SDK error secret");
      job = JSON.parse(Buffer.from(files.get(argv[2]!)!).toString());
      if (job!.definition.id === "second") {
        if (Buffer.from(files.get("/work/shared/first.txt") ?? []).toString() !== "actual first output") throw new Error("Missing shared file");
      } else files.set("/work/shared/first.txt", Buffer.from("actual first output"));
      files.set(argv[3]!, Buffer.from(JSON.stringify({ protocolVersion: 1, runId: job!.runId,
        stepRunId: job!.stepRunId, attemptId: options.invalidResult ? "wrong" : job!.attemptId,
        status: "succeeded", output: { readShared: true }, metadata: { runtime: job!.runtime } })));
      return { id: "command-1" };
    },
    async getCommandStatus() { return { running, exitCode: options.exitCode ?? 0 }; },
    async getBackgroundCommandLogs(_id: string, cursor: number) {
      const line = (options.workerEvents ?? [{eventType:"worker.started",data:{runtime:job?.runtime}}])
        .map(event => JSON.stringify({type:"event",...event})+"\n").join("");
      return options.tooManyLogs ? { content: "x".repeat(5000), cursor: 5000 } :
        { content: cursor ? "" : line, cursor: line.split("\n").length-1 };
    },
    async interrupt() { calls.push("interrupt"); if (options.interruptUnknown) throw new Error("unknown"); running = false; },
  } } as unknown as BorrowedSandboxHandle;
  const environment: OpenSandboxEnvironmentOwner = {
    binding: { sandboxId: sandbox.id, profileDigest: digest },
    async use(request, callback) { if (invalid) throw new Error("invalid environment"); calls.push(`use:${request.attemptId}`); return callback(sandbox); },
    invalidate() { invalid = true; calls.push("invalidate"); },
    async dispose() { calls.push("dispose"); return { remoteKill: "succeeded", clientClose: "succeeded" }; },
  };
  function request(signal = new AbortController().signal): AgentRunRequest<unknown> {
    return { runId:"r1",stepRunId:"s1",attemptId:"a1",definition,input:{source:"frozen"},signal,
      async emit(type, data) { events.push({type,data}); } };
  }
  return {environment,calls,files,events,request};
}

describe("container-resident AgentRunner", () => {
  it("runs only the image worker, correlates result, and requires independent validation", async () => {
    const f = fixture();
    const result = await createContainerAgentRunner({ environment:f.environment, policy }).run(f.request());
    expect(result).toMatchObject({ output:{readShared:true},validation:"pending" });
    expect(f.calls).toEqual(["use:a1","run"]);
    expect(f.events.map(e=>e.type)).toContain("sandbox.agent_completed");
  });
  it("rejects a mismatched definition before any environment operation", async () => {
    const f=fixture(), request=f.request();
    request.definition={...definition,config:{...config,containerAgentPolicyDigest:"wrong"}};
    await expect(createContainerAgentRunner({environment:f.environment,policy}).run(request)).rejects.toThrow("disagree");
    expect(f.calls).toEqual([]);
  });
  it("rejects oversized job data before borrowing the remote environment", async () => {
    const f=fixture(), request=f.request();
    request.input={text:"x".repeat(256*1024)};
    await expect(createContainerAgentRunner({environment:f.environment,policy}).run(request)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("projects safe usage into existing accounting events without inventing missing counts", async () => {
    for (const runtime of ["codex-cli", "agents-sdk"] as const) {
      const f = fixture({workerEvents: runtime === "codex-cli" ? [
        {eventType:"codex.thread.started",data:{threadId:"real-thread"}},
        {eventType:"codex.turn.completed",data:{inputTokens:21,outputTokens:7,totalTokens:28}},
      ] : [
        {eventType:"siwc.request",data:{}},
        {eventType:"siwc.response",data:{responseId:"real-response",inputTokens:21,outputTokens:7,totalTokens:28}},
      ]});
      const actualPolicy = {...policy,runtime}, request = f.request();
      request.definition = {...definition,config:containerAgentConfig(digest,actualPolicy)};
      await createContainerAgentRunner({environment:f.environment,policy:actualPolicy}).run(request);
      const receipt = f.events.find(event => event.type === (runtime === "codex-cli" ? "agent.usage" : "siwc.response"));
      expect(receipt?.data).toEqual({sandboxId:"shared-test",commandId:"command-1",
        ...(runtime === "codex-cli" ? {threadId:"real-thread"} : {responseId:"real-response"}),
        usage:{inputTokens:21,outputTokens:7,totalTokens:28}});
      if (runtime === "agents-sdk") expect(f.events.filter(event=>event.type==="siwc.request")).toHaveLength(1);
    }
  });
  it("fingerprints runtime and tool limits without relying on object property order", () => {
    expect(containerAgentConfig(digest,{...policy,runtime:"agents-sdk"})).not.toEqual(config);
    expect(containerAgentConfig(digest,{limits:{...policy.limits,maxToolCalls:5},runtime:"codex-cli"})).not.toEqual(config);
    expect(containerAgentConfig(digest,{limits:policy.limits,runtime:policy.runtime})).toEqual(config);
  });
  it("rejects uncorrelated or failed results and poisons shared state", async () => {
    for (const option of [{invalidResult:true},{exitCode:1}]) {
      const f=fixture(option);
      await expect(createContainerAgentRunner({environment:f.environment,policy}).run(f.request())).rejects.toThrow();
      expect(f.calls).toContain("invalidate");
      expect(f.events.some(e=>e.type==="sandbox.agent_completed")).toBe(false);
    }
  });
  it("deletes through the owner if command creation has an unknown outcome", async () => {
    const f=fixture({launchUnknown:true});
    await expect(createContainerAgentRunner({environment:f.environment,policy}).run(f.request())).rejects.toThrow("Container operation failed");
    expect(f.calls).toContain("dispose");
    expect(JSON.stringify(f.events)).not.toContain("private SDK error secret");
  });
  it("interrupts an actual started command when cancellation arrives", async () => {
    const f=fixture({running:true}), controller=new AbortController();
    const request=f.request(controller.signal), emit=request.emit;
    request.emit=async(type,data)=>{ await emit(type,data); if(type==="sandbox.command_started") controller.abort(); };
    await expect(createContainerAgentRunner({environment:f.environment,policy,pollIntervalMs:1}).run(request)).rejects.toThrow();
    expect(f.calls).toContain("interrupt");
    expect(f.events.find(e=>e.type==="sandbox.agent_failed")?.data).toMatchObject({processStopped:true,aborted:true});
  });
  it("falls back to owner deletion when interrupted command stop is unknown", async () => {
    const f=fixture({running:true,interruptUnknown:true}), controller=new AbortController();
    const request=f.request(controller.signal), emit=request.emit;
    request.emit=async(type,data)=>{await emit(type,data);if(type==="sandbox.command_started")controller.abort();};
    await expect(createContainerAgentRunner({environment:f.environment,policy}).run(request)).rejects.toThrow();
    expect(f.calls).toContain("dispose");
  });
  it("bounds untrusted event output and never accepts a result after overflow", async () => {
    const f=fixture({tooManyLogs:true,running:true});
    await expect(createContainerAgentRunner({environment:f.environment,policy}).run(f.request())).rejects.toThrow("limit");
    expect(f.calls).toContain("interrupt");
    expect(f.events.some(e=>e.type==="sandbox.agent_completed")).toBe(false);
  });
  it("bounds a hanging prepare callback before starting any remote process", async () => {
    const f=fixture();
    await expect(createContainerAgentRunner({environment:f.environment,policy,operationTimeoutMs:10,
      prepare:()=>new Promise(()=>{})}).run(f.request())).rejects.toThrow("unknown");
    expect(f.calls).not.toContain("run");
    expect(f.calls).toContain("invalidate");
  });
  it("persists independently checked outputs for two shared nodes and replays without execution", async () => {
    const f=fixture(), store=new MemoryRunStore();
    const second=defineAgent({...definition,id:"second"});
    const flow=workflow("shared",{revision:"1"},async ctx=>{
      const first=await ctx.agent("first",definition,{source:"input"});
      const result=await ctx.agent("second",second,{first});
      return ctx.publish("result","shared-result",result,{revision:"1",validation:"valid",review:"pending"});
    });
    const runner=createContainerAgentRunner({environment:f.environment,policy,async finish({result,sandbox,request}){
      const bytes=[];
      for await(const chunk of sandbox.files.readBytesStream("/work/shared/first.txt"))bytes.push(Buffer.from(chunk));
      request.signal.throwIfAborted();
      expect(Buffer.concat(bytes).toString()).toBe("actual first output");
      return {...result,validation:"valid"};
    }});
    const initial=await runWorkflow({workflow:flow,input:null,store,agentRunner:runner});
    expect(initial.run.state).toBe("succeeded");
    expect(f.calls.filter(c=>c==="run")).toHaveLength(2);
    const replay=await runWorkflow({workflow:flow,input:null,store,resumeRunId:initial.run.id,
      agentRunner:{async run(){throw new Error("must replay");}}});
    expect(replay.run.state).toBe("succeeded");
    expect(replay.output).toEqual(initial.output);
  });
});
