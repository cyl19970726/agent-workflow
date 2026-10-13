import { describe, expect, it } from 'vitest';
import { diagnosisAssetParams, diagnosisReturnParams } from './diagnosis-navigation.js';
import { readSelection } from './selection.js';

describe('diagnosis evidence navigation', () => {
  it('opens an asset from a saved revision, then closes every inspector selection without changing the Run, revision, or assessment context', () => {
    const before = new URLSearchParams('view=business&tab=process&case=case-1&run=run-1&version=version-1&diagnosisRun=run-1&diagnosisRevision=diagnosis-2&assessmentRun=run-1&assessmentReview=review-3&node=researcher&occurrence=round-1&runtimeAttempt=attempt-1&nodePane=records');
    const opened = diagnosisAssetParams(before, readSelection(before), 'asset-research', 'run-1', 'diagnosis-2');
    expect(opened.get('asset')).toBe('asset-research');
    const returned = diagnosisReturnParams(opened, readSelection(opened), 'run-1', 'diagnosis-2');
    expect(readSelection(returned)).toMatchObject({ view: 'business', tab: 'process', case: 'case-1', run: 'run-1', version: 'version-1' });
    expect(returned.get('diagnosisRun')).toBe('run-1');
    expect(returned.get('diagnosisRevision')).toBe('diagnosis-2');
    expect(returned.get('assessmentRun')).toBe('run-1');
    expect(returned.get('assessmentReview')).toBe('review-3');
    for (const key of ['asset', 'expectedAsset', 'comparison', 'node', 'occurrence', 'runtimeAttempt', 'nodePane']) expect(returned.has(key)).toBe(false);
  });

  it('adds an exact diagnosis source to a fresh evidence link without touching unrelated navigation', () => {
    const before = new URLSearchParams('view=business&tab=process&case=case-1&run=run-1&assessmentRun=run-1');
    const opened = diagnosisAssetParams(before, readSelection(before), 'asset-1', 'run-1', 'diagnosis-current-id');
    expect(opened.get('diagnosisRun')).toBe('run-1');
    expect(opened.get('diagnosisRevision')).toBe('diagnosis-current-id');
    expect(opened.get('assessmentRun')).toBe('run-1');
    expect(diagnosisReturnParams(opened, readSelection(opened), 'run-1', 'diagnosis-current-id').get('diagnosisRevision')).toBe('diagnosis-current-id');
  });
});
