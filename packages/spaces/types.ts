import type { SchemaRef, StorageContractDraft, FrozenStorageContract } from '@signal-room/workflow-space-contracts';
import type { ProcessContractDraft, ProcessContract } from './process-contract.js';

/** Supplied by the host's authentication layer, never from an Agent tool argument. */
export interface SpacePrincipal { id: string; kind: 'human' | 'service' }
export type SpaceRole = 'owner' | 'creator' | 'operator' | 'viewer';
export interface WorkflowSpace { id: string; purpose: string; owner: string; status: 'active' | 'archived'; createdAt: string }
/** Frozen authoring details keyed by process node ID. Historic versions may lack these details. */
export interface WorkflowNodeDefinition {
  purpose?: string;
  instructions?: string;
  model?: string;
  tools?: string[];
  /** Declared execution responsibility; omitted for historic or unknown executors. */
  executor?: { family: 'agent-sdk' | 'codex' | 'program' | 'human' | 'decision'; adapter?: string };
  configuration?: Record<string, unknown>;
}
export interface WorkflowEntrypointDraft { workflowId: string; codeRevision: string; storageContract: StorageContractDraft; process?: ProcessContractDraft; nodeDefinitions?: Record<string, WorkflowNodeDefinition> }
export interface WorkflowEntrypoint { workflowId: string; codeRevision: string; storageContract: FrozenStorageContract; process?: ProcessContract; nodeDefinitions?: Record<string, WorkflowNodeDefinition> }
export interface WorkflowVersionDraft {
  id: string; revision: string; predecessorId?: string; changeReason: string;
  entrypoints: Record<string, WorkflowEntrypointDraft>;
  config: Record<string, unknown>;
}
export interface WorkflowVersion extends Omit<WorkflowVersionDraft, 'entrypoints'> {
  spaceId: string; hash: string; createdAt: string;
  entrypoints: Record<string, WorkflowEntrypoint>;
}
export interface SpaceCase { id: string; spaceId: string; title: string; objective: string; constraints: string[] }
export interface InputManifest { id: string; spaceId: string; caseId: string; assets: Record<string, string>; hash: string }
export interface SpaceRun {
  runId: string; spaceId: string; workflowVersionId: string; entrypoint: string; caseId: string;
  inputManifestId: string; effectiveConfig: Record<string, unknown>; configHash: string;
  process?: { revision: string; hash: string };
}
export type AssetSource =
  | { kind: 'import'; actorId: string; description: string }
  | { kind: 'node'; runId: string; stepRunId: string; attemptId: string; nodeId: string; producer: 'agent' | 'program'; sessionId: string; contextId: string; generatedByContextId?: string }
  | { kind: 'transform'; actorId: string; description: string; fromVersionIds: string[]; operation: string };
