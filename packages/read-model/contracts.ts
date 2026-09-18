/** Browser-safe DTOs. No raw workflow payloads, metadata, paths, or artifact URIs. */
export type ReadState = "queued" | "running" | "waiting" | "blocked" | "needs_review" | "succeeded" | "failed" | "canceled" | "unknown";
export type FactState = "unknown" | "pending" | "valid" | "invalid" | "passed" | "findings" | "not_applicable";
export interface ArtifactIdentity { id: string; revision: string; sha256: string }
export interface SafeArtifact { identity: ArtifactIdentity; type: string; schemaVersion: string; producer: { runId: string; stepId: string; attemptId: string }; validation: FactState; review: FactState; effectiveReview: FactState; readerUrl?: string }
export interface ArtifactRelation { kind: "consumed" | "produced" | "reviews" | "revises" | "supersedes" | "selected"; from: ArtifactIdentity; to: ArtifactIdentity; reason?: string; validity: "valid" | "missing" | "mismatch" }
export interface RunView { id: string; parentRunId?: string; parentStepId?: string; workflowId: string; state: ReadState; childRunIds: string[]; diagnostic?: "missing_parent" | "cycle" }
export interface AttemptView { id: string; state: ReadState; error?: string; startedAt?: string; endedAt?: string; usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } }
export interface CallView { id: string; runId: string; stepId: string; phaseId?: string; role: "agent" | "workflow"; state: ReadState; validation: FactState; title?: string; model?: string; reasoningEffort?: string; methodRevision?: string; methodDigest?: string; inputArtifactIds: string[]; reused: boolean; retryOf?: string; retryReason?: string; attempts: AttemptView[]; artifactIds: string[]; childRunIds: string[] }
export interface StageView {
  id: string; phaseKey: string; runId: string; path: string[];
  title: string; purpose: string; order?: number; state: ReadState;
  validation: FactState; review: FactState;
  delivery: "unknown" | "missing" | "ambiguous" | "selected";
  waitingForRunId?: string;
  expectedArtifacts: { role: string; title?: string; required: boolean; missing: boolean }[];
  artifactIds: string[]; callIds: string[]; startedAt?: string; endedAt?: string;
}
export interface ProgressView { registered: number; completed: number; planned?: number; closed: boolean }
export interface WorkflowSnapshot { schemaVersion: 1; rootRunId: string; selectedRunId?: string; cursor: string; runs: RunView[]; stages: StageView[]; calls: CallView[]; artifacts: SafeArtifact[]; relations: ArtifactRelation[]; progress: ProgressView; diagnostics: string[] }
export type WorkflowChanges = { resetRequired: true } | { resetRequired: false; cursor: string; changed: WorkflowSnapshot; removed: { runs: string[]; stages: string[]; calls: string[]; artifacts: string[] } };
export interface StageDetails { phaseId: string; calls: CallView[]; artifacts: SafeArtifact[]; nextCursor?: string }
export interface WorkflowReadService { getSnapshot(input: { rootRunId: string; selectedRunId?: string }): Promise<WorkflowSnapshot>; getChanges(input: { rootRunId: string; cursor: string }): Promise<WorkflowChanges>; getStageDetails(input: { rootRunId: string; phaseId: string; cursor?: string; limit?: number }): Promise<StageDetails> }
