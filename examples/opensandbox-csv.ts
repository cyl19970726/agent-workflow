/**
 * Legacy opt-in CSV example: Agents SDK/model loop stays on the host; Python tools run in OpenSandbox.
 * Requires OpenSandbox, OPEN_SANDBOX_IMAGE_DIGEST with `python`, PostgreSQL and SIWC login.
 * For complete in-container nodes using OPEN_SANDBOX_AGENT_IMAGE, start with opensandbox-shared.ts.
 * Setup and the distinction between examples: ../docs/opensandbox.md
 */
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { defineAgent, runWorkflow, workflow } from "@signal-room/workflow";
import { migratePostgresWorkflowStore, PostgresWorkflowRunStore } from "@signal-room/workflow-postgres";
import { SiwcAuth } from "@signal-room/workflow-agent-sdk";
import { createOpenSandboxAgentRunner, openSandboxAgentConfig, readBoundedSandboxBytes,
  type OpenSandboxProfile } from "@signal-room/workflow-opensandbox";

const CSV = "category,amount\nA,1\nB,2\nA,2\nB,3\n";
const input = { csv: CSV };
type Summary = { totals: { A: number; B: number }; sha256: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before the opt-in live example`);
  return value;
}

export async function runOpenSandboxCsvExample() {
  const connection = { domain: required("OPEN_SANDBOX_DOMAIN"), protocol: (process.env.OPEN_SANDBOX_PROTOCOL ?? "http") as "http" | "https",
    apiKey: process.env.OPEN_SANDBOX_API_KEY };
  if (connection.protocol !== "http" && connection.protocol !== "https") throw new Error("Invalid OPEN_SANDBOX_PROTOCOL");
  const profile: OpenSandboxProfile = {
    image: required("OPEN_SANDBOX_IMAGE_DIGEST"), ttlSeconds: 180,
    resource: { cpu: "1", memory: "1Gi" },
    tools: { workspaceRoot: "/work", writePrefixes: ["scripts"],
      commands: { analyze: { argv: ["python", "/work/scripts/analyze.py"], timeoutSeconds: 30 } },
      maxReadBytes: 16 * 1024, maxWriteBytes: 16 * 1024,
      maxOutputBytes: 16 * 1024, maxImageBytes: 1024 * 1024 },
  };
  const connectionString = required("WORKFLOW_DATABASE_URL");
  const workspaceId = `opensandbox-csv-${randomUUID()}`;
  let pool = new Pool({ connectionString, max: 4 });
  try {
    await migratePostgresWorkflowStore(pool);
    let store = new PostgresWorkflowRunStore(pool, { workspaceId });
    const agent = defineAgent<typeof input, Summary>({
      id: "csv-summary", revision: "1", model: required("SIWC_MODEL"), reasoningEffort: "low",
      promptRevision: "2", skillsRevision: "none", permissionsRevision: "sandbox-csv-v2",
      config: { instructions: "Use read_file to inspect input.csv. Write Python code to scripts/analyze.py that sums amount by category and writes a JSON object with a totals map to /work/summary.json. Run the fixed analyze command. Read summary.json and reply with a JSON object confirming completion.",
        outputFormat: "json", ...openSandboxAgentConfig(profile, connection) },
    });
    const definition = workflow<typeof input, unknown>("sandbox.csv", { revision: "2" }, async (ctx, frozen) => {
      const summary = await ctx.agent("summarize", agent, frozen);
      return ctx.publish("summary", "csv-summary", summary, { revision: "1", validation: "valid", review: "pending" });
    });
    const agentRunner = createOpenSandboxAgentRunner({ connection, profile, auth: new SiwcAuth(),
      siwc: { enforceJsonObject: true, maxTurns: 8, maxToolCalls: 8, timeoutMs: 120_000 },
      async prepare({ sandbox }) {
        await sandbox.files.writeFiles([{ path: "/work/input.csv", data: Buffer.from(CSV), mode: 600 }]);
      },
      async finish({ sandbox, result, request }) {
        // The live bytes are checked before remote cleanup. PG artifact publication is ctx.publish above.
        const bytes = await readBoundedSandboxBytes(sandbox, "/work/summary.json", 4096, request.signal);
        if (!bytes.length) throw new Error("Summary size invalid");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Summary shape invalid");
        const totals = (value as {totals?:Record<string,unknown>}).totals;
        if (!totals || Object.keys(totals).sort().join() !== "A,B" || totals.A !== 3 || totals.B !== 5)
          throw new Error("Summary totals do not match the staged CSV");
        return { ...result, validation: "valid", output: { totals: { A: 3, B: 5 }, sha256: createHash("sha256").update(bytes).digest("hex") } };
      },
    });
    const outcome = await runWorkflow({ workflow: definition, input, store, agentRunner });
    if (outcome.run.state !== "succeeded" || !outcome.output || typeof outcome.output !== "object" ||
        !("id" in outcome.output) || typeof outcome.output.id !== "string")
      throw new Error(`CSV workflow did not succeed (${outcome.run.state})`);
    const artifactId = outcome.output.id;
    const events = await store.listEvents(outcome.run.id);
    const stopped = events.find(event => event.type === "sandbox.stopped" || event.type === "sandbox.cleanup_failed");
    const cleanup = stopped?.data as {remoteKill?:string;clientClose?:string} | undefined;
    await pool.end();
    pool = new Pool({ connectionString, max: 4 });
    store = new PostgresWorkflowRunStore(pool, { workspaceId });
    const saved = await store.getArtifactPayload(artifactId) as Summary;
    assert.deepEqual(saved.totals, { A: 3, B: 5 });
    const replayed = await runWorkflow({ workflow: definition, input, store, resumeRunId: outcome.run.id,
      agentRunner: { async run() { throw new Error("Replay unexpectedly executed the Agent"); } } });
    assert.equal(replayed.run.state, "succeeded");
    assert.deepEqual(replayed.output, outcome.output);
    return { state: outcome.run.state, runId: outcome.run.id, artifactId,
      modelRequests: events.filter(event => event.type === "siwc.request").length,
      toolCalls: events.filter(event => event.type === "siwc.tool_call").length,
      cleanup: { remoteKill: cleanup?.remoteKill ?? "unrecorded", clientClose: cleanup?.clientClose ?? "unrecorded" },
      payloadReadAfterReconnect: true, replayedWithoutExecution: true };
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOpenSandboxCsvExample().then(result => console.log(JSON.stringify(result, null, 2)), error => {
    console.error(error instanceof Error ? error.message : "OpenSandbox example failed"); process.exitCode = 1;
  });
}
