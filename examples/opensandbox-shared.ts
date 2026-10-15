/** Opt-in: real Codex + Agents SDK inside one sandbox, host validation, PostgreSQL and replay. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { defineAgent, runWorkflow, workflow, type AgentRunner } from "@signal-room/workflow";
import { PostgresWorkflowRunStore, migratePostgresWorkflowStore } from "@signal-room/workflow-postgres";
import { SiwcAuth } from "@signal-room/workflow-agent-sdk";
import { createOpenSandboxEnvironment, containerAgentConfig, createContainerAgentRunner, readBoundedSandboxBytes,
  type ContainerAgentPolicy, type OpenSandboxEnvironmentProfile, type SandboxCleanupStatus } from "@signal-room/workflow-opensandbox";

const CSV = "category,amount\r\nA,1.25\r\nB,2.5\r\nA,2.75\r\nB,-0.5\r\n";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for the opt-in shared-container example`);
  return value;
}

export async function runOpenSandboxSharedExample() {
  const connectionString = required("WORKFLOW_DATABASE_URL");
  const model = required("SIWC_MODEL");
  const protocol = process.env.OPEN_SANDBOX_PROTOCOL ?? "http";
  if (protocol !== "http" && protocol !== "https") throw new Error("Unsupported sandbox protocol");
  const connection = { domain: required("OPEN_SANDBOX_DOMAIN"), protocol: protocol as "http" | "https", apiKey: required("OPEN_SANDBOX_API_KEY") };
  const profile: OpenSandboxEnvironmentProfile = { image: required("OPEN_SANDBOX_AGENT_IMAGE"), ttlSeconds: 360,
    resource: { cpu: "1", memory: "1Gi" },
    networkPolicy: { egress: [{ action: "allow", target: "chatgpt.com" }, { action: "allow", target: "api.openai.com" }] },
    credentialBindings: [
      { name: "codex", match: { schemes: ["https"], hosts: ["chatgpt.com"], ports: [443], methods: ["POST"], paths: ["/backend-api/codex/responses"] },
        auth: { type: "customHeaders", headers: [{ name: "Authorization", credential: "codex-token" }, { name: "ChatGPT-Account-ID", credential: "codex-account" }] } },
      { name: "sdk", match: { schemes: ["https"], hosts: ["api.openai.com"], ports: [443], methods: ["POST"], paths: ["/v1/responses"] },
        auth: { type: "bearer", credential: "sdk-token" } },
    ] };
  const ownerEvents: Array<{type:string;data:unknown}> = [];
  const environment = await createOpenSandboxEnvironment({ connection, profile,
    async credentials() {
      // Existing explicitly authorized logins stay in trusted host memory, never in job files or images.
      const codex = JSON.parse(await readFile(process.env.CODEX_AUTH_FILE ?? join(homedir(), ".codex/auth.json"), "utf8"));
      if (codex.auth_mode !== "chatgpt" || !codex.tokens?.access_token || !codex.tokens?.account_id)
        throw new Error("Existing Codex ChatGPT login required");
      const sdk = await new SiwcAuth().accessToken();
      return [{ name: "codex-token", source: { type: "inline", value: `Bearer ${codex.tokens.access_token}` } },
        { name: "codex-account", source: { type: "inline", value: codex.tokens.account_id } },
        { name: "sdk-token", source: { type: "inline", value: sdk } }];
    }, async emit(type, data) { ownerEvents.push({type,data}); } });
  let pool = new Pool({connectionString,max:4});
  const workspaceId = `sandbox-shared-${randomUUID()}`;
  let cleanup: SandboxCleanupStatus | undefined;
  let runId: string | undefined;
  let store = new PostgresWorkflowRunStore(pool, {workspaceId});
  try {
    await migratePostgresWorkflowStore(pool);
    const limits = { timeoutMs: 120_000, maxTurns: 8, maxToolCalls: 8, maxOutputBytes: 256 * 1024 };
    const codexPolicy: ContainerAgentPolicy = { runtime:"codex-cli", limits };
    const sdkPolicy: ContainerAgentPolicy = { runtime:"agents-sdk", limits,
      tools: { writePaths:["review.json"], commands:{} } };
    const common = {revision:"1",model,reasoningEffort:"low",promptRevision:"1",skillsRevision:"none",permissionsRevision:"container-v1"};
    const author = defineAgent<typeof input, {totals:{A:number;B:number};sha256:string}>({id:"author",...common,
      config:{...containerAgentConfig(environment.binding.profileDigest,codexPolicy),outputFormat:"json",
        instructions:"Use the container shell and python3 to inspect input.csv, write analyze.py that sums amount per category with decimal-safe arithmetic, then execute it to save summary.json with a totals object of JSON numbers. Read the actual saved JSON before returning a short JSON completion object. Work only in /work/shared. Do not invent inputs or merely describe steps."}});
    const reviewer = defineAgent<{summarySha256:string}, {categoryCount:number;grandTotal:number;sha256:string}>({id:"reviewer",...common,
      config:{...containerAgentConfig(environment.binding.profileDigest,sdkPolicy),outputFormat:"json",
        instructions:"Read the real summary.json in the shared workspace using read_file (root workspace, path summary.json). Count its categories and sum the totals. Write review.json with numeric categoryCount and grandTotal using write_file, then read it back. Do not change summary.json. Return a short JSON completion object. A prior node made the file; do not assume its contents."}});
    const input = {csv:CSV};
    const flow=workflow<typeof input,unknown>("sandbox.shared-agents",{revision:"1"},async(ctx,frozen)=>{
      const summary=await ctx.agent("author",author,frozen);
      const asset=await ctx.publish("summary","csv-summary",summary,{revision:"1",validation:"valid",review:"pending"});
      const review=await ctx.agent("reviewer",reviewer,{summarySha256:summary.sha256});
      return ctx.publish("review","csv-review",review,{revision:"1",validation:"valid",review:"pending",
        dependsOn:[{artifactId:asset.id,revision:asset.revision,sha256:asset.sha256}]});
    });
    const codexRunner=createContainerAgentRunner({environment,policy:codexPolicy,
      async prepare({sandbox,request,workspaceRoot}) {
        const frozen=request.input as typeof input;
        await sandbox.files.writeFiles([{path:`${workspaceRoot}/input.csv`,data:Buffer.from(frozen.csv),mode:600}]);
      },async finish({sandbox,request,workspaceRoot,result}){
        const bytes=await readBoundedSandboxBytes(sandbox,`${workspaceRoot}/summary.json`,4096,request.signal);
        const actual=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes));
        // Host-only oracle, absent from both model prompts.
        assert.deepEqual(actual,{totals:{A:4,B:2}});
        return {...result,validation:"valid",output:{...actual,sha256:sha256(bytes)}};
      }});
    const sdkRunner=createContainerAgentRunner({environment,policy:sdkPolicy,
      async finish({sandbox,request,workspaceRoot,result}){
        const source=await readBoundedSandboxBytes(sandbox,`${workspaceRoot}/summary.json`,4096,request.signal);
        assert.equal(sha256(source),(request.input as {summarySha256:string}).summarySha256);
        const bytes=await readBoundedSandboxBytes(sandbox,`${workspaceRoot}/review.json`,4096,request.signal);
        const actual=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes));
        assert.deepEqual(actual,{categoryCount:2,grandTotal:6});
        return {...result,validation:"valid",output:{...actual,sha256:sha256(bytes)}};
      }});
    const runner:AgentRunner={run:request=>request.definition.id==="author"?codexRunner.run(request):sdkRunner.run(request)};
    const outcome=await runWorkflow({workflow:flow,input,store,agentRunner:runner,
      metadata:{openSandboxEnvironment:environment.binding}});
    runId=outcome.run.id;
    assert.equal(outcome.run.state,"succeeded",`Workflow did not succeed; inspect run ${runId}`);
    const artifact=outcome.output as {id:string};
    const events=await store.listEvents(runId);
    const connected=events.filter(e=>e.type==="opensandbox.environment.connected");
    assert.equal(connected.length,2);
    assert.ok(connected.every(e=>(e.data as {sandboxId:string}).sandboxId===environment.binding.sandboxId));
    assert.ok(events.some(e=>e.type==="sandbox.agent_event" &&
      (e.data as {eventType?:string;data?:{name?:string}}).eventType==="siwc.tool_call" &&
      (e.data as {data?:{name?:string}}).data?.name==="read_file"));
    cleanup=await environment.dispose();
    assert.equal(cleanup.remoteKill,"succeeded");
    assert.equal(cleanup.clientClose,"succeeded");
    await store.appendEvent({runId,type:"opensandbox.environment.cleanup",data:{...environment.binding,...cleanup}});
    await pool.end();
    pool=new Pool({connectionString,max:4});
    store=new PostgresWorkflowRunStore(pool,{workspaceId});
    const saved=await store.getArtifactPayload(artifact.id) as {categoryCount:number;grandTotal:number};
    assert.equal(saved.categoryCount,2);assert.equal(saved.grandTotal,6);
    const replay=await runWorkflow({workflow:flow,input,store,resumeRunId:runId,
      agentRunner:{async run(){throw new Error("Completed replay must not launch an agent or recreate an environment");}}});
    assert.equal(replay.run.state,"succeeded");assert.deepEqual(replay.output,outcome.output);
    return {state:"succeeded",runId,workspaceId,sandboxId:environment.binding.sandboxId,
      runtimes:["codex-cli","agents-sdk"],sharedNodes:2,artifactId:artifact.id,cleanup,
      payloadReadAfterReconnect:true,replayedWithoutExecution:true,ownerEvents};
  } finally {
    cleanup??=await environment.dispose();
    if(runId)await store.appendEvent({runId,type:"opensandbox.environment.final_cleanup",data:{...environment.binding,...cleanup}}).catch(()=>{});
    await pool.end();
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  runOpenSandboxSharedExample().then(result=>console.log(JSON.stringify(result,null,2)),error=>{
    console.error("Shared-container example failed; inspect the private run trace and environment cleanup receipt.");process.exitCode=1;
    if(error && typeof error.code==="string" && /^[A-Z_]+$/.test(error.code)) console.error(error.code);
  });
}
