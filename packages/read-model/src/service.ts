import { randomUUID } from "node:crypto";
import type { ArtifactRef, RunStore, RunRecord, StepRecord, WorkflowEvent } from "@signal-room/workflow";
import type { ArtifactIdentity, ArtifactRelation, AttemptView, CallView, FactState, RunView, SafeArtifact, StageView, WorkflowChanges, WorkflowReadService, WorkflowSnapshot, StageDetails } from "../contracts.js";

export interface ReadAdapters {
  /** All returned strings must already be safe for this authenticated viewer. */
  title?: (kind: "phase" | "call", id: string, record: StepRecord) => string | undefined;
  purpose?: (phase: StepRecord) => string | undefined;
  error?: (attemptId: string, error: string) => string | undefined;
  readerUrl?: (artifact: ArtifactRef) => string | undefined;
  /** Resolve only an exact referenced identity, after host authorization for this root. */
  externalArtifact?: (identity: ArtifactIdentity, root: RunRecord) => ArtifactRef | undefined | Promise<ArtifactRef | undefined>;
  /** Host-only candidate classification; generic artifacts are never assumed deliverable. */
  isDeliverable?: (artifact: ArtifactRef) => boolean;
  /** Explicit call input/output references; only exact ledger identities are exposed. */
  callArtifacts?: (step: StepRecord, artifacts: readonly ArtifactRef[]) => { inputs?: readonly ArtifactIdentity[]; outputs?: readonly ArtifactIdentity[] } | Promise<{ inputs?: readonly ArtifactIdentity[]; outputs?: readonly ArtifactIdentity[] }>;
  /** Explicit domain facts only; the service never inspects payloads to infer review or selection. */
  relations?: (artifact: ArtifactRef) => readonly (Omit<ArtifactRelation, "validity"> & { validity?: "mismatch" | "missing" })[] | Promise<readonly (Omit<ArtifactRelation, "validity"> & { validity?: "mismatch" | "missing" })[]>;
  phaseFacts?: (phase: StepRecord) => Partial<Pick<StageView, "review" | "delivery" | "state">> | Promise<Partial<Pick<StageView, "review" | "delivery" | "state">>>;
  callFacts?: (step: StepRecord, events: readonly WorkflowEvent[]) => Partial<Pick<CallView, "model" | "reasoningEffort" | "methodRevision" | "methodDigest">>;
  plan?: (root: RunRecord) => { planned?: number; closed: boolean };
}
export interface ReadOptions { store: RunStore; adapters?: ReadAdapters; maxCursors?: number; maxRuns?: number }
type CursorEntry = { rootRunId: string; snapshot: WorkflowSnapshot; watermarks: Record<string, number>; events: Map<string, WorkflowEvent[]> };
const identity = (a: ArtifactRef): ArtifactIdentity => ({ id: a.id, revision: a.revision, sha256: a.sha256 });
const identityKey = (a: ArtifactIdentity) => `${a.id}\0${a.revision}\0${a.sha256}`;
const validStates: readonly string[] = ["queued", "running", "waiting", "blocked", "needs_review", "succeeded", "failed", "canceled"];
const state = (value: string) => validStates.includes(value) ? value as StageView["state"] : "unknown";
const fact = (value: string): FactState => ["pending", "valid", "invalid", "passed", "findings", "not_applicable"].includes(value) ? value as FactState : "unknown";
const last = (events: WorkflowEvent[], type: string) => [...events].reverse().find(e => e.type === type);
const eventTime = (events: WorkflowEvent[], type: string) => last(events, type)?.timestamp;
const safeFact = <T extends string>(value: T | undefined, allowed: readonly string[]): T | undefined => value && allowed.includes(value) ? value : undefined;
const safeUsage = (event: WorkflowEvent | undefined): AttemptView["usage"] => {
  if (!event?.data || typeof event.data !== "object") return undefined;
  const usage = (event.data as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const numbers = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;
  const result: NonNullable<AttemptView["usage"]> = {};
  for (const key of numbers) if (typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && raw[key] >= 0) result[key] = raw[key];
  return Object.keys(result).length ? result : undefined;
};

export function createWorkflowReadService({ store, adapters = {}, maxCursors = 64, maxRuns = 2000 }: ReadOptions): WorkflowReadService {
  const cursors = new Map<string, CursorEntry>();
  const detailCursors = new Map<string, { rootRunId: string; phaseId: string; calls: CallView[]; artifacts: SafeArtifact[]; offset: number }>();
  async function collect(rootRunId: string, prior?: CursorEntry): Promise<{ runs: RunRecord[]; steps: Map<string, StepRecord[]>; artifacts: ArtifactRef[]; events: Map<string, WorkflowEvent[]>; watermarks: Record<string, number> }> {
    const root = await store.getRun(rootRunId);
    if (!root) throw new Error("Root run not found");
    const runs: RunRecord[] = [], seen = new Set<string>(), queue = [root];
    while (queue.length) {
      const run = queue.shift()!;
      if (seen.has(run.id)) continue;
      seen.add(run.id); runs.push(run);
      if (runs.length > maxRuns) throw new Error("Run tree exceeds configured limit");
      const children = await store.listRuns({ parentRunId: run.id });
      for (const child of children) if (child.parentRunId === run.id) queue.push(child);
    }
    const steps = new Map<string, StepRecord[]>(), events = new Map<string, WorkflowEvent[]>(), artifacts: ArtifactRef[] = [];
    const watermarks: Record<string, number> = {};
    for (const run of runs) {
      steps.set(run.id, await store.listSteps(run.id));
      const previous = prior?.events.get(run.id) ?? [];
      const list = [...previous, ...await store.listEvents(run.id, prior?.watermarks[run.id] ?? 0)];
      events.set(run.id, list);
      watermarks[run.id] = list.at(-1)?.seq ?? 0;
      artifacts.push(...await store.listArtifacts(run.id));
    }
    return { runs, steps, artifacts, events, watermarks };
  }
  async function project(rootRunId: string, data: Awaited<ReturnType<typeof collect>>): Promise<WorkflowSnapshot> {
    const { runs, steps, events } = data;
    const artifacts = [...data.artifacts];
    const runIds = new Set(runs.map(r => r.id));
    const allSteps = [...steps.values()].flat();
    const stepById = new Map(allSteps.map(s => [s.id, s]));
    const runById = new Map(runs.map(r => [r.id, r]));
    const phaseGroups = new Map<string, StepRecord[]>();
    for (const step of allSteps) if (step.kind === "phase" && step.phaseId) {
      const key = `${step.runId}\0${step.phaseId}`;
      const group = phaseGroups.get(key) ?? [];
      group.push(step); phaseGroups.set(key, group);
    }
    const stageIdOf = (phase: StepRecord): string => phaseGroups.get(`${phase.runId}\0${phase.phaseId}`)?.[0]?.id ?? phase.id;
    const phaseOwner = (step: StepRecord, visited = new Set<string>()): string | undefined => {
      if (visited.has(step.id)) return undefined;
      visited.add(step.id);
      if (step.kind === "phase") return stageIdOf(step);
      const siblings = steps.get(step.runId) ?? [];
      const position = siblings.findIndex(s => s.id === step.id);
      const direct = siblings.slice(0, position < 0 ? undefined : position + 1).filter(s => s.kind === "phase" && s.phaseId === step.phaseId).at(-1);
      if (direct) return stageIdOf(direct);
      const parentStep = stepById.get(runById.get(step.runId)?.parentStepRunId ?? "");
      return parentStep ? phaseOwner(parentStep, visited) : undefined;
    };
    const explicitRelations = new Map<string, readonly (Omit<ArtifactRelation, "validity"> & { validity?: "mismatch" | "missing" })[]>();
    const callArtifactFacts = new Map<string, { inputs?: readonly ArtifactIdentity[]; outputs?: readonly ArtifactIdentity[] }>();
    const referenced = new Map<string, ArtifactIdentity>();
    for (const artifact of artifacts) {
      for (const dep of artifact.dependsOn) { const ref = { id: dep.artifactId, revision: dep.revision, sha256: dep.sha256 }; referenced.set(identityKey(ref), ref); }
      const declared = await adapters.relations?.(artifact) ?? [];
      explicitRelations.set(artifact.id, declared);
      for (const relation of declared) { referenced.set(identityKey(relation.from), relation.from); referenced.set(identityKey(relation.to), relation.to); }
    }
    for (const step of allSteps) for (const binding of step.artifactBindings ?? []) {
      const ref = identity(binding.artifact);
      referenced.set(identityKey(ref), ref);
    }
    if (adapters.callArtifacts) for (const step of allSteps) if (step.kind === "agent" || step.kind === "workflow") {
      const facts = await adapters.callArtifacts(step, data.artifacts);
      callArtifactFacts.set(step.id, facts);
      for (const ref of [...facts.inputs ?? [], ...facts.outputs ?? []]) referenced.set(identityKey(ref), ref);
    }
    const artifactById = new Map(artifacts.map(a => [a.id, a]));
    const artifactKeys = new Set(artifacts.map(a => identityKey(identity(a))));
    const mismatchedExternalIds = new Set<string>();
    const externalIds = new Set<string>();
    for (const ref of referenced.values()) {
      if (artifactKeys.has(identityKey(ref)) || artifactById.has(ref.id)) continue;
      const resolved = await adapters.externalArtifact?.(ref, runs[0]!);
      if (!resolved) continue;
      if (identityKey(identity(resolved)) !== identityKey(ref)) { mismatchedExternalIds.add(ref.id); continue; }
      artifacts.push(resolved); artifactById.set(resolved.id, resolved);
      artifactKeys.add(identityKey(ref)); externalIds.add(ref.id);
    }
    const diagnostics: string[] = [];
    const runViews: RunView[] = runs.map(r => ({ id: r.id, workflowId: r.workflowId, state: state(r.state),
      ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}), ...(r.parentStepRunId ? { parentStepId: r.parentStepRunId } : {}),
      childRunIds: runs.filter(c => c.parentRunId === r.id).map(c => c.id),
      ...(r.id !== rootRunId && r.parentRunId && (!runIds.has(r.parentRunId) || (r.parentStepRunId && !stepById.has(r.parentStepRunId))) ? { diagnostic: "missing_parent" as const } : {}) }));
    for (const r of runViews) if (r.diagnostic) diagnostics.push(`${r.diagnostic}:${r.id}`);
    const safeArtifacts: SafeArtifact[] = artifacts.map(a => ({ identity: identity(a), type: a.type, schemaVersion: a.schemaVersion, scope: externalIds.has(a.id) ? "external" : "produced",
      producer: { runId: a.producedBy.workflowRunId, stepId: a.producedBy.stepRunId, attemptId: a.producedBy.attemptId },
      validation: fact(a.validation), review: fact(a.review), effectiveReview: "unknown", ...(adapters.readerUrl?.(a) ? { readerUrl: adapters.readerUrl(a) } : {}) }));
    const relations: ArtifactRelation[] = [];
    for (const a of data.artifacts) {
      for (const dep of a.dependsOn) {
        const target = artifactById.get(dep.artifactId);
        relations.push({ kind: "consumed", from: { id: dep.artifactId, revision: dep.revision, sha256: dep.sha256 }, to: identity(a),
          validity: !target ? mismatchedExternalIds.has(dep.artifactId) ? "mismatch" : "missing" : identityKey(identity(target)) === identityKey({ id: dep.artifactId, revision: dep.revision, sha256: dep.sha256 }) ? "valid" : "mismatch" });
      }
      for (const relation of explicitRelations.get(a.id) ?? []) {
        const from = artifactById.get(relation.from.id), to = artifactById.get(relation.to.id);
        const ledgerValidity = !from || !to ? mismatchedExternalIds.has(relation.from.id) || mismatchedExternalIds.has(relation.to.id) ? "mismatch" : "missing" : artifactKeys.has(identityKey(relation.from)) && artifactKeys.has(identityKey(relation.to)) ? "valid" : "mismatch";
        const validity = ledgerValidity !== "valid" ? ledgerValidity : relation.validity ?? "valid";
        relations.push({ kind: relation.kind, from: relation.from, to: relation.to, ...(relation.reason ? { reason: relation.reason } : {}), validity });
      }
    }
    for (const artifact of safeArtifacts) {
      const states = relations.filter(r => r.kind === "reviews" && r.validity === "valid" && identityKey(r.to) === identityKey(artifact.identity))
        .map(r => artifactById.get(r.from.id)?.review);
      artifact.effectiveReview = states.includes("findings") ? "findings" : states.includes("passed") ? "passed" : "unknown";
    }
    const calls: CallView[] = [], stages: StageView[] = [];
    for (const step of allSteps) {
      const ev = events.get(step.runId) ?? [];
      if (step.kind === "agent" || step.kind === "workflow") {
        const retry = ev.find(e => e.type === "read-model.retry" && e.stepRunId === step.id);
        const link = retry?.data && typeof retry.data === "object" ? retry.data as Record<string, unknown> : {};
        const childRunIds = runs.filter(r => r.parentStepRunId === step.id).map(r => r.id);
        const inheritedPhase = phaseOwner(step);
        const declared = callArtifactFacts.get(step.id);
        const exactIds = (refs: readonly ArtifactIdentity[] | undefined) => (refs ?? []).filter(ref => artifactKeys.has(identityKey(ref))).map(ref => ref.id);
        const directOutputs = artifacts.filter(a => a.producedBy.stepRunId === step.id).map(a => a.id);
        calls.push({ id: step.id, stepId: step.id, runId: step.runId, ...(inheritedPhase ? { phaseId: inheritedPhase } : {}), role: step.kind,
          state: state(step.state), validation: fact(step.validation), ...(adapters.title?.("call", step.id, step) ? { title: adapters.title("call", step.id, step) } : {}),
          ...adapters.callFacts?.(step, ev.filter(e => e.stepRunId === step.id)),
          ...(typeof link.retryOf === "string" ? { retryOf: link.retryOf } : {}), ...(typeof link.reason === "string" ? { retryReason: adapters.error?.(step.id, link.reason) } : {}),
          inputArtifactIds: [...new Set([...relations.filter(r => r.kind === "consumed" && directOutputs.includes(r.to.id) && r.validity === "valid").map(r => r.from.id), ...exactIds(declared?.inputs)])],
          reused: ev.some(e => e.stepRunId === step.id && e.type === "step.reused"), attempts: [], artifactIds: [...new Set([...directOutputs, ...exactIds(declared?.outputs)])], childRunIds });
      }
      if (step.kind !== "phase" || !step.phaseId) continue;
      const group = phaseGroups.get(`${step.runId}\0${step.phaseId}`)!;
      if (group.at(-1)?.id !== step.id) continue;
      const stableStageId = group[0]!.id;
      const bound = (step.artifactBindings ?? []).filter(b => artifactKeys.has(identityKey(identity(b.artifact))));
      const artifactIds = [...new Set([...bound.map(b => b.artifact.id), ...artifacts.filter(a => {
        const producer = stepById.get(a.producedBy.stepRunId);
        return producer && phaseOwner(producer) === stableStageId;
      }).map(a => a.id)])];
      const expectedArtifacts = (step.phaseDefinition?.expectedArtifacts ?? []).map(a => ({ role: a.role, ...(a.title ? { title: a.title } : {}), required: !!a.required, missing: !bound.some(b => b.role === a.role) }));
      const selected = relations.filter(r => r.kind === "selected" && r.validity === "valid" && artifactIds.includes(r.to.id));
      const primaryBindings = bound.filter(b => b.primary);
      const delivery = selected.length === 1 ? "selected" : selected.length > 1 || primaryBindings.length > 1 ? "ambiguous" : artifactIds.length ? "unknown" : "missing";
      const boundIds = [...new Set(bound.map(b => b.artifact.id))];
      const targetIds = selected.length === 1 ? [selected[0]!.to.id] : boundIds.length === 1 ? boundIds : [];
      const reviewRelations = relations.filter(r => r.kind === "reviews" && r.validity === "valid" && targetIds.some(id => id === r.to.id));
      const reviewStates = reviewRelations.map(r => artifactById.get(r.from.id)?.review).filter((v): v is "passed" | "findings" => v === "passed" || v === "findings");
      const derivedReview: FactState = reviewStates.includes("findings") ? "findings" : reviewStates.includes("passed") ? "passed" : "unknown";
      const f = await adapters.phaseFacts?.(step);
      const waitingEvent = last(ev.filter(e => e.stepRunId === step.id), "phase.waiting");
      const waitingData = waitingEvent?.data && typeof waitingEvent.data === "object" ? waitingEvent.data as Record<string, unknown> : {};
      stages.push({ id: stableStageId, phaseKey: step.phaseId, runId: step.runId, path: [...(step.phasePath ?? [step.phaseId])], title: adapters.title?.("phase", step.phaseId, step) ?? "Phase",
        purpose: adapters.purpose?.(step) ?? "", ...(step.phaseDefinition?.order !== undefined ? { order: step.phaseDefinition.order } : {}), state: safeFact(f?.state, validStates) ?? (runById.get(step.runId)?.state === "canceled" && step.state === "waiting" ? "canceled" : state(step.state)),
        validation: fact(step.validation), review: safeFact(f?.review, ["unknown", "pending", "passed", "findings", "not_applicable"]) ?? derivedReview,
        delivery: safeFact(f?.delivery, ["unknown", "missing", "ambiguous", "selected"]) ?? delivery,
        ...(typeof waitingData.childRunId === "string" ? { waitingForRunId: waitingData.childRunId } : {}), expectedArtifacts, artifactIds,
        callIds: calls.filter(c => c.phaseId === stableStageId).map(c => c.id),
        ...(eventTime(ev.filter(e => e.stepRunId === group[0]!.id), "phase.started") ? { startedAt: eventTime(ev.filter(e => e.stepRunId === group[0]!.id), "phase.started") } : {}),
        ...(eventTime(ev.filter(e => e.stepRunId === step.id), "phase.completed") ? { endedAt: eventTime(ev.filter(e => e.stepRunId === step.id), "phase.completed") } : {}) });
    }
    for (const stage of stages) stage.callIds = calls.filter(c => c.phaseId === stage.id).map(c => c.id);
    const plan = adapters.plan?.(runs[0]!);
    const candidates = adapters.isDeliverable ? data.artifacts.filter(a => adapters.isDeliverable!(a)) : [];
    const candidateIds = new Set(candidates.map(a => a.id));
    const selectedIds = [...new Set(relations.filter(r => r.kind === "selected" && r.validity === "valid" && candidateIds.has(r.to.id)).map(r => r.to.id))];
    const delivery = adapters.isDeliverable ? {
      state: (selectedIds.length > 1 ? "ambiguous" : selectedIds.length === 1 ? "selected" : candidates.length > 1 ? "ambiguous" : candidates.length === 1 ? "unknown" : "missing") as "missing" | "unknown" | "ambiguous" | "selected",
      artifactIds: selectedIds.length ? selectedIds : candidates.map(a => a.id),
    } : undefined;
    return { schemaVersion: 1, rootRunId, cursor: "", runs: runViews, stages, calls, artifacts: safeArtifacts, relations,
      progress: { registered: stages.length, completed: stages.filter(s => s.state === "succeeded").length,
        ...(plan?.planned !== undefined ? { planned: plan.planned } : {}), closed: plan?.closed ?? false }, ...(delivery ? { delivery } : {}), diagnostics };
  }
  async function snapshot(rootRunId: string, prior?: CursorEntry): Promise<{ dto: WorkflowSnapshot; watermarks: Record<string, number>; events: Map<string, WorkflowEvent[]> }> {
    const data = await collect(rootRunId, prior);
    const dto = await project(rootRunId, data);
    for (const call of dto.calls) {
      const attempts = await store.listAttempts(call.stepId);
      const ev = data.events.get(call.runId) ?? [];
      call.attempts = attempts.map(a => {
        const own = ev.filter(e => e.attemptId === a.id);
        const error = a.error ? adapters.error?.(a.id, a.error) : undefined;
        const usage = safeUsage(last(own, "agent.usage") ?? last(own, "agent.completed"));
        return { id: a.id, state: state(a.state), ...(error ? { error } : {}),
          ...(usage ? { usage } : {}),
          ...(eventTime(own, "step.started") ? { startedAt: eventTime(own, "step.started") } : {}),
          ...(eventTime(own, "step.completed") ?? eventTime(own, "step.failed") ? { endedAt: eventTime(own, "step.completed") ?? eventTime(own, "step.failed") } : {}) } satisfies AttemptView;
      });
    }
    return { dto, watermarks: data.watermarks, events: data.events };
  }
  function remember(rootRunId: string, dto: WorkflowSnapshot, watermarks: Record<string, number>, events: Map<string, WorkflowEvent[]>): WorkflowSnapshot {
    const cursor = randomUUID(); dto.cursor = cursor;
    cursors.set(cursor, { rootRunId, snapshot: structuredClone(dto), watermarks, events });
    while (cursors.size > maxCursors) cursors.delete(cursors.keys().next().value!);
    return dto;
  }
  return {
    async getSnapshot({ rootRunId, selectedRunId }) { const { dto, watermarks, events } = await snapshot(rootRunId); if (selectedRunId) { if (!dto.runs.some(r => r.id === selectedRunId)) throw new Error("Selected run outside requested root"); dto.selectedRunId = selectedRunId; } return remember(rootRunId, dto, watermarks, events); },
    async getChanges({ rootRunId, cursor }): Promise<WorkflowChanges> {
      const prior = cursors.get(cursor);
      if (!prior || prior.rootRunId !== rootRunId) return { resetRequired: true };
      // Per-run event watermarks alone cannot see late children or artifact publication.
      // Rescan only descendants of this root, then compare safe DTOs by stable IDs.
      const { dto, watermarks, events } = await snapshot(rootRunId, prior);
      const old = prior.snapshot;
      if (old.selectedRunId && dto.runs.some(r => r.id === old.selectedRunId)) dto.selectedRunId = old.selectedRunId;
      const changed = { ...dto, runs: [] as RunView[], stages: [] as StageView[], calls: [] as CallView[], artifacts: [] as SafeArtifact[], relations: [] as ArtifactRelation[] };
      const removed = { runs: [] as string[], stages: [] as string[], calls: [] as string[], artifacts: [] as string[] };
      for (const key of ["runs", "stages", "calls", "artifacts"] as const) {
        const getId = (item: RunView | StageView | CallView | SafeArtifact) => "identity" in item ? item.identity.id : item.id;
        const previous = new Map(old[key].map(item => [getId(item), JSON.stringify(item)]));
        const current = new Set<string>();
        for (const item of dto[key]) {
          const id = getId(item); current.add(id);
          if (previous.get(id) !== JSON.stringify(item)) (changed[key] as unknown[]).push(item);
        }
        removed[key] = [...previous.keys()].filter(id => !current.has(id));
      }
      // Relations are a small authoritative set. Include the complete set so removal
      // (for example, a hash invalidation) converges without a separate relation ID.
      changed.relations = dto.relations;
      remember(rootRunId, dto, watermarks, events);
      changed.cursor = dto.cursor;
      return { resetRequired: false, cursor: dto.cursor, changed, removed };
    },
    async getStageDetails({ rootRunId, phaseId, cursor, limit = 25 }): Promise<StageDetails> {
      let calls: CallView[], artifacts: SafeArtifact[], offset = 0;
      if (cursor) {
        const page = detailCursors.get(cursor);
        if (!page || page.rootRunId !== rootRunId || page.phaseId !== phaseId) throw new Error("Stage cursor expired or outside requested root");
        ({ calls, artifacts, offset } = page);
      } else {
        const dto = (await snapshot(rootRunId)).dto;
        const stage = dto.stages.find(s => s.id === phaseId);
        if (!stage) throw new Error("Phase outside requested root");
        calls = dto.calls.filter(c => stage.callIds.includes(c.id));
        artifacts = dto.artifacts.filter(a => stage.artifactIds.includes(a.identity.id));
      }
      const page = calls.slice(offset, offset + Math.max(1, Math.min(100, limit)));
      let nextCursor: string | undefined;
      if (offset + page.length < calls.length) {
        nextCursor = randomUUID();
        detailCursors.set(nextCursor, { rootRunId, phaseId, calls, artifacts, offset: offset + page.length });
        while (detailCursors.size > maxCursors) detailCursors.delete(detailCursors.keys().next().value!);
      }
      return { phaseId, calls: page, artifacts, ...(nextCursor ? { nextCursor } : {}) };
    },
  };
}
