import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { SQLiteWorkflowRunStore } from "@signal-room/workflow-sqlite";
import { createWorkflowReadService } from "./service.js";

const open: DatabaseSync[] = [];
afterEach(() => open.splice(0).forEach(db => db.close()));

it("projects SQLite records through the same browser contract and discovers terminal assets", async () => {
  const db = new DatabaseSync(":memory:"); open.push(db);
  const store = new SQLiteWorkflowRunStore(db);
  const root = await store.createRun({ workflowId: "research", workflowRevision: "1", inputFingerprint: "secret", state: "running", metadata: { secret: "raw" } });
  const other = await store.createRun({ workflowId: "research", workflowRevision: "1", inputFingerprint: "secret", state: "running", metadata: { secret: "raw" } });
  const phase = await store.createStep({ runId: root.id, key: "review", kind: "phase", workflowId: "research", workflowRevision: "1", inputFingerprint: "secret", configFingerprint: "secret", state: "running", validation: "pending", phaseId: "review", phaseDefinition: { title: "raw", purpose: "raw" } });
  const agent = await store.createStep({ runId: root.id, key: "reviewer", kind: "agent", workflowId: "research", workflowRevision: "1", inputFingerprint: "secret", configFingerprint: "secret", state: "succeeded", validation: "valid", phaseId: "review" });
  const attempt = await store.createAttempt({ runId: root.id, stepRunId: agent.id, state: "succeeded" });
  const service = createWorkflowReadService({ store });
  const initial = await service.getSnapshot({ rootRunId: root.id });
  expect(initial.runs.map(r => r.id)).toEqual([root.id]); expect(initial.stages[0]?.id).toBe(phase.id);
  expect(initial.calls[0]?.attempts[0]?.id).toBe(attempt.id);
  await store.updateRun(root.id, { state: "succeeded" });
  const payload = { safe: "body" };
  const { artifactPayloadSha256 } = await import("@signal-room/workflow");
  const artifact = await store.publishArtifact({ type: "receipt", schemaVersion: "1", revision: "1", sha256: await artifactPayloadSha256(payload), uri: "/private/secret", payload, producedBy: { workflowRunId: root.id, stepRunId: agent.id, attemptId: attempt.id }, dependsOn: [], validation: "valid", review: "passed" });
  await store.updateStep(phase.id, { artifactBindings: [{ artifact, role: "review" }] });
  const changes = await service.getChanges({ rootRunId: root.id, cursor: initial.cursor });
  expect(changes.resetRequired).toBe(false);
  if (changes.resetRequired) return;
  expect(changes.changed.artifacts[0]?.identity.id).toBe(artifact.id);
  expect(changes.changed.runs[0]?.state).toBe("succeeded");
  expect(JSON.stringify(changes)).not.toMatch(/\/private|secret|raw/);
  expect((await service.getSnapshot({ rootRunId: other.id })).artifacts).toEqual([]);
});

it("browser contracts entry contains no server or Node import", () => {
  const entry = readFileSync(new URL("../dist/contracts.js", import.meta.url), "utf8");
  expect(entry).not.toMatch(/\b(?:from|require|import)\b/);
});
