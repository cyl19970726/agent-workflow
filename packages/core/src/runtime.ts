import type {
  AgentDefinition, ArtifactDependency, ArtifactRef, MapSettledOptions, ParallelBranches, ParallelOptions,
  ParallelResults, ParallelSettledResults, PhaseArtifactBinding, PhaseContext, PhaseDefinition, StepKind, TaskImplementation,
  ValidationResult, ValidationState, WorkflowContext, WorkflowDefinition, WorkflowTerminal,
} from "./contracts.js";
import { createHash } from "node:crypto";
import { DecisionProtocolError, defineDecision, type DecisionDefinition, type DecisionInput, type DecisionResult, type DecisionRunner } from "./decisions.js";
import type { AgentRunner, ArtifactDraft, ChildWorkflowDispatcher, EventDraft, RunRecord, RunStore, StepRecord, StepResultReceipt } from "./ports.js";

export class WorkflowCanceledError extends Error {
  constructor() { super("Workflow execution was canceled"); this.name = "WorkflowCanceledError"; }
}

/** An atomic store has an unfinished step whose commit outcome must be resolved before replay. */
export class AtomicStepReconciliationRequiredError extends Error {
  constructor(readonly runId: string, readonly stepRunId: string, readonly attemptId: string) {
    super(`Atomic step reconciliation required for run ${runId}, step ${stepRunId}, attempt ${attemptId}`);
    this.name = "AtomicStepReconciliationRequiredError";
  }
}

export interface RunWorkflowOptions<Input, Output> {
  workflow: WorkflowDefinition<Input, Output>;
  input: Input;
  store: RunStore;
  agentRunner: AgentRunner;
  signal?: AbortSignal;
  resumeRunId?: string;
  metadata?: Readonly<Record<string, unknown>>;
  parent?: { runId: string; stepRunId: string };
  childDispatcher?: ChildWorkflowDispatcher;
  decisionRunner?: DecisionRunner;
}

export interface RunWorkflowResult<Output> {
  run: RunRecord;
  output?: Output;
}

type RuntimeSharedState = { pending: Promise<void>[]; producerSteps: WeakMap<object, string[]>; executedKeys: Set<string>;
  asyncDecisionKeys: Set<string>; syncDecisionKeys: Set<string> };
const pendingArtifactBrand: unique symbol = Symbol("pendingArtifact");
type PendingArtifact = { readonly [pendingArtifactBrand]: true; readonly draft: ArtifactDraft };
function pendingArtifact(draft: ArtifactDraft): PendingArtifact { return { [pendingArtifactBrand]: true, draft }; }
function isPendingArtifact(value: unknown): value is PendingArtifact {
  return !!value && typeof value === "object" && pendingArtifactBrand in value;
}

/**
 * Step kinds whose second use of a key in one execution would be answered from the first step's record
 * without running the callback. A phase is fingerprinted by its definition, so a repeated key with the
 * same title silently skips its work (seen in a consumer: a revision was reported as applied but never ran).
 */
const KEYS_UNIQUE_PER_EXECUTION = new Set<StepKind>(["phase", "agent", "task", "workflow", "map", "parallel"]);
type PhaseScope = { phaseId: string; phasePath: readonly string[]; controlStepId: string;
  ownerRunId: string; bindings: PhaseArtifactBinding[] };

export function workflow<Input, Output>(
  id: string,
  options: { revision: string },
  execute: (context: WorkflowContext, input: Input) => Promise<Output>,
): WorkflowDefinition<Input, Output> {
  if (!id || !options.revision) throw new Error("Workflow id and revision are required");
  return Object.freeze({ id, revision: options.revision, execute });
}

export function defineAgent<Input, Output>(definition: AgentDefinition<Input, Output>): AgentDefinition<Input, Output> {
  if (!definition.model || !definition.reasoningEffort) throw new Error("Agent model and reasoningEffort must be explicit");
  return Object.freeze({ ...definition });
}

export async function runWorkflow<Input, Output>(options: RunWorkflowOptions<Input, Output>): Promise<RunWorkflowResult<Output>> {
  const inputFingerprint = workflowFingerprint(options.input);
  const existing = options.resumeRunId ? await options.store.getRun(options.resumeRunId) : undefined;
  if (options.resumeRunId && !existing) throw new Error(`Cannot resume unknown workflow run: ${options.resumeRunId}`);
  if (existing && (existing.workflowId !== options.workflow.id || existing.workflowRevision !== options.workflow.revision || existing.inputFingerprint !== inputFingerprint)) {
    throw new Error("Resume requires the exact workflow revision and input fingerprint");
  }
  const run = existing ?? await options.store.createRun({
    workflowId: options.workflow.id, workflowRevision: options.workflow.revision, inputFingerprint,
    state: "queued", parentRunId: options.parent?.runId, parentStepRunId: options.parent?.stepRunId,
    metadata: options.metadata,
  });
  const signal = options.signal ?? new AbortController().signal;
  await options.store.updateRun(run.id, { state: "running", error: undefined });
  await options.store.appendEvent({ runId: run.id, parentRunId: run.parentRunId, type: "workflow.started" });
  const context = new RuntimeContext(options.store, options.agentRunner, run, signal, options.childDispatcher, options.decisionRunner,
    undefined, inheritedPhaseScope(run.metadata));
  try {
    context.assertActive();
    const output = await options.workflow.execute(context, options.input);
    await context.flush();
    context.assertActive();
    const terminalState = terminalStateOf(output) ?? "succeeded";
    await options.store.updateRun(run.id, { state: terminalState, output });
    await options.store.appendEvent({ runId: run.id, parentRunId: run.parentRunId, type: `workflow.${terminalState === "succeeded" ? "completed" : terminalState}`, data: output });
    return { run: (await options.store.getRun(run.id))!, output };
  } catch (error) {
    if (error instanceof WorkflowSuspendedError) {
      await context.flush();
      await options.store.updateRun(run.id, { state: "waiting", error: undefined });
      await options.store.appendEvent({ runId: run.id, parentRunId: run.parentRunId, type: "workflow.waiting", data: { childRunId: error.childRunId, stepRunId: error.stepRunId } });
      return { run: (await options.store.getRun(run.id))! };
    }
    const canceled = signal.aborted || error instanceof WorkflowCanceledError;
    const state = canceled ? "canceled" : "failed";
    if (canceled) await options.childDispatcher?.cancelChildren?.(run.id, signal.reason);
    await options.store.updateRun(run.id, { state, error: safeError(error) });
    await options.store.appendEvent({ runId: run.id, parentRunId: run.parentRunId, type: canceled ? "workflow.canceled" : "workflow.failed", data: { error: safeError(error) } });
    throw error;
  }
}

