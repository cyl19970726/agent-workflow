export type WorkbenchView = 'goal' | 'workflow' | 'business' | 'assets';
export type WorkflowTab = 'basis' | 'definition' | 'process' | 'history' | 'design';
export interface Selection {
  view: WorkbenchView;
  tab: WorkflowTab;
  version?: string;
  case?: string;
  run?: string;
  node?: string;
  occurrence?: string;
  runtimeAttempt?: string;
  nodePane?: string;
  asset?: string;
  expectedAsset?: string;
  plan?: string;
  entry?: string;
  comparison?: string;
  evidence?: string;
  returnVersion?: string;
  understandingRevision?: string;
  methodDesignRevision?: string;
  sourceRevision?: string;
  sourceIndex?: string;
  designSourceRevision?: string;
  designSourceIndex?: string;
}

const keys = ['view', 'tab', 'version', 'case', 'run', 'node', 'occurrence', 'runtimeAttempt', 'nodePane', 'asset', 'expectedAsset', 'plan', 'entry', 'comparison', 'evidence', 'returnVersion', 'understandingRevision', 'methodDesignRevision', 'sourceRevision', 'sourceIndex', 'designSourceRevision', 'designSourceIndex'] as const;

export function readSelection(params: URLSearchParams): Selection {
  const view = params.get('view');
  const tab = params.get('tab');
  return {
    view: view === 'goal' || view === 'business' || view === 'assets' ? view : 'workflow',
    tab: tab === 'basis' || tab === 'process' || tab === 'history' || tab === 'design' ? tab : 'definition',
    ...Object.fromEntries(keys.slice(2).flatMap(key => {
      const value = params.get(key);
      return value && (key !== 'nodePane' || ['overview', 'inputs', 'instructions', 'records', 'config'].includes(value)) ? [[key, value]] : [];
    })),
  };
}

export function writeSelection(current: URLSearchParams, selection: Selection): URLSearchParams {
  const next = new URLSearchParams(current);
  if ((current.get('case') || undefined) !== selection.case) next.delete('caseManifest');
  for (const key of keys) {
    const value = selection[key];
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function validSourceOriginIndex(raw: string | undefined, sourceCount: number | undefined): number | null {
  if (!raw || !/^(0|[1-9]\d{0,3})$/.test(raw) || sourceCount === undefined) return null;
  const index = Number(raw);
  return index < sourceCount ? index : null;
}

export function selectVersion(selection: Selection, version: string): Selection {
  return { ...selection, version, run: undefined, node: undefined, occurrence: undefined, runtimeAttempt: undefined, nodePane: undefined, asset: undefined, expectedAsset: undefined, plan: undefined, entry: undefined, comparison: undefined, evidence: undefined, returnVersion: undefined };
}

export function selectRun(selection: Selection, run: { id: string; versionId: string; caseId: string }): Selection {
  return { ...selection, view: 'business', tab: 'process', version: run.versionId, case: run.caseId, run: run.id, node: undefined, occurrence: undefined, runtimeAttempt: undefined, nodePane: undefined, asset: undefined, expectedAsset: undefined, comparison: undefined };
}

export function selectNode(selection: Selection, nodeId: string | undefined): Selection {
  return { ...selection, node: nodeId, occurrence: undefined, runtimeAttempt: undefined, nodePane: undefined, asset: undefined, expectedAsset: undefined, comparison: undefined };
}

export function closeInspector(selection: Selection): Selection {
  return selection.comparison ? { ...selection, comparison: undefined } : selection.asset ? { ...selection, asset: undefined } : selection.expectedAsset ? { ...selection, expectedAsset: undefined } : { ...selection, node: undefined, occurrence: undefined };
}
