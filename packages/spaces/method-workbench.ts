import type { WorkflowVersionDraft } from './types.js';
import type { WorkflowPresentationDraft } from './presentation.js';

/** Host supplies a read-only candidate and an explicit, guarded publication command. */
export interface WorkflowMethodCandidate {
  version: WorkflowVersionDraft;
  presentation?: WorkflowPresentationDraft;
  entrypoint: string;
}
export interface WorkflowMethodHost {
  workflowId: string;
  entrypoint: string;
  preview(): Promise<WorkflowMethodCandidate>;
  publish(input: { expectedVersionId: string; predecessorId?: string; changeReason: string }): Promise<{ workflowVersionId: string; entrypoint: string }>;
  availability(workflowVersionId: string, entrypoint: string): Promise<{ available: boolean; reason?: string }>;
}