class RuntimeContext implements WorkflowContext {
  private readonly shared: RuntimeSharedState;
  constructor(private readonly store: RunStore, private readonly runner: AgentRunner, private readonly run: RunRecord, private readonly signal: AbortSignal,
    private readonly childDispatcher?: ChildWorkflowDispatcher, private readonly decisionRunner?: DecisionRunner, shared?: RuntimeSharedState,
    private readonly phaseScope?: PhaseScope) {
    this.shared = shared ?? { pending: [], producerSteps: new WeakMap<object, string[]>(), executedKeys: new Set<string>(),
      asyncDecisionKeys: new Set<string>(), syncDecisionKeys: new Set<string>() };
  }

  async task<Input, Output>(key: string, implementation: TaskImplementation<Input, Output>, input: Input): Promise<Output> {
    return this.step(key, "task", input, "task:v1", "valid", (execution) => implementation(input, execution));
  }
  async agent<Input, Output>(key: string, definition: AgentDefinition<Input, Output>, input: Input): Promise<Output> {
    const config = workflowFingerprint({ id: definition.id, revision: definition.revision, model: definition.model,
      reasoningEffort: definition.reasoningEffort, promptRevision: definition.promptRevision,
      skillsRevision: definition.skillsRevision, permissionsRevision: definition.permissionsRevision, config: definition.config });
    return this.step(key, "agent", input, config, "pending", async (execution, emit) => {
      const result = await this.runner.run<Input, Output>({ ...execution, definition, input, signal: this.signal, emit, runMetadata: this.executionMetadata() });
      return { value: result.output, validation: result.validation ?? "pending" };
    });
  }
  async call<Input, Output>(key: string, definition: WorkflowDefinition<Input, Output>, input: Input): Promise<Output> {
    if (this.childDispatcher) return this.dispatchChild(key, definition, input);
    return this.step(key, "workflow", input, `${definition.id}:${definition.revision}`, "valid", async (execution) => {
      const child = await runWorkflow({ workflow: definition, input, store: this.store, agentRunner: this.runner,
        decisionRunner: this.decisionRunner,
        signal: this.signal, metadata: this.executionMetadata(), parent: { runId: this.run.id, stepRunId: execution.stepRunId } });
      return child.output as Output;
    });
  }
  private async dispatchChild<Input, Output>(key: string, definition: WorkflowDefinition<Input, Output>, input: Input): Promise<Output> {
    const dispatcher = this.childDispatcher;
    if (!dispatcher) throw new Error("Durable child dispatcher is not configured");
    this.assertActive();
    assertKey(key);
    const stepKey = this.scopedKey(key);
    this.claimKey(stepKey, "workflow");
    const inputFingerprint = workflowFingerprint(input);
    const configFingerprint = `${definition.id}:${definition.revision}:durable-child-v1`;
    const matches = (await this.store.listSteps(this.run.id)).filter((step) => step.key === stepKey && step.kind === "workflow"
      && step.workflowId === this.run.workflowId && step.workflowRevision === this.run.workflowRevision
      && step.inputFingerprint === inputFingerprint && step.configFingerprint === configFingerprint);
    const reusable = [...matches].reverse().find((step) => step.state === "succeeded" && step.validation === "valid");
    if (reusable) {
      await this.store.appendEvent({ runId: this.run.id, stepRunId: reusable.id, type: "step.reused" });
      return reusable.output as Output;
    }
    let step = [...matches].reverse().find((item) => ["waiting", "running", "failed", "canceled", "needs_review"].includes(item.state));
    let attemptId: string;
    if (!step) {
      step = await this.store.createStep({ runId: this.run.id, key: stepKey, kind: "workflow", workflowId: this.run.workflowId,
        workflowRevision: this.run.workflowRevision, inputFingerprint, configFingerprint, state: "running", validation: "pending",
        ...this.phaseRecord() });
      const attempt = await this.store.createAttempt({ runId: this.run.id, stepRunId: step.id, state: "running" });
      attemptId = attempt.id;
      await this.store.appendEvent({ runId: this.run.id, stepRunId: step.id, attemptId, type: "step.started" });
    } else if (step.state === "waiting" || step.state === "running") {
      attemptId = (await this.store.listAttempts(step.id)).at(-1)?.id ?? (await this.store.createAttempt({ runId: this.run.id, stepRunId: step.id, state: "running" })).id;
    } else {
      const attempt = await this.store.createAttempt({ runId: this.run.id, stepRunId: step.id, state: "running" });
      attemptId = attempt.id;
      await this.store.updateStep(step.id, { state: "running", error: undefined });
      await this.store.appendEvent({ runId: this.run.id, stepRunId: step.id, attemptId, type: "step.started", data: { retry: true } });
    }
    const activeStep = step!;
    const child = await dispatcher.ensureChild<Input, Output>({ parentRunId: this.run.id, parentStepRunId: activeStep.id,
      key: stepKey, definition: { id: definition.id, revision: definition.revision }, input, metadata: this.executionMetadata() });
    if (child.state === "queued" || child.state === "running" || child.state === "waiting") {
      await this.store.updateStep(activeStep.id, { state: "waiting" });
      await this.store.updateAttempt(attemptId, { state: "waiting" });
      throw new WorkflowSuspendedError(child.childRunId, activeStep.id);
    }
    if (child.state === "failed" || child.state === "canceled") {
      const error = child.error ?? `Child workflow ${child.childRunId} ${child.state}`;
      await this.store.updateStep(activeStep.id, { state: child.state, error });
      await this.store.updateAttempt(attemptId, { state: child.state, error });
      throw new Error(error);
    }
    await this.store.updateStep(activeStep.id, { state: "succeeded", validation: "valid", output: child.output });
    await this.store.updateAttempt(attemptId, { state: "succeeded" });
    await this.store.appendEvent({ runId: this.run.id, stepRunId: activeStep.id, attemptId, type: "step.completed", data: { childRunId: child.childRunId, childState: child.state } });
    return child.output as Output;
  }
  async mapSettled<Input, Output>(key: string, inputs: readonly Input[], options: MapSettledOptions<Input>, callback: (input: Input, index: number) => Promise<Output>): Promise<PromiseSettledResult<Output>[]> {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("mapSettled concurrency must be a positive integer");
    const itemKeys = inputs.map(options.itemKey);
    if (new Set(itemKeys).size !== itemKeys.length || itemKeys.some((itemKey) => !itemKey)) throw new Error("mapSettled item keys must be stable, non-empty, and unique");
    return this.step(key, "map", { inputs, itemKeys }, `map:${options.concurrency}`, "valid", async () => {
      const results: PromiseSettledResult<Output>[] = new Array(inputs.length);
      const suspensions: WorkflowSuspendedError[] = [];
      let cancellation: WorkflowCanceledError | undefined;
      let cursor = 0;
      const worker = async () => {
        while (cursor < inputs.length) {
          const index = cursor++;
          try { results[index] = { status: "fulfilled", value: await callback(inputs[index]!, index) }; }
          catch (error) {
            if (error instanceof WorkflowSuspendedError) suspensions.push(error);
            else if (error instanceof WorkflowCanceledError || this.signal.aborted) { cancellation = new WorkflowCanceledError(); cursor = inputs.length; }
            else results[index] = { status: "rejected", reason: safeError(error) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(options.concurrency, inputs.length) }, worker));
      if (cancellation) throw cancellation;
      if (suspensions.length) throw suspensions[0]!;
      return { value: results, validation: results.some((result) => result.status === "rejected") ? "invalid" : "valid" };
    });
  }
  async parallel<Branches extends ParallelBranches>(key: string, branches: Branches,
    options: ParallelOptions): Promise<ParallelResults<Branches>> {
    const settled = await this.parallelSettled(key, branches, options);
    const failures = Object.entries(settled).filter((entry) => entry[1].status === "rejected");
    if (failures.length) throw new Error(`Parallel group ${key} failed: ${failures
      .map(([name, result]) => `${name}: ${(result as PromiseRejectedResult).reason}`).join("; ")}`);
    return Object.fromEntries(Object.entries(settled).map(([name, result]) =>
      [name, (result as PromiseFulfilledResult<unknown>).value])) as ParallelResults<Branches>;
  }
  async parallelSettled<Branches extends ParallelBranches>(key: string, branches: Branches,
    options: ParallelOptions): Promise<ParallelSettledResults<Branches>> {
    assertKey(key);
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("parallel concurrency must be a positive integer");
    }
    const names = Object.keys(branches).sort();
    if (!names.length) throw new Error("parallel branches must not be empty");
    for (const name of names) assertKey(name);
    const results: Record<string, PromiseSettledResult<unknown>> = {};
    const suspensions: WorkflowSuspendedError[] = [];
    let cancellation: WorkflowCanceledError | undefined;
    let cursor = 0;
    const worker = async () => {
      while (cursor < names.length && !cancellation) {
        const name = names[cursor++]!;
        try {
          const value = await this.step(`${key}:${name}`, "parallel", { group: key, branch: name },
            `parallel:v1`, "valid", () => branches[name]!());
          results[name] = { status: "fulfilled", value };
        } catch (error) {
          if (error instanceof WorkflowSuspendedError) {
            suspensions.push(error);
            // A durable child still occupies this branch's concurrency slot. Do not dispatch another branch on this worker.
            return;
          }
          if (error instanceof WorkflowCanceledError || this.signal.aborted) {
            cancellation = new WorkflowCanceledError();
            return;
          }
          results[name] = { status: "rejected", reason: safeError(error) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, names.length) }, worker));
    if (cancellation) throw cancellation;
    if (suspensions.length) throw suspensions[0]!;
    return results as ParallelSettledResults<Branches>;
  }
  async phase<Output>(key: string, definition: PhaseDefinition,
    execute: (context: PhaseContext) => Output | Promise<Output>): Promise<Output> {
    assertKey(key);
    assertPhaseDefinition(definition);
    const phasePath = [...(this.phaseScope?.phasePath ?? []), key];
    const phaseId = `phase:${this.run.id}:${phasePath.map(encodeURIComponent).join("/")}`;
    return this.step(key, "phase", definition, `phase:v1:${workflowFingerprint(definition)}`, "valid",
      async (execution) => {
        const scope: PhaseScope = { phaseId, phasePath, controlStepId: execution.stepRunId, ownerRunId: this.run.id, bindings: [] };
        const context = new RuntimeContext(this.store, this.runner, this.run, this.signal, this.childDispatcher, this.decisionRunner, this.shared, scope);
        return execute(context as PhaseContext);
      }, false, { phaseId, phasePath, phaseDefinition: canonicalWorkflowValue(definition) });
  }
  get phaseId(): string {
    if (!this.phaseScope) throw new Error("phaseId is only available inside ctx.phase");
    return this.phaseScope.phaseId;
  }
  get phasePath(): readonly string[] {
    if (!this.phaseScope) throw new Error("phasePath is only available inside ctx.phase");
    return this.phaseScope.phasePath;
  }
  async bindArtifact(artifact: ArtifactRef, binding: Omit<PhaseArtifactBinding, "artifact">): Promise<void> {
    const scope = this.phaseScope;
    if (!scope) throw new Error("bindArtifact is only available inside ctx.phase");
    if (scope.ownerRunId !== this.run.id) throw new Error("Inherited child phase context cannot bind its parent phase; create a child phase first");
    if (!binding.role?.trim()) throw new Error("Phase artifact binding role is required");
    const persisted = await this.store.getArtifact(artifact.id);
    if (!persisted || persisted.sha256 !== artifact.sha256 || persisted.revision !== artifact.revision) {
      throw new Error("Phase artifact binding must reference an existing exact artifact revision");
    }
    const value: PhaseArtifactBinding = { artifact: persisted, ...binding };
    const index = scope.bindings.findIndex((item) => item.artifact.id === artifact.id && item.role === binding.role);
    if (index >= 0) scope.bindings[index] = value;
    else scope.bindings.push(value);
    await this.store.updateStep(scope.controlStepId, { artifactBindings: canonicalWorkflowValue(scope.bindings) });
    await this.store.appendEvent({ runId: this.run.id, stepRunId: scope.controlStepId, type: "phase.artifact_bound",
      data: { phaseId: scope.phaseId, phasePath: scope.phasePath, binding: value } });
  }
  async decision(key: string, definition: DecisionDefinition, input: DecisionInput): Promise<DecisionResult> {
    this.assertActive();
    assertKey(key);
    const stepKey = this.scopedKey(key);
    if (this.shared.syncDecisionKeys.has(stepKey) || this.shared.asyncDecisionKeys.has(stepKey)) {
      throw new Error(`Decision key "${stepKey}" was already used in this execution`);
    }
    const normalized = defineDecision(definition);
    const snapshot = snapshotDecisionInput(input);
    const runner = this.decisionRunner;
    if (!runner) throw new Error("Decision runner is not configured");
    if (runner.provider !== normalized.provider || !runner.revision?.trim()) {
      throw new Error(`Decision runner provider/revision mismatch: expected ${normalized.provider}`);
    }
    const inputFingerprint = workflowFingerprint(snapshot);
    const configFingerprint = workflowFingerprint({ definition: normalized, runner: { provider: runner.provider, revision: runner.revision } });
    this.shared.asyncDecisionKeys.add(stepKey);
    try {
      return await this.step(key, "decision", snapshot, configFingerprint, "valid", async (execution, emit) => {
        const idempotencyKey = `${execution.idempotencyKey}:${inputFingerprint}:${configFingerprint}`;
        const eventInput = { text: snapshot.text, images: snapshot.images?.map(({ sha256, label, detail }) => ({ sha256, label, detail })),
          evidenceRefs: snapshot.evidenceRefs };
        await emit("decision.inference.started", { definition: normalized, input: eventInput,
          runner: { provider: runner.provider, revision: runner.revision }, inputFingerprint, configFingerprint });
        let lastError: unknown;
        for (let attempt = 0; attempt <= (normalized.maxRetries ?? 0); attempt++) {
          try {
            const result = await runDecisionWithTimeout(runner, { ...execution, idempotencyKey,
              definition: normalized, input: snapshot, signal: this.signal, emit, runMetadata: this.executionMetadata() }, normalized.timeoutMs);
            validateDecisionResult(normalized, result);
            const validated = copyDecisionResult(result);
            await emit("decision.inference.completed", validated);
            return validated;
          } catch (error) {
            if (this.signal.aborted || error instanceof WorkflowCanceledError) throw error;
            lastError = error;
            if (error instanceof DecisionProtocolError || error instanceof DecisionRunnerFailure && !error.retryable
              || attempt === (normalized.maxRetries ?? 0)) break;
            await emit("decision.inference.retrying", { attempt: attempt + 1, error: safeError(error) });
          }
        }
        await emit("decision.inference.failed", { error: safeError(lastError) });
        throw lastError;
      });
    } catch (error) {
      this.shared.asyncDecisionKeys.delete(stepKey);
      throw error;
    }
  }
  decide<Value>(key: string, decision: Value): Value {
    assertKey(key);
    const stepKey = this.scopedKey(key);
    if (this.shared.asyncDecisionKeys.has(stepKey)) throw new Error(`Decision key "${stepKey}" was already used for async inference`);
    this.shared.syncDecisionKeys.add(stepKey);
    this.shared.pending.push(this.recordDecision(key, decision));
    return decision;
  }
  async validate<Value>(key: string, artifact: Value, validator: (artifact: Value) => ValidationResult | Promise<ValidationResult>, options: { producerStepKey?: string } = {}): Promise<ValidationResult> {
    return this.step(key, "validation", artifact, "validation:v1", "valid", async (_execution, emit) => {
      const result = await validator(artifact);
      await this.markProducerValidation(artifact, result.valid ? "valid" : "invalid", options.producerStepKey);
      await emit("validation.completed", result);
      return { value: result, validation: result.valid ? "valid" : "invalid" };
    }, true);
  }
  async publish(key: string, artifactType: string, payload: unknown, provenance: { schemaVersion?: string; revision?: string; dependsOn?: ArtifactDependency[]; validation?: ValidationState; review?: ArtifactRef["review"] } = {}): Promise<ArtifactRef> {
    return this.step(key, "publish", { artifactType, payload, provenance }, "publish:v1", provenance.validation ?? "pending", async (execution, emit) => {
      const digest = await artifactPayloadSha256(payload);
      const draft: ArtifactDraft = { type: artifactType, schemaVersion: provenance.schemaVersion ?? "v1",
        revision: provenance.revision ?? digest, sha256: digest, uri: `workflow-artifact://${this.run.id}/${execution.stepRunId}/${digest}`,
        payload, producedBy: { workflowRunId: this.run.id, stepRunId: execution.stepRunId, attemptId: execution.attemptId },
        dependsOn: provenance.dependsOn ?? [], validation: provenance.validation ?? "pending", review: provenance.review ?? "pending" };
      if (this.store.commitStepResult) {
        return { value: pendingArtifact(draft) as unknown as ArtifactRef, validation: draft.validation };
      }
      const artifact = await this.store.publishArtifact(draft);
      await emit("artifact.published", artifact);
      return { value: artifact, validation: artifact.validation };
    });
  }
  blocked(details: unknown): WorkflowTerminal<never> { return { ok: false, state: "blocked", details }; }
  needsReview(details: unknown): WorkflowTerminal<never> { return { ok: false, state: "needs_review", details }; }
  assertActive(): void { if (this.signal.aborted) throw new WorkflowCanceledError(); }
  async flush(): Promise<void> { await Promise.all(this.shared.pending); }

