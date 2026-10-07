export type WorkbenchView = 'workflow' | 'business' | 'assets';
export type WorkflowTab = 'definition' | 'process' | 'history';
export interface Selection {
  view: WorkbenchView;
  tab: WorkflowTab;
  version?: string;
  case?: string;
  run?: string;
  node?: string;
  occurrence?: string;
  asset?: string;
  plan?: string;
  entry?: string;
  comparison?: string;
  evidence?: string;
  returnVersion?: string;
}

const keys = ['view', 'tab', 'version', 'case', 'run', 'node', 'occurrence', 'asset', 'plan', 'entry', 'comparison', 'evidence', 'returnVersion'] as const;

export function readSelection(params: URLSearchParams): Selection {
  const view = params.get('view');
  const tab = params.get('tab');
  return {
    view: view === 'business' || view === 'assets' ? view : 'workflow',
    tab: tab === 'process' || tab === 'history' ? tab : 'definition',
    ...Object.fromEntries(keys.slice(2).flatMap(key => {
      const value = params.get(key);
      return value ? [[key, value]] : [];
    })),
  };
}

export function writeSelection(current: URLSearchParams, selection: Selection): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of keys) {
    const value = selection[key];
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function selectVersion(selection: Selection, version: string): Selection {
  return { ...selection, version, run: undefined, node: undefined, occurrence: undefined, asset: undefined, plan: undefined, entry: undefined, comparison: undefined, evidence: undefined, returnVersion: undefined };
}

export function selectRun(selection: Selection, run: { id: string; versionId: string; caseId: string }): Selection {
  return { ...selection, view: 'business', tab: 'process', version: run.versionId, case: run.caseId, run: run.id, node: undefined, occurrence: undefined, asset: undefined, comparison: undefined };
}

export function selectNode(selection: Selection, nodeId: string | undefined): Selection {
  return { ...selection, node: nodeId, occurrence: undefined, asset: undefined, comparison: undefined };
}

export function closeInspector(selection: Selection): Selection {
  return selection.comparison ? { ...selection, comparison: undefined } : selection.asset ? { ...selection, asset: undefined } : { ...selection, node: undefined, occurrence: undefined };
}
