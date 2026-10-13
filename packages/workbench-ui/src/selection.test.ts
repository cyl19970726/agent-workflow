import { describe, expect, it } from 'vitest';
import { closeInspector, readSelection, selectNode, selectRun, selectVersion, validSourceOriginIndex, writeSelection } from './selection.js';

describe('URL selection', () => {
  it('restores exact object context and preserves unrelated search parameters', () => {
    const incoming = new URLSearchParams('host=creation&view=business&tab=process&version=v2&case=c1&run=r1&node=author&occurrence=author:2&asset=a2');
    const selection = readSelection(incoming);
    expect(selection).toMatchObject({ view: 'business', tab: 'process', version: 'v2', case: 'c1', run: 'r1', node: 'author', occurrence: 'author:2', asset: 'a2' });
    expect(writeSelection(incoming, selection).get('host')).toBe('creation');
  });
  it('keeps a chosen Case input manifest within the same Case and clears it on Case navigation', () => {
    const current = new URLSearchParams('view=business&case=c1&caseManifest=manifest-1');
    expect(writeSelection(current, { ...readSelection(current), asset: 'input-asset' }).get('caseManifest')).toBe('manifest-1');
    expect(writeSelection(current, { ...readSelection(current), case: 'c2' }).has('caseManifest')).toBe(false);
  });
  it('an accurate run selects its version and case; switching version clears incompatible context', () => {
    const initial = readSelection(new URLSearchParams('version=v1&case=c1&run=r1&node=author&occurrence=o1&asset=a1'));
    const nextRun = selectRun(initial, { id: 'r2', versionId: 'v2', caseId: 'c2' });
    expect(nextRun).toMatchObject({ version: 'v2', case: 'c2', run: 'r2', tab: 'process' });
    expect(nextRun.node).toBeUndefined();
    expect(selectVersion(nextRun, 'v3')).toMatchObject({ version: 'v3', run: undefined, occurrence: undefined, asset: undefined });
    expect(selectNode(nextRun, 'editor').occurrence).toBeUndefined();
  });
  it('returns from an asset to the exact node and occurrence that opened it', () => {
    const reading = readSelection(new URLSearchParams('view=business&tab=process&version=v1&case=c1&run=r1&node=author&occurrence=round-2&asset=cross-run-input'));
    expect(closeInspector(reading)).toMatchObject({ version: 'v1', case: 'c1', run: 'r1', node: 'author', occurrence: 'round-2', asset: undefined });
    expect(closeInspector(closeInspector(reading))).toMatchObject({ node: undefined, occurrence: undefined });
  });
  it('restores the exact original run, node, occurrence and asset after cross-run comparison', () => {
    const original = readSelection(new URLSearchParams('view=business&tab=process&version=v1&case=c1&run=r1&node=author&occurrence=round-2&asset=draft-2&plan=p1&comparison=pair-1&evidence=1'));
    expect(writeSelection(new URLSearchParams('host=creation'), original).get('comparison')).toBe('pair-1');
    expect(closeInspector(original)).toMatchObject({ version: 'v1', case: 'c1', run: 'r1', node: 'author', occurrence: 'round-2', asset: 'draft-2', plan: 'p1', evidence: '1', comparison: undefined });
  });

  it('persists the source method version across another entry, comparison and reload', () => {
    const fromHistory = readSelection(new URLSearchParams('view=workflow&tab=history&version=source-v1'));
    const inComparison = { ...fromHistory, view: 'business' as const, tab: 'process' as const, version: 'entry-v2', returnVersion: fromHistory.version, plan: 'plan-1', comparison: 'pair-1', evidence: '1' };
    const reloaded = readSelection(writeSelection(new URLSearchParams(), inComparison));
    expect(reloaded).toMatchObject({ version: 'entry-v2', returnVersion: 'source-v1', plan: 'plan-1', comparison: 'pair-1' });
    expect(closeInspector(reloaded).returnVersion).toBe('source-v1');
    const returned = { ...closeInspector(reloaded), view: 'workflow' as const, tab: 'history' as const, version: reloaded.returnVersion, returnVersion: undefined, plan: undefined };
    const restored = readSelection(writeSelection(new URLSearchParams(), returned));
    expect(restored).toMatchObject({ view: 'workflow', tab: 'history', version: 'source-v1' });
    expect(restored).not.toHaveProperty('returnVersion');
    expect(selectVersion(reloaded, 'explicit-v3').returnVersion).toBeUndefined();
  });
  it('keeps the chosen frozen plan entry through run navigation and URL reload', () => {
    const chosen = readSelection(new URLSearchParams('view=business&plan=p1&entry=e1&case=c1'));
    const running = selectRun(chosen, { id: 'r2', versionId: 'v2', caseId: 'c1' });
    expect(readSelection(writeSelection(new URLSearchParams(), running))).toMatchObject({ plan: 'p1', entry: 'e1', run: 'r2', version: 'v2' });
  });
  it('keeps an expected method asset separate from actual run assets', () => {
    const expected = readSelection(new URLSearchParams('view=workflow&tab=definition&version=v1&expectedAsset=expected%3Aoutput%3Aauthor%3Adraft'));
    expect(expected.expectedAsset).toBe('expected:output:author:draft');
    expect(expected.asset).toBeUndefined();
    expect(readSelection(writeSelection(new URLSearchParams(), expected)).expectedAsset).toBe(expected.expectedAsset);
    expect(closeInspector(expected)).toMatchObject({ version: 'v1', expectedAsset: undefined });
    expect(selectNode(expected, 'author')).toMatchObject({ node: 'author', expectedAsset: undefined });
    expect(selectVersion(expected, 'v2')).toMatchObject({ version: 'v2', expectedAsset: undefined });
  });
  it('opens the Space purpose as its own entry', () => {
    expect(readSelection(new URLSearchParams('view=goal&version=v1'))).toMatchObject({ view: 'goal', version: 'v1' });
  });
  it('keeps an accurate version design view distinct from its method and existing draft', () => {
    const design = readSelection(new URLSearchParams('view=workflow&tab=basis&version=v2'));
    expect(design).toMatchObject({ view: 'workflow', tab: 'basis', version: 'v2' });
    expect(readSelection(writeSelection(new URLSearchParams(), design))).toEqual(design);
    expect(readSelection(new URLSearchParams('view=workflow&tab=design&version=v2')).tab).toBe('design');
  });
  it('retains the exact goal source through asset, Case run and node navigation and reload', () => {
    const source = readSelection(new URLSearchParams('view=assets&asset=asset-1&understandingRevision=goal-6&sourceRevision=goal-6&sourceIndex=16'));
    expect(validSourceOriginIndex(source.sourceIndex, 17)).toBe(16);
    const caseView = { ...source, view: 'business' as const, asset: undefined, case: 'case-1' };
    const run = selectRun(caseView, { id: 'run-1', versionId: 'v1', caseId: 'case-1' });
    const node = selectNode(run, 'author');
    const reloaded = readSelection(writeSelection(new URLSearchParams(), node));
    expect(reloaded).toMatchObject({ sourceRevision: 'goal-6', sourceIndex: '16', case: 'case-1', run: 'run-1', node: 'author' });
    expect(validSourceOriginIndex('17', 17)).toBeNull();
    expect(validSourceOriginIndex('../16', 17)).toBeNull();
    expect(validSourceOriginIndex('016', 17)).toBeNull();
  });
  it('retains an exact design source through an asset, Case run and node, then returns to that draft', () => {
    const asset = readSelection(new URLSearchParams('view=assets&asset=research-asset&methodDesignRevision=design-5&designSourceRevision=design-5&designSourceIndex=0'));
    const caseView = { ...asset, view: 'business' as const, asset: undefined, case: 'business-case' };
    const node = selectNode(selectRun(caseView, { id: 'run-1', versionId: 'version-1', caseId: 'business-case' }), 'author');
    const reloaded = readSelection(writeSelection(new URLSearchParams(), node));
    expect(reloaded).toMatchObject({ designSourceRevision: 'design-5', designSourceIndex: '0', case: 'business-case', run: 'run-1', node: 'author' });
    const returned = readSelection(writeSelection(new URLSearchParams(), { ...reloaded, view: 'workflow', tab: 'design', methodDesignRevision: reloaded.designSourceRevision, asset: undefined, node: undefined }));
    expect(returned).toMatchObject({ view: 'workflow', tab: 'design', methodDesignRevision: 'design-5', designSourceRevision: 'design-5', designSourceIndex: '0' });
    expect(validSourceOriginIndex(returned.designSourceIndex, 2)).toBe(0);
    expect(validSourceOriginIndex('2', 2)).toBeNull();
  });
  it('restores the runtime pane with its exact occurrence and attempt after navigation', () => {
    const exact = readSelection(new URLSearchParams('view=business&tab=process&version=v1&case=c1&run=r1&node=author&occurrence=round-2&runtimeAttempt=attempt-3&nodePane=instructions'));
    expect(readSelection(writeSelection(new URLSearchParams(), exact))).toMatchObject({ occurrence: 'round-2', runtimeAttempt: 'attempt-3', nodePane: 'instructions' });
    expect(closeInspector({ ...exact, asset: 'asset-1' })).toMatchObject({ node: 'author', occurrence: 'round-2', runtimeAttempt: 'attempt-3', nodePane: 'instructions', asset: undefined });
    expect(selectNode(exact, 'research')).toMatchObject({ node: 'research', occurrence: undefined, runtimeAttempt: undefined, nodePane: undefined });
    expect(selectRun(exact, { id: 'r2', versionId: 'v1', caseId: 'c1' })).toMatchObject({ node: undefined, runtimeAttempt: undefined, nodePane: undefined });
    expect(readSelection(new URLSearchParams('nodePane=invalid')).nodePane).toBeUndefined();
  });
});
