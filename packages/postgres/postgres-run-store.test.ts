import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactPayloadSha256, runWorkflow } from "@signal-room/workflow";
import type { ArtifactDraft, WorkflowContext } from "@signal-room/workflow";
import { migratePostgresWorkflowStore, PostgresWorkflowRunStore } from "./postgres-run-store.js";

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let pool: Pool;
const workspace = () => `pg-test-${randomUUID()}`;
const makeStore = (id = workspace()) => new PostgresWorkflowRunStore(pool, { workspaceId: id });
async function producer(store: PostgresWorkflowRunStore) {
  const run = await store.createRun({ workflowId: "post", workflowRevision: "1", inputFingerprint: "x", state: "running" });
  const step = await store.createStep({ runId: run.id, key: "publish", kind: "publish", workflowId: "post",
    workflowRevision: "1", inputFingerprint: "x", configFingerprint: "x", state: "running", validation: "pending" });
  const attempt = await store.createAttempt({ runId: run.id, stepRunId: step.id, state: "running" });
  return { run, step, attempt };
}
async function draft(runId: string, stepRunId: string, attemptId: string, payload: unknown): Promise<ArtifactDraft> {
  return { type: "report", schemaVersion: "1", revision: "1", sha256: await artifactPayloadSha256(payload),
    uri: "artifact://test", payload, producedBy: { workflowRunId: runId, stepRunId, attemptId },
    dependsOn: [], validation: "valid", review: "pending" };
}

