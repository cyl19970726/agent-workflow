import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "@signal-room/workflow";
import { createWorkflowReadService } from "./service.js";

const run = (store: MemoryRunStore, parentRunId?: string, parentStepRunId?: string) => store.createRun({ workflowId: "flow", workflowRevision: "1", inputFingerprint: "secret-input", state: "running", ...(parentRunId ? { parentRunId, parentStepRunId } : {}), metadata: { password: "private" }, output: { prompt: "private" } });
const step = (store: MemoryRunStore, runId: string, kind: "phase" | "agent", phaseId?: string) => store.createStep({ runId, key: "private-key", kind, workflowId: "flow", workflowRevision: "1", inputFingerprint: "private", configFingerprint: "private", state: "running", validation: "pending", ...(phaseId ? { phaseId, phasePath: [phaseId] } : {}), ...(kind === "phase" ? { phaseDefinition: { title: "raw unsafe", purpose: "private" } } : {}), output: { secret: "private" }, error: "private" });

describe("workflow read service", () => {
  it("scopes descendants and strips raw data, even from errors and artifact URIs", async () => {
    const store = new MemoryRunStore();
    const root = await run(store); const outside = await run(store); const phase = await step(store, root.id, "phase", "phase-1");
    const agent = await step(store, root.id, "agent", "phase-1");
    const attempt = await store.createAttempt({ runId: root.id, stepRunId: agent.id, state: "failed", error: "private trace /Users/test/key" });
    const child = await run(store, root.id, agent.id);
    await step(store, outside.id, "phase", "other");
    const artifact = await store.publishArtifact({ type: "report", schemaVersion: "1", revision: "1", sha256: "hash", uri: "/Users/test/secret", payload: { secret: "private" }, producedBy: { workflowRunId: root.id, stepRunId: agent.id, attemptId: attempt.id }, dependsOn: [], validation: "valid", review: "pending" });
    await store.updateStep(phase.id, { artifactBindings: [{ artifact, role: "report" }] });
    const service = createWorkflowReadService({ store });
    const snapshot = await service.getSnapshot({ rootRunId: root.id, selectedRunId: child.id });
    expect(snapshot.runs.map(r => r.id)).toEqual([root.id, child.id]);
    expect(snapshot.selectedRunId).toBe(child.id);
    expect(snapshot.stages[0]?.artifactIds).toEqual([artifact.id]);
    expect(snapshot.calls[0]?.attempts[0]?.state).toBe("failed");
    expect(JSON.stringify(snapshot)).not.toMatch(/private|\/Users|raw unsafe|secret-input/);
    await expect(service.getSnapshot({ rootRunId: root.id, selectedRunId: outside.id })).rejects.toThrow();
  });

  it("finds late children and artifacts after a terminal root, and invalidates stale cursors", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "phase-1");
    const service = createWorkflowReadService({ store, maxCursors: 1 });
    const initial = await service.getSnapshot({ rootRunId: root.id });
    await store.updateRun(root.id, { state: "succeeded" });
    const child = await run(store, root.id, phase.id);
    const artifact = await store.publishArtifact({ type: "report", schemaVersion: "1", revision: "1", sha256: "hash", uri: "secret", payload: {}, producedBy: { workflowRunId: child.id, stepRunId: phase.id, attemptId: "a" }, dependsOn: [], validation: "pending", review: "pending" });
    const delta = await service.getChanges({ rootRunId: root.id, cursor: initial.cursor });
    expect(delta.resetRequired).toBe(false);
    if (delta.resetRequired) return;
    expect(delta.changed.runs.map(r => r.id)).toContain(child.id);
    expect(delta.changed.artifacts.map(a => a.identity.id)).toContain(artifact.id);
    expect(delta.changed.runs.find(r => r.id === root.id)?.state).toBe("succeeded");
    expect(await service.getChanges({ rootRunId: root.id, cursor: initial.cursor })).toEqual({ resetRequired: true });
  });

  it("requires exact identities for semantic review relations", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const s = await step(store, root.id, "agent");
    const candidate = await store.publishArtifact({ type: "candidate", schemaVersion: "1", revision: "1", sha256: "h1", uri: "secret", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: s.id, attemptId: "a" }, dependsOn: [], validation: "valid", review: "pending" });
    const review = await store.publishArtifact({ type: "review", schemaVersion: "1", revision: "1", sha256: "h2", uri: "secret", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: s.id, attemptId: "b" }, dependsOn: [], validation: "valid", review: "pending" });
    const service = createWorkflowReadService({ store, adapters: { relations: a => a.id === review.id ? [{ kind: "reviews", from: { id: candidate.id, revision: "1", sha256: "WRONG" }, to: { id: review.id, revision: "1", sha256: "h2" } }] : [] } });
    expect((await service.getSnapshot({ rootRunId: root.id })).relations[0]?.validity).toBe("mismatch");
  });

  it("keeps retry attempts distinct and reads usage once per attempt", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "review");
    const first = await step(store, root.id, "agent", "review");
    const a1 = await store.createAttempt({ runId: root.id, stepRunId: first.id, state: "failed" });
    await store.appendEvent({ runId: root.id, stepRunId: first.id, attemptId: a1.id, type: "agent.usage", data: { usage: { inputTokens: 10, outputTokens: 2 } } });
    await store.appendEvent({ runId: root.id, stepRunId: first.id, attemptId: a1.id, type: "agent.completed", data: { usage: { inputTokens: 10, outputTokens: 2 } } });
    const second = await step(store, root.id, "agent", "review");
    await store.appendEvent({ runId: root.id, stepRunId: second.id, type: "read-model.retry", data: { retryOf: first.id, reason: "raw unsafe error" } });
    await store.createAttempt({ runId: root.id, stepRunId: second.id, state: "succeeded" });
    const view = await createWorkflowReadService({ store }).getSnapshot({ rootRunId: root.id });
    expect(view.stages.find(s => s.id === phase.id)?.callIds).toEqual([first.id, second.id]);
    expect(view.calls[0]?.attempts[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(view.calls[1]?.retryOf).toBe(first.id);
    expect(JSON.stringify(view)).not.toContain("raw unsafe error");
  });

  it("keeps repeated phase keys distinct, assigns nested child calls, and scopes a nested root", async () => {
    const store = new MemoryRunStore(); const batch = await run(store); const root = await run(store, batch.id, "batch-step");
    const left = await run(store, root.id, "left-step"); const right = await run(store, root.id, "right-step");
    const leftPhase = await step(store, left.id, "phase", "review"); const rightPhase = await step(store, right.id, "phase", "review");
    const childWorkflow = await step(store, left.id, "agent", "review");
    const grandchild = await run(store, left.id, childWorkflow.id); const nestedCall = await step(store, grandchild.id, "agent");
    await step(store, batch.id, "phase", "other");
    const view = await createWorkflowReadService({ store }).getSnapshot({ rootRunId: root.id });
    expect(view.stages.map(s => s.id)).toEqual([leftPhase.id, rightPhase.id]);
    expect(view.stages.map(s => s.phaseKey)).toEqual(["review", "review"]);
    expect(view.stages.find(s => s.id === leftPhase.id)?.callIds).toEqual([childWorkflow.id, nestedCall.id]);
    expect(view.stages.find(s => s.id === rightPhase.id)?.callIds).toEqual([]);
    expect(view.runs.some(r => r.id === batch.id)).toBe(false);
  });

  it("incremental event reads use per-run watermarks and discover a new child", async () => {
    const store = new MemoryRunStore(); const calls: Array<[string, number | undefined]> = [];
    const original = store.listEvents.bind(store);
    store.listEvents = async (runId, afterSeq) => { calls.push([runId, afterSeq]); return original(runId, afterSeq); };
    const root = await run(store); await store.appendEvent({ runId: root.id, type: "workflow.started" });
    const service = createWorkflowReadService({ store }); const first = await service.getSnapshot({ rootRunId: root.id });
    const child = await run(store, root.id, "step"); await store.appendEvent({ runId: child.id, type: "workflow.started" });
    await service.getChanges({ rootRunId: root.id, cursor: first.cursor });
    expect(calls).toEqual([[root.id, 0], [root.id, 1], [child.id, 0]]);
  });

  it("does not conflate blocked, canceled, and reused calls with successful delivery", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const blocked = await step(store, root.id, "phase", "blocked");
    const canceled = await step(store, root.id, "agent", "blocked");
    await store.updateStep(blocked.id, { state: "blocked" }); await store.updateStep(canceled.id, { state: "canceled" });
    await store.appendEvent({ runId: root.id, stepRunId: canceled.id, type: "step.reused" });
    const view = await createWorkflowReadService({ store }).getSnapshot({ rootRunId: root.id });
    expect(view.stages[0]).toMatchObject({ state: "blocked", delivery: "missing" });
    expect(view.calls[0]).toMatchObject({ state: "canceled", reused: true, phaseId: blocked.id });
  });

  it("review applies only to the precisely reviewed candidate, not its revision", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "builder");
    const agent = await step(store, root.id, "agent", "builder");
    const draft = (revision: string, hash: string) => store.publishArtifact({ type: "candidate", schemaVersion: "1", revision, sha256: hash, uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: agent.id, attemptId: "a" }, dependsOn: [], validation: "valid", review: "pending" });
    const old = await draft("1", "old"); const revised = await draft("2", "new");
    const review = await store.publishArtifact({ type: "review", schemaVersion: "1", revision: "1", sha256: "review", uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: agent.id, attemptId: "b" }, dependsOn: [], validation: "valid", review: "passed" });
    const exact = (a: typeof old) => ({ id: a.id, revision: a.revision, sha256: a.sha256 });
    const service = createWorkflowReadService({ store, adapters: { relations: a => a.id === review.id ? [{ kind: "reviews", from: exact(review), to: exact(old) }] : [] } });
    await store.updateStep(phase.id, { artifactBindings: [{ artifact: old, role: "candidate" }] });
    const reviewed = await service.getSnapshot({ rootRunId: root.id });
    expect(reviewed.stages[0]?.review).toBe("passed");
    expect(reviewed.artifacts.find(a => a.identity.id === old.id)).toMatchObject({ review: "pending", effectiveReview: "passed" });
    await store.updateStep(phase.id, { artifactBindings: [{ artifact: revised, role: "candidate" }] });
    const revisedView = await service.getSnapshot({ rootRunId: root.id });
    expect(revisedView.stages[0]?.review).toBe("unknown");
    expect(revisedView.artifacts.find(a => a.identity.id === revised.id)?.effectiveReview).toBe("unknown");
  });

  it("preserves a host-reported report-hash mismatch despite exact artifact endpoints", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "review");
    const call = await step(store, root.id, "agent", "review");
    const publish = (type: string, hash: string, review: "pending" | "passed") => store.publishArtifact({ type, schemaVersion: "1", revision: "1", sha256: hash, uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: call.id, attemptId: "a" }, dependsOn: [], validation: "valid", review });
    const candidate = await publish("candidate", "candidate-hash", "pending");
    const receipt = await publish("review", "receipt-hash", "passed");
    await store.updateStep(phase.id, { artifactBindings: [{ artifact: candidate, role: "candidate" }] });
    const exact = (a: typeof candidate) => ({ id: a.id, revision: a.revision, sha256: a.sha256 });
    const view = await createWorkflowReadService({ store, adapters: { relations: a => a.id === receipt.id ? [{ kind: "reviews", from: exact(receipt), to: exact(candidate), validity: "mismatch", reason: "report-hash-mismatch" }] : [] } }).getSnapshot({ rootRunId: root.id });
    expect(view.relations[0]?.validity).toBe("mismatch");
    expect(view.stages[0]?.review).toBe("unknown");
    expect(view.artifacts.find(a => a.identity.id === candidate.id)).toMatchObject({ review: "pending", effectiveReview: "unknown" });
  });

  it("stage pages remain stable if new calls appear between pages", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "review");
    const a = await step(store, root.id, "agent", "review"); const b = await step(store, root.id, "agent", "review");
    const service = createWorkflowReadService({ store, maxCursors: 2 });
    const first = await service.getStageDetails({ rootRunId: root.id, phaseId: phase.id, limit: 1 });
    expect(first.calls.map(c => c.id)).toEqual([a.id]);
    const c = await step(store, root.id, "agent", "review");
    const second = await service.getStageDetails({ rootRunId: root.id, phaseId: phase.id, cursor: first.nextCursor });
    expect(second.calls.map(call => call.id)).toEqual([b.id]);
    expect(second.calls.some(call => call.id === c.id)).toBe(false);
    await expect(service.getStageDetails({ rootRunId: "other", phaseId: phase.id, cursor: first.nextCursor })).rejects.toThrow();
  });

  it("shows a child-produced artifact before its parent phase binds it", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "build");
    const dispatch = await step(store, root.id, "agent", "build"); const child = await run(store, root.id, dispatch.id);
    const publish = await store.createStep({ runId: child.id, key: "publish", kind: "publish", workflowId: "flow", workflowRevision: "1", inputFingerprint: "private", configFingerprint: "private", state: "succeeded", validation: "valid" });
    const receipt = await store.publishArtifact({ type: "candidate", schemaVersion: "1", revision: "1", sha256: "h", uri: "private", payload: {}, producedBy: { workflowRunId: child.id, stepRunId: publish.id, attemptId: "a" }, dependsOn: [], validation: "valid", review: "pending" });
    const view = await createWorkflowReadService({ store }).getSnapshot({ rootRunId: root.id });
    expect(view.stages.find(s => s.id === phase.id)?.artifactIds).toContain(receipt.id);
    expect(view.stages.find(s => s.id === phase.id)?.delivery).toBe("unknown");
  });

  it("canceled run resolves waiting phase and heterogeneous assets do not imply competing candidates", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "review");
    await store.updateRun(root.id, { state: "canceled" }); await store.updateStep(phase.id, { state: "waiting" });
    const artifacts = await Promise.all(["evidence", "receipt"].map((type, i) => store.publishArtifact({ type, schemaVersion: "1", revision: "1", sha256: `hash-${i}`, uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: phase.id, attemptId: "a" }, dependsOn: [], validation: "valid", review: "pending" })));
    await store.updateStep(phase.id, { artifactBindings: artifacts.map((artifact, i) => ({ artifact, role: i === 0 ? "evidence" : "receipt" })) });
    expect((await createWorkflowReadService({ store }).getSnapshot({ rootRunId: root.id })).stages[0]).toMatchObject({ state: "canceled", delivery: "unknown" });
  });

  it("coalesces replayed phase controls into one stable stage with all calls", async () => {
    const store = new MemoryRunStore(); const root = await run(store);
    const firstPhase = await step(store, root.id, "phase", "review");
    await store.updateStep(firstPhase.id, { state: "waiting" });
    const firstCall = await step(store, root.id, "agent", "review");
    const resumedPhase = await step(store, root.id, "phase", "review");
    await store.updateStep(resumedPhase.id, { state: "succeeded", validation: "valid" });
    const secondCall = await step(store, root.id, "agent", "review");
    const view = await createWorkflowReadService({ store }).getSnapshot({ rootRunId: root.id });
    expect(view.stages).toHaveLength(1);
    expect(view.stages[0]).toMatchObject({ id: firstPhase.id, state: "succeeded", validation: "valid", callIds: [firstCall.id, secondCall.id] });
    expect(view.calls.map(c => c.phaseId)).toEqual([firstPhase.id, firstPhase.id]);
  });

  it("resolves an authorized external dependency without expanding the execution tree", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const outside = await run(store);
    const sourceStep = await step(store, outside.id, "agent");
    const source = await store.publishArtifact({ type: "source", schemaVersion: "1", revision: "1", sha256: "source-hash", uri: "private://source", payload: {}, producedBy: { workflowRunId: outside.id, stepRunId: sourceStep.id, attemptId: "a" }, dependsOn: [], validation: "valid", review: "not_applicable" });
    const producer = await step(store, root.id, "agent");
    await store.publishArtifact({ type: "candidate", schemaVersion: "1", revision: "1", sha256: "candidate-hash", uri: "private://candidate", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: producer.id, attemptId: "b" }, dependsOn: [{ artifactId: source.id, revision: source.revision, sha256: source.sha256 }], validation: "valid", review: "pending" });
    const seen: string[] = [];
    const service = createWorkflowReadService({ store, adapters: { externalArtifact: async (ref, requestedRoot) => { seen.push(`${ref.id}:${requestedRoot.id}`); return store.getArtifact(ref.id); } } });
    const view = await service.getSnapshot({ rootRunId: root.id });
    expect(view.runs.map(r => r.id)).toEqual([root.id]);
    expect(view.artifacts.find(a => a.identity.id === source.id)?.scope).toBe("external");
    expect(view.relations.find(r => r.kind === "consumed")?.validity).toBe("valid");
    expect(seen).toEqual([`${source.id}:${root.id}`]);
    expect(JSON.stringify(view)).not.toContain("private://");
  });

  it("keeps denied and mismatched external references unresolved", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const phase = await step(store, root.id, "phase", "review");
    const producer = await step(store, root.id, "agent", "review");
    const external = { id: "foreign", revision: "1", sha256: "expected" };
    await store.publishArtifact({ type: "candidate", schemaVersion: "1", revision: "1", sha256: "candidate", uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: producer.id, attemptId: "a" }, dependsOn: [{ artifactId: external.id, revision: external.revision, sha256: external.sha256 }], validation: "valid", review: "pending" });
    await store.updateStep(phase.id, { state: "succeeded" });
    const denied = await createWorkflowReadService({ store, adapters: { externalArtifact: () => undefined } }).getSnapshot({ rootRunId: root.id });
    expect(denied.relations.find(r => r.kind === "consumed")?.validity).toBe("missing");
    expect(denied.artifacts.some(a => a.identity.id === external.id)).toBe(false);
    const wrong = await createWorkflowReadService({ store, adapters: { externalArtifact: () => ({ id: "foreign", revision: "1", sha256: "wrong", type: "source", schemaVersion: "1", uri: "private", producedBy: { workflowRunId: "outside", stepRunId: "outside", attemptId: "outside" }, dependsOn: [], validation: "valid", review: "pending" }) } }).getSnapshot({ rootRunId: root.id });
    expect(wrong.relations.find(r => r.kind === "consumed")?.validity).toBe("mismatch");
    expect(wrong.artifacts.some(a => a.identity.id === external.id)).toBe(false);
  });

  it("reports ambiguous deliverable branches until an exact selection, ignoring other artifact types", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const producer = await step(store, root.id, "agent");
    const publish = (type: string, hash: string) => store.publishArtifact({ type, schemaVersion: "1", revision: "1", sha256: hash, uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: producer.id, attemptId: "a" }, dependsOn: [], validation: "valid", review: "pending" });
    await publish("evidence", "e");
    const candidate1 = await publish("candidate", "c1");
    const service = createWorkflowReadService({ store, adapters: { isDeliverable: a => a.type === "candidate" } });
    expect((await service.getSnapshot({ rootRunId: root.id })).delivery).toEqual({ state: "unknown", artifactIds: [candidate1.id] });
    const candidate2 = await publish("candidate", "c2");
    expect((await service.getSnapshot({ rootRunId: root.id })).delivery).toEqual({ state: "ambiguous", artifactIds: [candidate1.id, candidate2.id] });
    const selection = await publish("selection", "s");
    const exact = (a: typeof selection) => ({ id: a.id, revision: a.revision, sha256: a.sha256 });
    const selected = createWorkflowReadService({ store, adapters: { isDeliverable: a => a.type === "candidate", relations: a => a.id === selection.id ? [{ kind: "selected", from: exact(selection), to: exact(candidate2) }] : [] } });
    expect((await selected.getSnapshot({ rootRunId: root.id })).delivery).toEqual({ state: "selected", artifactIds: [candidate2.id] });
  });

  it("binds agent inputs and publish-step outputs only through exact host-declared identities", async () => {
    const store = new MemoryRunStore(); const root = await run(store); const agent = await step(store, root.id, "agent");
    const publisher = await store.createStep({ runId: root.id, key: "publish", kind: "publish", workflowId: "flow", workflowRevision: "1", inputFingerprint: "private", configFingerprint: "private", state: "succeeded", validation: "valid" });
    const source = await store.publishArtifact({ type: "source", schemaVersion: "1", revision: "1", sha256: "source", uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: publisher.id, attemptId: "a" }, dependsOn: [], validation: "valid", review: "not_applicable" });
    const output = await store.publishArtifact({ type: "candidate", schemaVersion: "1", revision: "1", sha256: "output", uri: "private", payload: {}, producedBy: { workflowRunId: root.id, stepRunId: publisher.id, attemptId: "b" }, dependsOn: [], validation: "valid", review: "pending" });
    const exact = (a: typeof source) => ({ id: a.id, revision: a.revision, sha256: a.sha256 });
    const service = createWorkflowReadService({ store, adapters: { callArtifacts: s => s.id === agent.id ? { inputs: [exact(source)], outputs: [exact(output), { ...exact(source), sha256: "wrong" }] } : {} } });
    const view = await service.getSnapshot({ rootRunId: root.id });
    expect(view.calls[0]).toMatchObject({ inputArtifactIds: [source.id], artifactIds: [output.id] });
  });
});
