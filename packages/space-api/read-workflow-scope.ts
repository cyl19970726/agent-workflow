export interface ReadWorkflowScope {
  workflowId: string;
  auxiliaryWorkflowIds?: readonly string[];
}

/** Additional workflows are read-only companions of the host's primary method scope. */
export function readableWorkflowIds(scope: ReadWorkflowScope): string[] {
  return [scope.workflowId, ...new Set((scope.auxiliaryWorkflowIds ?? [])
    .filter(id => id && id !== scope.workflowId))].sort();
}

export function canReadWorkflow(scope: ReadWorkflowScope, workflowId: string | undefined): boolean {
  return workflowId !== undefined && readableWorkflowIds(scope).includes(workflowId);
}

export function readWorkflowScopeKey(scope: ReadWorkflowScope): string {
  return JSON.stringify(readableWorkflowIds(scope));
}
