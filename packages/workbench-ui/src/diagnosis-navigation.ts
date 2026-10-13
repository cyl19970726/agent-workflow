import { writeSelection, type Selection } from './selection.js';

/** Keep the saved diagnosis identity while opening one of its evidence assets. */
export function diagnosisAssetParams(current: URLSearchParams, selection: Selection, assetId: string, runId: string, revisionId?: string): URLSearchParams {
  const next = writeSelection(current, { ...selection, asset: assetId, expectedAsset: undefined, comparison: undefined });
  next.set('diagnosisRun', runId);
  if (revisionId) next.set('diagnosisRevision', revisionId);
  return next;
}

/** A return must remove every selection that can keep the inspector over the diagnosis. */
export function diagnosisReturnParams(current: URLSearchParams, selection: Selection, runId: string, revisionId?: string): URLSearchParams {
  const next = writeSelection(current, {
    ...selection, asset: undefined, expectedAsset: undefined, comparison: undefined,
    node: undefined, occurrence: undefined, runtimeAttempt: undefined, nodePane: undefined,
  });
  next.set('diagnosisRun', runId);
  if (revisionId) next.set('diagnosisRevision', revisionId);
  return next;
}
