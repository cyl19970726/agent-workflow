import type { ProcessDecisionBinding } from './types.js';
import type { ProcessContract } from './process-contract.js';
import { AtomicStepReconciliationRequiredError, artifactPayloadSha256 } from '@signal-room/workflow';
import type {
  AgentRunRequest, AgentRunResult, AgentRunner, ArtifactDraft, ArtifactRef, AttemptRecord, EventDraft,
  RunRecord, RunStore, StepRecord, StepResultCommit, StepResultReceipt, WorkflowEvent, ValidationState,
} from '@signal-room/workflow';
import type { AssetVersion, InputManifest, NodeCommit, NodeContext, NodeStart, NodeOccurrenceAnnotation, NodeRelationWrite } from './types.js';
import { InvalidObservedOutputError } from './errors.js';

export interface SpaceRuntimeBinding {
  workflowVersionId: string;
  entrypoint: string;
  inputManifestId: string;
}

/** Only trusted host code receives this service. Runtime nodes receive their restricted NodeClient. */
export interface SpaceRuntimeService {
  commitRuntimeDecision?(spaceId:string,commit:StepResultCommit,binding:ProcessDecisionBinding):Promise<StepResultReceipt>;
  runtimeLedger(spaceId: string): Promise<RunStore>;
  bindRuntimeRun(spaceId: string, binding: SpaceRuntimeBinding, draft: Omit<RunRecord, 'id'>): Promise<RunRecord>;
  startNode(spaceId: string, input: NodeStart): Promise<NodeContext>;
  completeObservedAgent(spaceId: string, contextId: string, output: unknown, validation?: ValidationState): Promise<void>;
  commitRuntimePublication(spaceId: string, contextId: string, runtimeCommit: StepResultCommit,
    nodeCommit: NodeCommit): Promise<StepResultReceipt>;
  resolveRuntimeArtifact(spaceId: string, artifactId: string): Promise<AssetVersion>;
  runtimeProcessContract?(spaceId:string,runId:string):Promise<ProcessContract|undefined>;
  runtimeContexts(spaceId: string, runId: string): Promise<NodeContext[]>;
  readManifest(spaceId: string, manifestId: string): Promise<InputManifest>;
  readAsset(spaceId: string, versionId: string): Promise<AssetVersion & {state: string}>;
  recordSessionEvent(spaceId: string, contextId: string, key: string,
    kind: 'message' | 'tool' | 'trace' | 'error', body: unknown): Promise<unknown>;
  failNode?(spaceId: string, contextId: string, error: string, completeness?: 'complete' | 'incomplete'): Promise<void>;
}

export interface SpaceRuntimeResolverApi {
  readonly spaceId: string;
  readonly binding: SpaceRuntimeBinding;
  /** A core artifact is mapped to the exact persisted Space asset version. */
  runtimeArtifactVersion(artifactId: string): Promise<AssetVersion>;
  readAsset(versionId: string): Promise<AssetVersion & {state: string}>;
  inputManifest(): Promise<InputManifest>;
  /** Exact core publication receipts paired with their Space asset versions. */
  artifacts(runId: string): Promise<Array<{artifact: ArtifactRef; version: AssetVersion}>>;
  /** Persisted contexts survive a process restart and core replay. */
  contexts(runId: string): Promise<NodeContext[]>;
  frozenProcess(runId:string):Promise<ProcessContract|undefined>;
  /** Host resolver uses phase/key identity to distinguish equal outputs from different rounds. */
  steps(runId: string): Promise<StepRecord[]>;
}

export interface AgentSpaceBinding {
  nodeId: string;
  /** Exact version IDs for declared input slots. */
  inputs: Record<string, string>;
  instructions: string;
  effectiveConfig?: Record<string, unknown>;
  knowledgeIds?: string[];
  resumeSessionId?: string;
  process?: NodeOccurrenceAnnotation;
}

