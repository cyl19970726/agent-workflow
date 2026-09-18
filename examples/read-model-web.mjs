import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { MemoryRunStore } from "@signal-room/workflow";
import { createWorkflowReadService } from "@signal-room/workflow-read-model";

const store = new MemoryRunStore();
const root = await store.createRun({ workflowId: "demo.review", workflowRevision: "1", inputFingerprint: "demo", state: "running" });
const phase = await store.createStep({ runId: root.id, key: "review", kind: "phase", workflowId: "demo.review", workflowRevision: "1", inputFingerprint: "demo", configFingerprint: "demo", state: "running", validation: "pending", phaseId: "review", phasePath: ["review"], phaseDefinition: { title: "Independent review", purpose: "Check the candidate", expectedArtifacts: [{ role: "review", required: true }] } });
const first = await store.createStep({ runId: root.id, key: "review-1", kind: "agent", workflowId: "demo.review", workflowRevision: "1", inputFingerprint: "demo", configFingerprint: "demo", state: "failed", validation: "invalid", phaseId: "review" });
await store.createAttempt({ runId: root.id, stepRunId: first.id, state: "failed", error: "Raw private error" });
const read = createWorkflowReadService({ store, adapters: {
  title: kind => kind === "phase" ? "Independent review" : "Reviewer",
  purpose: () => "Check the candidate and publish a valid receipt",
  error: () => "Output location failed validation",
  plan: () => ({ planned: 1, closed: true }),
} });
const html = await readFile(new URL("./read-model-web.html", import.meta.url));
let advanced = false;
async function advance() {
  if (advanced) return;
  advanced = true;
  const retry = await store.createStep({ runId: root.id, key: "review-2", kind: "agent", workflowId: "demo.review", workflowRevision: "1", inputFingerprint: "demo", configFingerprint: "demo", state: "succeeded", validation: "valid", phaseId: "review" });
  await store.createAttempt({ runId: root.id, stepRunId: retry.id, state: "succeeded" });
  await store.appendEvent({ runId: root.id, stepRunId: retry.id, type: "read-model.retry", data: { retryOf: first.id, reason: "Raw private error" } });
  const artifact = await store.publishArtifact({ type: "review-receipt", schemaVersion: "1", revision: "1", sha256: "demo", uri: "private://receipt", payload: { findings: [] }, producedBy: { workflowRunId: root.id, stepRunId: retry.id, attemptId: "demo" }, dependsOn: [], validation: "valid", review: "passed" });
  await store.updateStep(phase.id, { state: "succeeded", validation: "valid", artifactBindings: [{ artifact, role: "review" }] });
  await store.updateRun(root.id, { state: "succeeded" });
}
function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET") return json(response, { error: "Method not allowed" }, 405);
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(html); return; }
    if (url.pathname === "/api/snapshot") return json(response, await read.getSnapshot({ rootRunId: root.id }));
    if (url.pathname === "/api/changes") return json(response, await read.getChanges({ rootRunId: root.id, cursor: url.searchParams.get("cursor") ?? "" }));
    if (url.pathname === "/api/advance") { await advance(); return json(response, { advanced: true }); }
    if (url.pathname === "/api/stage") return json(response, await read.getStageDetails({ rootRunId: root.id, phaseId: url.searchParams.get("id") ?? "", cursor: url.searchParams.get("cursor") ?? undefined, limit: 1 }));
    return json(response, { error: "Not found" }, 404);
  } catch (error) {
    return json(response, { error: error instanceof Error ? error.message : "Request failed" }, 400);
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected listen address");
  console.log(`Open http://127.0.0.1:${address.port}/`);
});