suite("PostgreSQL workflow ledger", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 12 });
    await Promise.all([migratePostgresWorkflowStore(pool), migratePostgresWorkflowStore(pool)]);
  });
  afterAll(async () => { await pool?.end(); });

  it("enforces trusted workspace isolation and tenant scoped relations", async () => {
    expect(() => new PostgresWorkflowRunStore(pool, { workspaceId: "" })).toThrow("workspaceId");
    const a = makeStore();
    const b = makeStore();
    const { run, step, attempt } = await producer(a);
    expect(await b.getRun(run.id)).toBeUndefined();
    expect(await b.listSteps(run.id)).toEqual([]);
    expect(await b.listAttempts(step.id)).toEqual([]);
    const { id: _stepId, ...stepInput } = step;
    await expect(b.createStep(stepInput)).rejects.toThrow();
    await expect(b.appendEvent({ runId: run.id, type: "wrong.workspace" })).rejects.toThrow("not found");
    await expect(b.createAttempt({ runId: run.id, stepRunId: step.id, state: "running" })).rejects.toThrow();
    await expect(b.publishArtifact(await draft(run.id, step.id, attempt.id, { x: 1 }))).rejects.toThrow();
    await expect(b.createRun({ workflowId: "child", workflowRevision: "1", inputFingerprint: "x",
      state: "running", parentRunId: run.id, parentStepRunId: step.id })).rejects.toThrow();
    const foreignArtifact = await a.publishArtifact(await draft(run.id, step.id, attempt.id, { foreign: true }));
    const local = await producer(b);
    const localDraft = await draft(local.run.id, local.step.id, local.attempt.id, { local: true });
    localDraft.dependsOn = [{ artifactId: foreignArtifact.id, revision: foreignArtifact.revision, sha256: foreignArtifact.sha256 }];
    await expect(b.publishArtifact(localDraft)).rejects.toThrow("dependency mismatch");
  });

  it("allocates concurrent event sequences and rejects foreign step or attempt IDs", async () => {
    const store = makeStore();
    const { run, step, attempt } = await producer(store);
    const events = await Promise.all(Array.from({ length: 40 }, () =>
      store.appendEvent({ runId: run.id, stepRunId: step.id, attemptId: attempt.id, type: "progress" })));
    expect(events.map((event) => event.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect((await store.listEvents(run.id, 38)).map((event) => event.seq)).toEqual([39, 40]);
    await expect(store.appendEvent({ runId: run.id, stepRunId: "foreign", type: "invalid" })).rejects.toThrow();
    expect((await store.appendEvent({ runId: run.id, type: "next" })).seq).toBe(41);
  });

  it("does not repeat migration DDL while a run event write holds its table lock", async () => {
    const workspaceId = workspace();
    const store = makeStore(workspaceId);
    const { run } = await producer(store);
    const writer = await pool.connect();
    const migrator = new Pool({ connectionString: url!, options: "-c lock_timeout=750ms" });
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE aw_runs SET document=document WHERE workspace_id=$1 AND id=$2", [workspaceId, run.id]);
      await migratePostgresWorkflowStore(migrator);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await migrator.end();
    }
  });

  it("returns every event after a cursor beyond the former 1000-event cap", async () => {
    const store = makeStore();
    const { run } = await producer(store);
    await Promise.all(Array.from({ length: 1002 }, () => store.appendEvent({ runId: run.id, type: "progress" })));
    const events = await store.listEvents(run.id);
    expect(events).toHaveLength(1002);
    expect(events.at(-1)?.seq).toBe(1002);
    expect((await store.listEvents(run.id, 1000)).map((event) => event.seq)).toEqual([1001, 1002]);
  });

  it("validates dependencies and verifies stored payload integrity", async () => {
    const id = workspace();
    const store = makeStore(id);
    const { run, step, attempt } = await producer(store);
    const one = await store.publishArtifact(await draft(run.id, step.id, attempt.id, { value: "one" }));
    const twoDraft = await draft(run.id, step.id, attempt.id, { value: "two" });
    twoDraft.dependsOn = [{ artifactId: one.id, revision: one.revision, sha256: one.sha256 }];
    const two = await store.publishArtifact(twoDraft);
    expect(await store.getArtifactPayload(two.id)).toEqual({ value: "two" });
    expect(await store.listArtifacts(run.id)).toHaveLength(2);
    await expect(store.publishArtifact({ ...twoDraft, sha256: "0".repeat(64) })).rejects.toThrow("SHA-256");
    await expect(store.publishArtifact({ ...twoDraft, dependsOn: [{ artifactId: one.id, revision: "wrong", sha256: one.sha256 }] }))
      .rejects.toThrow("dependency mismatch");
    await pool.query("UPDATE aw_artifacts SET payload=$3::jsonb WHERE workspace_id=$1 AND id=$2",
      [id, one.id, JSON.stringify({ value: "tampered" })]);
    await expect(store.getArtifactPayload(one.id)).rejects.toThrow("integrity check failed");
  });

  it("commits output, artifact, events, and receipt atomically with replay safe idempotency", async () => {
    const store = makeStore();
    const { run, step, attempt } = await producer(store);
    const artifact = await draft(run.id, step.id, attempt.id, { published: true });
    const request = { stepRunId: step.id, attemptId: attempt.id, idempotencyKey: "publish-1",
      state: "succeeded" as const, validation: "valid" as const, artifact,
      events: [{ runId: run.id, stepRunId: step.id, attemptId: attempt.id, type: "step.completed" }] };
    await expect(store.commitStepResult({ ...request,
      events: [{ runId: run.id, attemptId: attempt.id, type: "step.completed" }] })).rejects.toThrow("provenance mismatch");
    await expect(store.commitStepResult({ ...request,
      events: [{ runId: run.id, stepRunId: step.id, type: "step.completed" }] })).rejects.toThrow("provenance mismatch");
    await expect(store.commitStepResult({ ...request,
      events: [{ runId: run.id, stepRunId: "invalid", type: "step.completed" }] })).rejects.toThrow();
    expect(await store.listArtifacts(run.id)).toHaveLength(0);
    expect(await store.listEvents(run.id)).toHaveLength(0);
    expect((await store.listSteps(run.id))[0]?.state).toBe("running");
    const receipt = await store.commitStepResult(request);
    expect(receipt.artifact?.id).toBe((receipt.output as { id: string }).id);
    expect((await store.listEvents(run.id)).map((event) => event.type)).toEqual(["artifact.published", "step.completed"]);
    expect(await store.commitStepResult(request)).toEqual(receipt);
    await expect(store.commitStepResult({ ...request, validation: "invalid" })).rejects.toThrow("idempotency conflict");
    await expect(store.commitStepResult({ ...request, idempotencyKey: "other" })).rejects.toThrow("running");
    expect(await store.listArtifacts(run.id)).toHaveLength(1);
    expect((await store.listAttempts(step.id))[0]?.state).toBe("succeeded");
  });

  it("reopens persisted runs and reuses completed runtime publish steps", async () => {
    const id = workspace();
    const store = makeStore(id);
    const workflow = { id: "publish-replay", revision: "1",
      execute: async (ctx: WorkflowContext) => ctx.publish("report", "report", { answer: 42 }, { validation: "valid" }) };
    const runner = { run: async () => ({ output: null }) };
    const first = await runWorkflow({ workflow, input: {}, store, agentRunner: runner });
    expect(first.run.state).toBe("succeeded");
    const secondPool = new Pool({ connectionString: url! });
    const reopened = new PostgresWorkflowRunStore(secondPool, { workspaceId: id });
    expect(await reopened.getArtifactPayload(first.output!.id)).toEqual({ answer: 42 });
    const second = await runWorkflow({ workflow, input: {}, store: reopened, agentRunner: runner, resumeRunId: first.run.id });
    expect(second.output).toEqual(first.output);
    expect((await reopened.listArtifacts(first.run.id))).toHaveLength(1);
    expect((await reopened.listEvents(first.run.id)).some((event) => event.type === "step.reused")).toBe(true);
    await secondPool.end();
  });
});