export interface PublicationSpaceBinding {
  nodeId: string;
  inputs: Record<string, string>;
  outputSlot: string;
  dependencySlots?: string[];
  instructions?: string;
  effectiveConfig?: Record<string, unknown>;
  generatedByContextId?: string;
  assetId?: string;
  expectedHead?: string;
  blobIds?: string[];
  process?: NodeOccurrenceAnnotation;
  relations?: NodeRelationWrite[];
}

export interface SpaceRuntimeOptions {
  underlyingRunner: AgentRunner;
  resolveDecision?(commit:StepResultCommit,api:SpaceRuntimeResolverApi):ProcessDecisionBinding|undefined|Promise<ProcessDecisionBinding|undefined>;
  resolveAgent(request: AgentRunRequest<unknown>, api: SpaceRuntimeResolverApi):
    AgentSpaceBinding | Promise<AgentSpaceBinding>;
  resolvePublication(artifact: ArtifactDraft, api: SpaceRuntimeResolverApi):
    PublicationSpaceBinding | Promise<PublicationSpaceBinding>;
}

export interface SpaceRuntime { store: RunStore; agentRunner: AgentRunner }

function required(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function exactInputs(a: Record<string, string>, b: Record<string, {assetVersionId: string}>): boolean {
  const aKeys = Object.keys(a).sort(), bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) =>
    key === bKeys[index] && a[key] === b[key]?.assetVersionId);
}

function agentConfig(request: AgentRunRequest<unknown>): Record<string, unknown> {
  const definition = request.definition;
  return {
    id: definition.id, revision: definition.revision, model: definition.model,
    reasoningEffort: definition.reasoningEffort, promptRevision: definition.promptRevision,
    skillsRevision: definition.skillsRevision, permissionsRevision: definition.permissionsRevision,
    ...(definition.config ? { config: definition.config } : {}),
  };
}

/**
 * Connects the existing core runner to a Space without changing its step and replay engine.
 * The service owns all Space authorization, schema checks, source receipts and transactions.
 */
