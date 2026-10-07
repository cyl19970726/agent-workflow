import { describe, expect, it } from 'vitest';
import { closeInspector, readSelection, selectNode, selectRun, selectVersion, writeSelection } from './selection.js';

describe('URL selection', () => {
  it('restores exact object context and preserves unrelated search parameters', () => {
    const incoming = new URLSearchParams('host=creation&view=business&tab=process&version=v2&case=c1&run=r1&node=author&occurrence=author:2&asset=a2');
    const selection = readSelection(incoming);
    expect(selection).toMatchObject({ view: 'business', tab: 'process', version: 'v2', case: 'c1', run: 'r1', node: 'author', occurrence: 'author:2', asset: 'a2' });
    expect(writeSelection(incoming, selection).get('host')).toBe('creation');
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
});