  private async recordDecision(key: string, decision: unknown): Promise<void> {
    await this.step(key, "decision", decision, "decision:v1", "valid", async (_execution, emit) => {
      await emit("decision.recorded", decision); return decision;
    });
  }
  private async step<Input, Output>(key: string, kind: StepKind, input: Input, configFingerprint: string,
    defaultValidation: ValidationState, execute: (context: { signal: AbortSignal; idempotencyKey: string; runId: string; stepRunId: string; attemptId: string }, emit: (type: string, data?: unknown) => Promise<void>) => Promise<Output | { value: Output; validation: ValidationState }> | Output | { value: Output; validation: ValidationState },
    reuseInvalidOutput = false, recordMetadata: Partial<Pick<StepRecord, "phaseId" | "phasePath" | "phaseDefinition">> = {}): Promise<Output> {
    this.assertActive();
    assertKey(key);
    const stepKey = this.scopedKey(key);
    this.claimKey(stepKey, kind);
    const inputFingerprint = workflowFingerprint(input);
    const query = { runId: this.run.id, workflowId: this.run.workflowId, workflowRevision: this.run.workflowRevision,
      key: stepKey, kind, inputFingerprint, configFingerprint };
    const reusable = await this.store.findReusableStep(query);
    if (reusable) {
      await this.store.appendEvent({ runId: this.run.id, stepRunId: reusable.id, type: "step.reused" });
      if (kind === "agent") this.rememberProducer(reusable.output, reusable.id);
      if (kind === "validation" && isValidationResult(reusable.output)) {
        await this.markProducerValidation(input, reusable.output.valid ? "valid" : "invalid");
      }
      return reusable.output as Output;
    }
    await this.closeStaleAttempts(stepKey);
    const step = await this.store.createStep({ ...query, state: "running", validation: defaultValidation,
      ...this.phaseRecord(), ...recordMetadata });
    const attempt = await this.store.createAttempt({ runId: this.run.id, stepRunId: step.id, state: "running" });
    const emit = async (type: string, data?: unknown) => { await this.store.appendEvent({ runId: this.run.id, stepRunId: step.id, attemptId: attempt.id, type, data }); };
    await emit("step.started");
    if (kind === "phase") await emit("phase.started", { phaseId: step.phaseId, phasePath: step.phasePath, definition: step.phaseDefinition });
    let atomicCommitAttempted = false;
    let expectedCommit: { state: StepRecord["state"]; validation: ValidationState } | undefined;
    try {
      this.assertActive();
      const raw = await execute({ signal: this.signal, idempotencyKey: `${this.run.id}:${stepKey}`, runId: this.run.id, stepRunId: step.id, attemptId: attempt.id }, emit);
      this.assertActive();
      const wrapped = isStepOutput<Output>(raw) ? raw : { value: raw, validation: defaultValidation };
      const phaseTerminal = kind === "phase" ? terminalStateOf(wrapped.value) : undefined;
      const state = phaseTerminal ?? (wrapped.validation === "invalid" && !reuseInvalidOutput ? "needs_review" : "succeeded");
      if (this.store.commitStepResult) {
        const completionEvents: EventDraft[] = [{ runId: this.run.id, stepRunId: step.id, attemptId: attempt.id,
          type: "step.completed", data: { validation: wrapped.validation } }];
        if (kind === "phase") completionEvents.push({ runId: this.run.id, stepRunId: step.id, attemptId: attempt.id,
          type: `phase.${state === "succeeded" ? "completed" : state}`,
          data: { phaseId: step.phaseId, phasePath: step.phasePath, state } });
        const pending = isPendingArtifact(wrapped.value) ? wrapped.value : undefined;
        this.assertActive();
        expectedCommit = { state, validation: wrapped.validation };
        atomicCommitAttempted = true;
        const receipt = await this.store.commitStepResult({ stepRunId: step.id, attemptId: attempt.id,
          idempotencyKey: `${this.run.id}:${step.id}:${attempt.id}:completion`, state, validation: wrapped.validation,
          ...(pending ? { artifact: pending.draft } : { output: wrapped.value }), events: completionEvents });
        const output = pending ? receipt.artifact ?? receipt.output : receipt.output;
        if (pending && (!output || typeof output !== "object" || !("id" in output))) {
          throw new Error("Atomic artifact commit did not return an artifact reference");
        }
        if (kind === "agent") this.rememberProducer(output, step.id);
        return output as Output;
      }
      await this.store.updateStep(step.id, { state, validation: wrapped.validation, output: wrapped.value });
      await this.store.updateAttempt(attempt.id, { state });
      await emit("step.completed", { validation: wrapped.validation });
      if (kind === "phase") await emit(`phase.${state === "succeeded" ? "completed" : state}`,
        { phaseId: step.phaseId, phasePath: step.phasePath, state });
      if (kind === "agent") this.rememberProducer(wrapped.value, step.id);
      return wrapped.value;
    } catch (error) {
      // A harness may lose the durable acknowledgement after observing a model result.
      // Preserve the live attempt so resume must reconcile before invoking it again.
      if (error instanceof AtomicStepReconciliationRequiredError) throw error;
      if (atomicCommitAttempted) {
        const committed = await this.reconcileCommittedStep(step.id, attempt.id, expectedCommit!);
        if (committed) {
          if (kind === "agent") this.rememberProducer(committed.output, step.id);
          return committed.output as Output;
        }
        // The commit outcome is uncertain. Do not turn a possibly committed result into a failed step.
        throw error;
      }
      if (error instanceof WorkflowSuspendedError) {
        await this.store.updateStep(step.id, { state: "waiting" });
        await this.store.updateAttempt(attempt.id, { state: "waiting" });
        await emit("step.waiting", { childRunId: error.childRunId });
        if (kind === "phase") await emit("phase.waiting", { phaseId: step.phaseId, phasePath: step.phasePath,
          childRunId: error.childRunId });
        throw error;
      }
      const state = this.signal.aborted ? "canceled" : "failed";
      this.shared.executedKeys.delete(`${kind}:${stepKey}`);
      await this.store.updateStep(step.id, { state, error: safeError(error) });
      await this.store.updateAttempt(attempt.id, { state, error: safeError(error) });
      await emit("step.failed", { error: safeError(error) });
      if (kind === "phase") await emit(state === "canceled" ? "phase.canceled" : "phase.failed",
        { phaseId: step.phaseId, phasePath: step.phasePath, error: safeError(error) });
      throw error;
    }
  }
  private async reconcileCommittedStep(stepRunId: string, attemptId: string,
    expected: { state: StepRecord["state"]; validation: ValidationState }): Promise<StepResultReceipt | undefined> {
    try {
      const step = (await this.store.listSteps(this.run.id)).find((item) => item.id === stepRunId);
      const attempt = (await this.store.listAttempts(stepRunId)).find((item) => item.id === attemptId);
      if (!step || !attempt || step.state !== expected.state || step.validation !== expected.validation
        || attempt.state !== expected.state) return undefined;
      return { output: step.output };
    } catch {
      return undefined;
    }
  }
  private async closeStaleAttempts(key: string): Promise<void> {
    const steps = await this.store.listSteps(this.run.id);
    for (const step of steps.filter((item) => item.key === key && item.state === "running")) {
      const attempts = await this.store.listAttempts(step.id);
      if (this.store.commitStepResult) {
        const unresolved = attempts.find((attempt) => attempt.state === "running") ?? attempts.at(-1);
        throw new AtomicStepReconciliationRequiredError(this.run.id, step.id, unresolved?.id ?? "<missing>");
      }
      for (const attempt of attempts) {
        if (attempt.state === "running") await this.store.updateAttempt(attempt.id, { state: "failed", error: "Interrupted before resume" });
      }
      await this.store.updateStep(step.id, { state: "failed", error: "Interrupted before resume" });
    }
  }
  private rememberProducer(output: unknown, stepId: string): void {
    if (!isObject(output)) return;
    const steps = this.shared.producerSteps.get(output) ?? [];
    if (!steps.includes(stepId)) steps.push(stepId);
    this.shared.producerSteps.set(output, steps);
  }
  private async markProducerValidation(output: unknown, validation: ValidationState, producerStepKey?: string): Promise<void> {
    const identityMatches = isObject(output) ? this.shared.producerSteps.get(output) ?? [] : [];
    const explicitMatches = producerStepKey
      ? (await this.store.listSteps(this.run.id)).filter((step) => step.key === this.scopedKey(producerStepKey) && step.kind === "agent").map((step) => step.id)
      : [];
    for (const stepId of new Set([...identityMatches, ...explicitMatches])) {
      await this.store.updateStep(stepId, { validation });
    }
  }
  private phaseRecord(): Partial<Pick<StepRecord, "phaseId" | "phasePath">> {
    return this.phaseScope ? { phaseId: this.phaseScope.phaseId, phasePath: this.phaseScope.phasePath } : {};
  }
  private claimKey(stepKey: string, kind: StepKind): void {
    if (!KEYS_UNIQUE_PER_EXECUTION.has(kind)) return;
    const claim = `${kind}:${stepKey}`;
    if (this.shared.executedKeys.has(claim)) {
      throw new Error(`Step key "${stepKey}" (${kind}) was already used in this execution. Keys must be unique within a run; `
        + "a repeated key would return the earlier step's result without running this one.");
    }
    this.shared.executedKeys.add(claim);
  }
  private scopedKey(key: string): string {
    return this.phaseScope ? [...this.phaseScope.phasePath, key].join(":") : key;
  }
  private executionMetadata(): Readonly<Record<string, unknown>> | undefined {
    if (!this.phaseScope) return this.run.metadata;
    return { ...this.run.metadata, phaseId: this.phaseScope.phaseId, phasePath: this.phaseScope.phasePath,
      phaseControlStepId: this.phaseScope.controlStepId, phaseOwnerRunId: this.phaseScope.ownerRunId };
  }
}