export async function createSpaceRuntime(service: SpaceRuntimeService, spaceId: string,
  binding: SpaceRuntimeBinding, options: SpaceRuntimeOptions): Promise<SpaceRuntime> {
  required(spaceId, 'Space ID');
  required(binding.workflowVersionId, 'Workflow version ID');
  required(binding.entrypoint, 'Entrypoint');
  required(binding.inputManifestId, 'Input manifest ID');
  const base = await service.runtimeLedger(spaceId);
  if (!base.commitStepResult) throw new Error('Workflow Space runtime requires atomic core step completion');
  const api: SpaceRuntimeResolverApi = Object.freeze({
    spaceId, binding: Object.freeze({ ...binding }),
    runtimeArtifactVersion: (artifactId: string) => service.resolveRuntimeArtifact(spaceId, artifactId),
    readAsset: (versionId: string) => service.readAsset(spaceId, versionId),
    inputManifest: () => service.readManifest(spaceId, binding.inputManifestId),
    artifacts: async (runId: string) => Promise.all((await base.listArtifacts(runId)).map(async (artifact) =>
      ({artifact, version: await service.resolveRuntimeArtifact(spaceId, artifact.id)}))),
    contexts: (runId: string) => service.runtimeContexts(spaceId, runId),
    steps: (runId: string) => base.listSteps(runId),
    frozenProcess: (runId:string) => service.runtimeProcessContract?.(spaceId,runId) ?? Promise.resolve(undefined),
  });
  const contextCache = new Map<string, NodeContext>();

  async function stepKey(runId: string, stepRunId: string): Promise<string> {
    const step = (await base.listSteps(runId)).find((item) => item.id === stepRunId);
    if (!step) throw new Error(`Runtime step ${stepRunId} is missing`);
    return step.key;
  }

  async function contextForAttempt(runId: string, stepRunId: string, attemptId: string,
    nodeId: string, producer: 'agent' | 'program', inputs: Record<string, string>): Promise<NodeContext | undefined> {
    const key = `${runId}:${stepRunId}:${attemptId}:${producer}`;
    const cached = contextCache.get(key);
    const context = cached ?? (await service.runtimeContexts(spaceId, runId)).find((item) =>
      item.stepRunId === stepRunId && item.attemptId === attemptId && item.producer === producer);
    if (!context) return undefined;
    if (context.nodeId !== nodeId || !exactInputs(inputs, context.inputs)) {
      throw new Error('Persisted runtime context conflicts with current resolver binding');
    }
    contextCache.set(key, context);
    return context;
  }

  async function ensureContext(runId: string, stepRunId: string, attemptId: string,
    resolved: AgentSpaceBinding | PublicationSpaceBinding, producer: 'agent' | 'program',
    actualInput: unknown, defaultConfig: Record<string, unknown>, generatedByContextId?: string): Promise<NodeContext> {
    required(resolved.nodeId, 'Node ID');
    const instructions = resolved.instructions ?? `Publish ${resolved.nodeId}`;
    const effectiveConfig = resolved.effectiveConfig ?? defaultConfig;
    const prior = await contextForAttempt(runId, stepRunId, attemptId, resolved.nodeId, producer, resolved.inputs);
    if (prior) {
      const previous = await artifactPayloadSha256({actualInput: prior.actualInput,
        instructions: prior.instructions, effectiveConfig: prior.effectiveConfig,
        generatedByContextId: prior.generatedByContextId, process:prior.process});
      const current = await artifactPayloadSha256({actualInput, instructions, effectiveConfig, generatedByContextId, process:resolved.process});
      if (previous !== current) {
        throw new Error('Persisted runtime context conflicts with current input, instructions, configuration or origin');
      }
      return prior;
    }
    const input: NodeStart = {
      runId, nodeId: resolved.nodeId, key: await stepKey(runId, stepRunId), inputs: resolved.inputs,
      producer, instructions, effectiveConfig,
      existingAttempt: { stepRunId, attemptId }, actualInput,
      ...(generatedByContextId ? { generatedByContextId } : {}),
      ...(resolved.process ? { process: resolved.process } : {}),
      ...('knowledgeIds' in resolved && resolved.knowledgeIds ? { knowledgeIds: resolved.knowledgeIds } : {}),
      ...('resumeSessionId' in resolved && resolved.resumeSessionId ? { resumeSessionId: resolved.resumeSessionId } : {}),
    };
    const context = await service.startNode(spaceId, input);
    contextCache.set(`${runId}:${stepRunId}:${attemptId}:${producer}`, context);
    return context;
  }

  const store: RunStore = {
    createRun: (record: Omit<RunRecord, 'id'>) => service.bindRuntimeRun(spaceId, binding, record),
    getRun: (id: string) => base.getRun(id),
    listRuns: (filter?: {parentRunId?: string; metadata?: Readonly<Record<string, string>>}) => base.listRuns(filter),
    updateRun: (id: string, patch: Partial<Pick<RunRecord, 'state' | 'output' | 'error'>>) => base.updateRun(id, patch),
    createStep: (record: Omit<StepRecord, 'id'>) => base.createStep(record),
    listSteps: (runId: string) => base.listSteps(runId),
    findReusableStep: (query: Parameters<RunStore['findReusableStep']>[0]) => base.findReusableStep(query),
    updateStep: (id: string, patch: Parameters<RunStore['updateStep']>[1]) => base.updateStep(id, patch),
    createAttempt: (record: Omit<AttemptRecord, 'id'>) => base.createAttempt(record),
    listAttempts: (stepRunId: string) => base.listAttempts(stepRunId),
    updateAttempt: (id: string, patch: Parameters<RunStore['updateAttempt']>[1]) => base.updateAttempt(id, patch),
    appendEvent: (event: EventDraft): Promise<WorkflowEvent> => base.appendEvent(event),
    listEvents: (runId: string, afterSeq?: number) => base.listEvents(runId, afterSeq),
    publishArtifact: async (_artifact: ArtifactDraft): Promise<ArtifactRef> => {
      throw new Error('Direct artifact publishing is unavailable in a Workflow Space; use an atomic core step commit');
    },
    getArtifact: (id: string) => base.getArtifact(id),
    listArtifacts: (runId: string) => base.listArtifacts(runId),
    commitStepResult: async (commit: StepResultCommit): Promise<StepResultReceipt> => {
      if (!commit.artifact) {
        if(options.resolveDecision) {
          const runId=commit.events[0]?.runId;
          const step=runId?(await base.listSteps(runId)).find(step=>step.id===commit.stepRunId):undefined;
          if(step?.kind==='decision') {
            const resolved=await options.resolveDecision(commit,api);
            if(resolved) {
              if(!service.commitRuntimeDecision) throw new Error('Runtime decision mapping service unavailable');
              return service.commitRuntimeDecision(spaceId,commit,resolved);
            }
          }
        }
        return base.commitStepResult!(commit);
      }
      const artifact = commit.artifact;
      const resolved = await options.resolvePublication(artifact, api);
      required(resolved.outputSlot, 'Output slot');
      const runId = artifact.producedBy.workflowRunId;
      if (artifact.producedBy.stepRunId !== commit.stepRunId || artifact.producedBy.attemptId !== commit.attemptId) {
        throw new Error('Core publication source does not match its step commit');
      }
      const context = await ensureContext(runId, commit.stepRunId, commit.attemptId, resolved,
        'program', artifact.payload, { artifactType: artifact.type, schemaVersion: artifact.schemaVersion },
        resolved.generatedByContextId);
      const nodeCommit: NodeCommit = {
        idempotencyKey: commit.idempotencyKey,
        outputs: [{ slot: resolved.outputSlot, payload: artifact.payload,
          dependencySlots: resolved.dependencySlots ?? Object.keys(resolved.inputs),
          ...(resolved.assetId ? { assetId: resolved.assetId } : {}),
          ...(resolved.expectedHead ? { expectedHead: resolved.expectedHead } : {}),
          ...(resolved.blobIds ? { blobIds: resolved.blobIds } : {}) }],
        result: { coreArtifactType: artifact.type, schemaVersion: artifact.schemaVersion },
        ...(resolved.relations ? {relations:resolved.relations} : {}),
      };
      return service.commitRuntimePublication(spaceId, context.id, commit, nodeCommit);
    },
  };

  const agentRunner: AgentRunner = {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      const resolved = await options.resolveAgent(request as AgentRunRequest<unknown>, api);
      const observedConfig=agentConfig(request as AgentRunRequest<unknown>);
      const actualInstructions=request.definition.config?.instructions;
      const observedBinding={...resolved,effectiveConfig:observedConfig,
        instructions:typeof actualInstructions==='string'?actualInstructions:resolved.instructions};
      const context = await ensureContext(request.runId, request.stepRunId, request.attemptId,
        observedBinding, 'agent', request.input, observedConfig);
      let eventNumber = 0;
      let persistenceError: unknown;
      let result: AgentRunResult<Output>;
      try {
        result = await options.underlyingRunner.run<Input, Output>({
          ...request,
          emit: async (type, data) => {
            try {
              await request.emit(type, data);
              await service.recordSessionEvent(spaceId, context.id, `runner-event:${++eventNumber}`, 'trace', {type, data});
            } catch (error) {
              persistenceError = error;
              throw error;
            }
          },
        });
      } catch (error) {
        if (persistenceError) throw new AtomicStepReconciliationRequiredError(request.runId, request.stepRunId, request.attemptId);
        try { await service.failNode?.(spaceId, context.id, error instanceof Error ? error.message : String(error), 'incomplete'); }
        catch { /* Keep the original runner failure. */ }
        throw error;
      }
      if (persistenceError) throw new AtomicStepReconciliationRequiredError(request.runId, request.stepRunId, request.attemptId);
      try {
        // A successful service receipt proves the registered raw-output schema passed.
        // Preserve explicit invalid judgments; pending/omitted becomes structurally valid.
        result = {...result,validation:result.validation==='invalid'?'invalid':'valid'};
        await service.completeObservedAgent(spaceId, context.id, result.output, result.validation);
      } catch (error) {
        if (error instanceof InvalidObservedOutputError) throw error;
        throw new AtomicStepReconciliationRequiredError(request.runId, request.stepRunId, request.attemptId);
      }
      return result;
    },
  };

  return { store, agentRunner };
}
