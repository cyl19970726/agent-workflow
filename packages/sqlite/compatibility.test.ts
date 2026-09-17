import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineAgent,
  runWorkflow,
  workflow,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
} from "@signal-room/workflow";
import { SQLiteWorkflowRunStore } from "@signal-room/workflow-sqlite";

const databases: DatabaseSync[] = [];

// Frozen documents produced by the pre-extraction SQLite adapter at self-media
// c460d1cd. Keep these as JSON-shaped persistence records rather than rebuilding
// them through the new package API: this test protects the on-disk contract.
const legacy = {
  run: {
    id: "legacy-run-1",
    workflowId: "post.analyze",
    workflowRevision: "v5",
    inputFingerprint: "fnv1a64:83efd0bb9af64159",
    state: "succeeded",
    metadata: { creatorRunId: "creator-legacy", postExternalId: "post-legacy" },
    output: { candidate: "retained", evidenceRefs: ["source:1"] },
  },
  step: {
    id: "legacy-step-1",
    runId: "legacy-run-1",
    key: "builder",
    kind: "agent",
    workflowId: "post.analyze",
    workflowRevision: "v5",
    inputFingerprint: "fnv1a64:c41761b8d7b13432",
    configFingerprint: "fnv1a64:ee16354f717325c5",
    state: "succeeded",
    validation: "valid",
    output: { candidate: "retained", evidenceRefs: ["source:1"] },
  },
  attempt: {
    id: "legacy-attempt-1",
    runId: "legacy-run-1",
    stepRunId: "legacy-step-1",
    state: "succeeded",
  },
  artifact: {
    id: "legacy-artifact-1",
    type: "reconstruction",
    schemaVersion: "1",
    revision: "1",
    sha256: "76d95c26aa4b866e21550f28650f1a1c009a9d21c9fab2decb10684921cbf054",
    uri: "artifact://legacy/reconstruction",
    producedBy: {
      workflowRunId: "legacy-run-1",
      stepRunId: "legacy-step-1",
      attemptId: "legacy-attempt-1",
    },
    dependsOn: [],
    validation: "valid",
    review: "passed",
  },
  artifactPayload: { candidate: "retained", evidenceRefs: ["source:1"] },
};

function openLegacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  // This is the genuine pre-extraction schema, including its business-specific
  // creator index. The extracted package must open it without a migration.
  database.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE INDEX workflow_runs_creator ON workflow_runs(json_extract(document, '$.metadata.creatorRunId'));
    CREATE INDEX workflow_runs_parent ON workflow_runs(json_extract(document, '$.parentRunId'));
    CREATE TABLE workflow_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id),
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE INDEX workflow_steps_run ON workflow_steps(run_id);
    CREATE TABLE workflow_attempts (
      id TEXT PRIMARY KEY, step_run_id TEXT NOT NULL REFERENCES workflow_steps(id),
      document TEXT NOT NULL CHECK(json_valid(document))
    );
    CREATE INDEX workflow_attempts_step ON workflow_attempts(step_run_id);
    CREATE TABLE workflow_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id),
      seq INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(run_id, seq)
    );
    CREATE TABLE workflow_artifacts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id),
      document TEXT NOT NULL CHECK(json_valid(document)), payload TEXT NOT NULL CHECK(json_valid(payload))
    );
    CREATE INDEX workflow_artifacts_run ON workflow_artifacts(run_id);
  `);
  database.prepare("INSERT INTO workflow_runs(id, document) VALUES (?, ?)")
    .run(legacy.run.id, JSON.stringify(legacy.run));
  database.prepare("INSERT INTO workflow_steps(id, run_id, document) VALUES (?, ?, ?)")
    .run(legacy.step.id, legacy.run.id, JSON.stringify(legacy.step));
  database.prepare("INSERT INTO workflow_attempts(id, step_run_id, document) VALUES (?, ?, ?)")
    .run(legacy.attempt.id, legacy.step.id, JSON.stringify(legacy.attempt));
  database.prepare("INSERT INTO workflow_artifacts(id, run_id, document, payload) VALUES (?, ?, ?, ?)")
    .run(legacy.artifact.id, legacy.run.id, JSON.stringify(legacy.artifact), JSON.stringify(legacy.artifactPayload));
  return database;
}

class RejectPaidAgent implements AgentRunner {
  calls = 0;
  async run<Input, Output>(_request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    this.calls++;
    throw new Error("backward-compatible resume must not invoke the paid agent");
  }
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("pre-extraction SQLite compatibility", () => {
  it("reopens legacy records, filters old metadata, and reuses validated agent work with provenance intact", async () => {
    const store = new SQLiteWorkflowRunStore(openLegacyDatabase());
    const runner = new RejectPaidAgent();
    const builder = defineAgent<{ source: string }, typeof legacy.artifactPayload>({
      id: "builder",
      revision: "1",
      model: "paid-model",
      reasoningEffort: "medium",
      promptRevision: "1",
      skillsRevision: "1",
      permissionsRevision: "1",
    });
    const definition = workflow("post.analyze", { revision: "v5" },
      (context) => context.agent("builder", builder, { source: "frozen-evidence" }));

    const reopened = await store.getRun(legacy.run.id);
    expect(reopened?.metadata).toEqual({ creatorRunId: "creator-legacy", postExternalId: "post-legacy" });
    expect(await store.listRuns({ metadata: { creatorRunId: "creator-legacy" } }))
      .toEqual([expect.objectContaining({ id: legacy.run.id })]);
    expect(await store.listRuns({ metadata: { creatorRunId: "another-creator" } })).toEqual([]);

    const resumed = await runWorkflow({
      workflow: definition,
      input: { postExternalId: "post-legacy" },
      store,
      agentRunner: runner,
      resumeRunId: legacy.run.id,
    });

    expect(runner.calls).toBe(0);
    expect(resumed.output).toEqual(legacy.artifactPayload);
    expect(await store.listAttempts(legacy.step.id)).toEqual([legacy.attempt]);
    expect(await store.getArtifact(legacy.artifact.id)).toEqual(legacy.artifact);
    expect(await store.getArtifactPayload(legacy.artifact.id)).toEqual(legacy.artifactPayload);
    expect((await store.listEvents(legacy.run.id)).some((event) =>
      event.type === "step.reused" && event.stepRunId === legacy.step.id)).toBe(true);
  });
});