class WorkflowSuspendedError extends Error {
  constructor(readonly childRunId: string, readonly stepRunId: string) { super("Workflow is waiting for a durable child"); }
}

function terminalStateOf(value: unknown): "blocked" | "needs_review" | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = (value as { state?: unknown }).state;
  return state === "blocked" || state === "needs_review" ? state : undefined;
}
function isStepOutput<T>(value: unknown): value is { value: T; validation: ValidationState } {
  return !!value && typeof value === "object" && "value" in value && "validation" in value;
}
function isValidationResult(value: unknown): value is ValidationResult {
  return isObject(value) && typeof (value as { valid?: unknown }).valid === "boolean";
}
function isObject(value: unknown): value is object { return typeof value === "object" && value !== null; }
function assertKey(key: string): void {
  if (!key || key.trim() !== key || /[\0\n\r]/u.test(key)) throw new Error("Step key must be a stable, non-empty explicit string");
}
function assertPhaseDefinition(definition: PhaseDefinition): void {
  if (!definition.title?.trim() || !definition.purpose?.trim()) throw new Error("Phase title and purpose are required");
  if (definition.order !== undefined && !Number.isFinite(definition.order)) throw new Error("Phase order must be finite");
  for (const expected of definition.expectedArtifacts ?? []) {
    if (!expected.role?.trim()) throw new Error("Expected phase artifact role is required");
  }
}
function inheritedPhaseScope(metadata: Readonly<Record<string, unknown>> | undefined): PhaseScope | undefined {
  if (typeof metadata?.phaseId !== "string" || !Array.isArray(metadata.phasePath)
    || !metadata.phasePath.every((item) => typeof item === "string") || typeof metadata.phaseControlStepId !== "string"
    || typeof metadata.phaseOwnerRunId !== "string") return undefined;
  return { phaseId: metadata.phaseId, phasePath: metadata.phasePath as string[],
    controlStepId: metadata.phaseControlStepId, ownerRunId: metadata.phaseOwnerRunId, bindings: [] };
}
function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
class DecisionRunnerFailure extends Error {
  constructor(readonly retryable: boolean, status?: number, errorType?: string) {
    super(`Decision runner failed${errorType ? ` (${errorType})` : ""}${status ? `, HTTP ${status}` : ""}`);
    this.name = "DecisionRunnerFailure";
  }
}
function sanitizeDecisionRunnerError(error: unknown): DecisionRunnerFailure {
  const value = error && typeof error === "object" ? error as { status?: unknown; errorType?: unknown } : {};
  const status = Number.isSafeInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599
    ? Number(value.status) : undefined;
  const allowed = ["APIError", "BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError",
    "ConflictError", "UnprocessableEntityError", "RateLimitError", "InternalServerError", "APIConnectionError",
    "APIConnectionTimeoutError", "APIUserAbortError", "AbortError", "TypeError", "UnknownError"];
  const errorType = typeof value.errorType === "string" && allowed.includes(value.errorType) ? value.errorType : undefined;
  const nonRetryable = status !== undefined && status >= 400 && status < 500 && ![408, 409, 429].includes(status)
    || ["BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError", "UnprocessableEntityError"].includes(errorType ?? "");
  return new DecisionRunnerFailure(!nonRetryable, status, errorType);
}
function snapshotDecisionInput(input: DecisionInput): DecisionInput {
  if (!input || typeof input.text !== "string" || (input.images !== undefined && !Array.isArray(input.images))
    || (input.evidenceRefs !== undefined && !Array.isArray(input.evidenceRefs))) {
    throw new Error("Decision input requires text and optional image/ref arrays");
  }
  const images = input.images?.map((image) => Object.freeze({ dataUrl: image.dataUrl, sha256: image.sha256,
    label: image.label, detail: image.detail }));
  const evidenceRefs = input.evidenceRefs?.map((ref) => Object.freeze({ artifactId: ref.artifactId,
    revision: ref.revision, sha256: ref.sha256 }));
  const snapshot = Object.freeze({ text: input.text, images: images && Object.freeze(images),
    evidenceRefs: evidenceRefs && Object.freeze(evidenceRefs) });
  validateDecisionInput(snapshot);
  return snapshot;
}
function validateDecisionInput(input: DecisionInput): void {
  if (!input || typeof input.text !== "string") throw new Error("Decision input text is required");
  for (const image of input.images ?? []) {
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(image.dataUrl);
    if (!match || !/^[a-f0-9]{64}$/u.test(image.sha256)) throw new Error("Decision images require inline data URLs and SHA-256");
    const bytes = Buffer.from(match[1]!, "base64");
    if (!bytes.length || bytes.toString("base64") !== match[1] || createHash("sha256").update(bytes).digest("hex") !== image.sha256) {
      throw new Error("Decision image SHA-256 does not match inline bytes");
    }
  }
  for (const ref of input.evidenceRefs ?? []) {
    if (!ref.artifactId?.trim() || !ref.revision?.trim() || !/^[a-f0-9]{64}$/u.test(ref.sha256)) {
      throw new Error("Decision evidence refs require artifactId, revision and SHA-256");
    }
  }
}
function validProbability(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function sameChoice(a: string | boolean, b: string | boolean): boolean { return typeof a === typeof b && a === b; }
function validateDecisionResult(definition: DecisionDefinition, result: DecisionResult): void {
  if (!result || result.provider !== definition.provider || result.model !== definition.model || !Array.isArray(result.answers)
    || result.answers.length !== definition.questions.length) throw new DecisionProtocolError("provider, model or answer count mismatch");
  const questions = new Map(definition.questions.map((question) => [question.name, question]));
  const seen = new Set<string>();
  for (const answer of result.answers) {
    const question = questions.get(answer?.name);
    if (!question || seen.has(answer.name)) throw new DecisionProtocolError("missing, duplicate or unknown question name");
    seen.add(answer.name);
    if (answer.type === "refusal") continue;
    if (answer.type !== question.type) throw new DecisionProtocolError(`answer type mismatch for ${answer.name}`);
    if (answer.type === "predicate") {
      if (!validProbability(answer.probability)) throw new DecisionProtocolError(`invalid predicate probability for ${answer.name}`);
    } else if (answer.type === "choice" && question.type === "choice") {
      if (!validProbability(answer.confidence) || !question.choices.some((choice) => sameChoice(choice.value, answer.choice))
        || !Array.isArray(answer.probabilities) || answer.probabilities.length !== question.choices.length) {
        throw new DecisionProtocolError(`invalid choice answer for ${answer.name}`);
      }
      const values = new Set<string>();
      for (const probability of answer.probabilities) {
        if (!probability || typeof probability !== "object") throw new DecisionProtocolError(`invalid choice probability for ${answer.name}`);
        const key = `${typeof probability.value}:${probability.value}`;
        if (values.has(key) || !question.choices.some((choice) => sameChoice(choice.value, probability.value))
          || !validProbability(probability.probability)) throw new DecisionProtocolError(`invalid choice probability for ${answer.name}`);
        values.add(key);
      }
      if (Math.abs(answer.probabilities.reduce((sum: number, item: { probability: number }) => sum + item.probability, 0) - 1) > 0.01) {
        throw new DecisionProtocolError(`choice probabilities do not sum to one for ${answer.name}`);
      }
    } else if (answer.type === "score" && question.type === "score") {
      if (!validProbability(answer.confidence) || !Number.isFinite(answer.score)
        || !Array.isArray(answer.probabilities) || answer.probabilities.length !== question.levels.length) {
        throw new DecisionProtocolError(`invalid score answer for ${answer.name}`);
      }
      const labels = new Set<string>();
      for (const probability of answer.probabilities) {
        if (!probability || typeof probability !== "object") throw new DecisionProtocolError(`invalid score probability for ${answer.name}`);
        if (labels.has(probability.label) || !question.levels.some((level) => level.label === probability.label)
          || !Number.isFinite(probability.value) || !validProbability(probability.probability)) {
          throw new DecisionProtocolError(`invalid score probability for ${answer.name}`);
        }
        labels.add(probability.label);
      }
      const values = answer.probabilities.map((item: { value: number }) => item.value);
      if (answer.score < Math.min(...values) - 1e-9 || answer.score > Math.max(...values) + 1e-9) {
        throw new DecisionProtocolError(`score is outside its level values for ${answer.name}`);
      }
      if (Math.abs(answer.probabilities.reduce((sum: number, item: { probability: number }) => sum + item.probability, 0) - 1) > 0.01) {
        throw new DecisionProtocolError(`score probabilities do not sum to one for ${answer.name}`);
      }
    }
  }
  if (result.usage && (![result.usage.inputTokens, result.usage.outputTokens, result.usage.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
    || result.usage.totalTokens < result.usage.inputTokens + result.usage.outputTokens)) {
    throw new DecisionProtocolError("invalid usage");
  }
}
function copyDecisionResult(result: DecisionResult): DecisionResult {
  return { provider: result.provider, model: result.model,
    answers: result.answers.map((answer) => {
      if (answer.type === "refusal") return { type: "refusal", name: answer.name };
      if (answer.type === "predicate") return { type: "predicate", name: answer.name, probability: answer.probability };
      if (answer.type === "choice") return { type: "choice", name: answer.name, choice: answer.choice,
        confidence: answer.confidence, probabilities: answer.probabilities.map(({ value, probability }) => ({ value, probability })) };
      return { type: "score", name: answer.name, score: answer.score, confidence: answer.confidence,
        probabilities: answer.probabilities.map(({ label, value, probability }) => ({ label, value, probability })) };
    }), usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens } : undefined, requestId: result.requestId };
}
async function runDecisionWithTimeout(runner: DecisionRunner, request: import("./decisions.js").DecisionRunRequest,
  timeoutMs: number): Promise<DecisionResult> {
  if (request.signal.aborted) throw new WorkflowCanceledError();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  let rejectAbort!: (reason: unknown) => void;
  let active = true;
  const pendingEmits = new Set<Promise<void>>();
  const emit = (type: string, data?: unknown): Promise<void> => {
    if (!active) return Promise.resolve();
    const write = request.emit(type, data);
    pendingEmits.add(write);
    void write.finally(() => pendingEmits.delete(write)).catch(() => {});
    return write;
  };
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onParentAbort = () => { active = false; controller.abort(request.signal.reason); rejectAbort(new WorkflowCanceledError()); };
  request.signal.addEventListener("abort", onParentAbort, { once: true });
  if (request.signal.aborted) onParentAbort();
  timeout = setTimeout(() => { active = false; controller.abort(new Error("Decision inference timed out"));
    rejectAbort(new Error("Decision inference timed out")); }, timeoutMs);
  try {
    const invocation = Promise.resolve().then(() => {
      if (request.signal.aborted || controller.signal.aborted) throw new WorkflowCanceledError();
      return runner.run({ ...request, signal: controller.signal, emit });
    }).catch((error: unknown) => {
      if (error instanceof WorkflowCanceledError && request.signal.aborted) throw error;
      throw error instanceof DecisionProtocolError ? new DecisionProtocolError() : sanitizeDecisionRunnerError(error);
    });
    return await Promise.race([invocation, aborted]);
  } finally {
    active = false;
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onParentAbort);
    await Promise.allSettled(pendingEmits);
  }
}
export function workflowFingerprint(value: unknown): string {
  const text = stableStringify(canonicalWorkflowValue(value));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) { hash ^= BigInt(text.charCodeAt(index)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
/** Value that crosses a JSON persistence boundary; object `undefined` fields are omitted and array holes become null. */
export function canonicalWorkflowValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? null : JSON.parse(serialized)) as T;
}
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}
/** Canonical artifact digest shared by runtimes and persistent stores. */
export async function artifactPayloadSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(canonicalWorkflowValue(value)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