export interface BlobManifest { id: string; spaceId: string; sha256: string; size: number; mediaType: string; key: string }
export interface AssetVersion {
  id: string; spaceId: string; assetId: string; version: number; schema: SchemaRef; payload: unknown; payloadHash: string;
  source: AssetSource; dependencies: string[]; attachments: BlobManifest[]; initialState: string; createdAt: string;
}
export interface AssetWrite {
  assetId?: string; expectedHead?: string; schema: SchemaRef; payload: unknown; dependencies?: string[];
  blobIds?: string[]; idempotencyKey: string;
}
export interface NodeStart {
  runId: string; nodeId: string; key: string; inputs: Record<string, string>;
  producer: 'agent' | 'program'; instructions: string; effectiveConfig: Record<string, unknown>;
  knowledgeIds?: string[]; resumeSessionId?: string;
  existingAttempt?: {stepRunId:string;attemptId:string}; actualInput?: unknown; generatedByContextId?: string;
  process?: NodeOccurrenceAnnotation;
}
/** Business iteration differs from a retry, which belongs to the same core step. */
export interface NodeOccurrenceAnnotation { nodeId: string; round?: number; branch?: string; route?: string; decisionEventSeq?: number }
export interface DeliveredInput { assetVersionId: string; stateAtBinding: string; payloadHash: string; schema: SchemaRef; viewVersion: string; deliveredHash: string; payload: unknown }
export interface NodeContext {
  id: string; spaceId: string; runId: string; stepRunId: string; attemptId: string; nodeId: string; executionPrincipalId: string;
  sessionId: string; producer: 'agent' | 'program'; inputs: Record<string, DeliveredInput>;
  instructions: string; effectiveConfig: Record<string, unknown>; knowledge: KnowledgeRevision[]; hash: string;
  actualInput?: unknown; generatedByContextId?: string; startRequestHash: string; declaredConfigHash: string; effectiveConfigHash: string;
  process?: NodeOccurrenceAnnotation;
}
export interface NodeOutput {
  slot: string; payload: unknown; assetId?: string; expectedHead?: string; blobIds?: string[];
  /** Names of bound input slots; no arbitrary dependency or producer identities. */
  dependencySlots: string[];
}
export interface RelationEndpoint { assetVersionId: string; pointer?: string }
export interface NodeRelationEndpoint { outputSlot?: string; inputSlot?: string; pointer?: string }
export interface NodeRelationWrite { typeId: string; from: NodeRelationEndpoint; to: NodeRelationEndpoint; evidence?: string }
export interface NodeCommit { idempotencyKey: string; outputs: NodeOutput[]; result?: unknown; relations?: NodeRelationWrite[] }
export interface NodeReceipt { contextId: string; versions: AssetVersion[]; result: unknown }
export interface NodeClient {
  read(slot: string): Promise<DeliveredInput>;
  readFull(slot: string): Promise<DeliveredInput>;
  submit(commit: NodeCommit): Promise<NodeReceipt>;
  act(action: string, input: unknown): Promise<unknown>;
}
export interface SessionRecord { id: string; spaceId: string; role: string; nativeSessionId?: string; parentId?: string; completeness: 'open' | 'complete' | 'incomplete'; nextSeq: number }
export interface SessionEvent { id: string; sessionId: string; seq: number; attemptId: string; kind: 'message' | 'tool' | 'trace' | 'error'; body: unknown; createdAt: string }
export interface KnowledgeRevision {
  id: string; spaceId: string; entryId: string; previousId?: string; content: string; classification: 'fact' | 'inference';
  scope: { caseId?: string; roles?: string[] }; sourceAssetIds: string[]; sourceMessageIds: string[]; status: 'active' | 'superseded'; author: string;
}
export interface ReviewDraft {
  id: string; runId: string; assetVersionIds: string[]; baselineReviewId?: string; standard: { id: string; revision: string; content: string };
  judge: { kind: 'human' | 'agent'; id: string; sessionId?: string }; evidence: string[];
  answers: { good: string; bad: string; improvement: string; unresolved: string };
}
export interface Review extends ReviewDraft { spaceId: string; createdAt: string }
export interface ComparisonDraft { id: string; baselineReviewId: string; candidateReviewId: string; conclusion: string }
export interface Comparison extends ComparisonDraft { spaceId: string; changedConditions: Record<string, { baseline: unknown; candidate: unknown }> }
export interface IterationDraft { id: string; reviewIds: string[]; hypothesis: string; workflowVersionId: string; caseIds: string[]; runIds: string[] }
export interface AdoptionDraft { idempotencyKey: string; slot: string; target: { kind: 'workflow' | 'asset'; id: string }; expectedPrevious?: string; comparisonId?: string; validationPlanId?: string; reason: string }
export interface Adoption extends AdoptionDraft { id: string; actorId: string; createdAt: string }
export interface ValidationEntry {
  id:string; side:'baseline'|'candidate'; caseId:string; inputManifestId:string; repeat:number;
  workflowVersionId:string; entrypoint:string; excludedReason?:string;
}
export interface ValidationJudgeTool {name:string;description:string;parameters:unknown}
export interface ValidationJudgePolicy {
  kind:'human'|'agent';id:string;configuration?:Record<string,unknown>;
  /** Exact provider instructions and tools observed by a trusted runner. Required for new Agent policies. */
  instructions?:string;tools?:ValidationJudgeTool[];
}
export interface ValidationPlanDraft {
  id:string; kind:'prospective'|'retrospective'; question:string; hypothesis:string;
  baseline:{workflowVersionId:string;entrypoint:string}; candidate:{workflowVersionId:string;entrypoint:string};
  cases:{caseId:string;inputManifestId:string;repeats:number}[];
  standard:{id:string;revision:string;content:string};
  judges:ValidationJudgePolicy[];
  expectedVariables:string[]; exclusionRules:string[];
  excludedEntries?:{entryId:string;reason:string}[]; replacesPlanId?:string;
}
export interface ValidationPlan extends ValidationPlanDraft {
  spaceId:string; status:'draft'|'frozen'; createdAt:string; frozenAt?:string; frozenRunOrdinal?:string; entries:ValidationEntry[];
}
export interface ValidationRunLink {entryId:string;runId:string;attempt:number;linkedAt:string}
export interface ValidationJudgeEvidence {reviewId:string;verified:boolean;expectedProfileHash?:string;observedProfileHash?:string;differences:Record<string,{expected:unknown;observed:unknown}>}
export interface ValidationReviewLink {entryId:string;runId:string;reviewId:string;linkedAt:string;judgeEvidence:ValidationJudgeEvidence}
export interface ValidationComparison {id:string;baselineEntryId:string;candidateEntryId:string;baselineReviewId:string;candidateReviewId:string;conclusion:string;comparison:Comparison}
export interface ValidationIssueDraft {
  id:string; kind:'observation'|'cause-hypothesis'; category:string; text:string; nextHypothesis?:string;
  evidence:{entryId:string;caseId:string;runId?:string;nodeId?:string}[];
}
export interface ValidationIssue extends ValidationIssueDraft {spaceId:string;planId:string;createdAt:string}
export type ValidationEntryStatus = 'excluded'|'missing'|'pending'|'queued'|'running'|'cancel_requested'|'interrupted'|'completed'|'failed'|'canceled'|'needs_review'|'reviewed';
export interface ValidationEntrySummary {entry:ValidationEntry;status:ValidationEntryStatus;requiredJudgeCoverage:{kind:'human'|'agent';id:string;reviewIds:string[];unverifiedReviewIds:string[]}[];attempts:{attempt:number;runId:string;status:string;task?:{status:string;error?:string};run?:{state:string;error?:string};reviews:Review[];judgeEvidence:ValidationJudgeEvidence[]}[]}
export interface ValidationSummary {
  plan:ValidationPlan; entries:ValidationEntrySummary[];
  cases:{caseId:string;baselineEntryIds:string[];candidateEntryIds:string[];status:string}[];
  pairs:{caseId:string;repeat:number;baselineEntryId:string;candidateEntryId:string;status:'missing'|'pending'|'compared'|'excluded';comparisonIds:string[];requiredJudgeCoverage:{kind:'human'|'agent';id:string;comparisonIds:string[]}[];changedConditions:Record<string,{baseline:unknown;candidate:unknown}>}[];
  totals:{cases:number;plannedPairs:number;entries:number;attempts:number;byStatus:Record<ValidationEntryStatus,number>};
  issues:ValidationIssue[];comparisons:ValidationComparison[];
}
export interface SpaceOverview {
  space: WorkflowSpace; workflows: WorkflowVersion[]; cases: SpaceCase[]; runs: SpaceRun[];
  assets: (AssetVersion & { state: string })[]; reviews: Review[]; comparisons: Comparison[];
  iterations: IterationDraft[]; adoptions: Adoption[]; sessions: SessionRecord[]; knowledge: KnowledgeRevision[];
}

/** A selected decision edge is distinct from a subsequently realized traversal. */
export interface ProcessDecisionBinding {
  nodeId:string; edgeId:string; round?:number; reason?:string;
  /** Host explains a guarded effective route while retaining the actual decision payload. */
  observation?:{route:string;round?:number};
}
export interface ProcessDecisionObservation {
  runId:string;stepRunId:string;attemptId:string;eventSeq:number;processHash:string;
  annotation:NodeOccurrenceAnnotation;edgeId:string;reason?:string;actorId:string;
}
