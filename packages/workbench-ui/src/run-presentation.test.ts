import { describe, expect, it } from 'vitest';
import { mergeCurrentRun, runStatusSummary, stateLabel } from './run-presentation.js';

describe('current run presentation', () => {
  it('replaces only the selected run snapshot in a bounded case list', () => {
    const stale = [{ id: 'r1', caseId: 'c1', state: 'queued' }, { id: 'r0', caseId: 'c1', state: 'completed' }];
    expect(mergeCurrentRun(stale, { id: 'r1', caseId: 'c1', state: 'running' }, 'c1')).toEqual([{ id: 'r1', caseId: 'c1', state: 'running' }, stale[1]]);
    expect(mergeCurrentRun(stale, { id: 'r2', caseId: 'c1', state: 'failed' }, 'c1')[0]?.id).toBe('r2');
    expect(mergeCurrentRun(stale, { id: 'r3', caseId: 'c2', state: 'failed' }, 'c1')).toEqual(stale);
  });

  it('uses domain progress, distinguishes dispatch initialization, and never invents readable output', () => {
    expect(runStatusSummary({ state: 'queued', taskState: 'running', progress: null, assetCount: 0 })).toBe('排队中 · 已派发，准备执行 · 尚无可读产物');
    expect(runStatusSummary({ state: 'needs_review', taskState: 'completed', progress: '自动改稿次数用尽，尚未收敛', assetCount: 1 })).toContain('待审阅 · 自动改稿次数用尽，尚未收敛');
    expect(stateLabel('canceled')).toBe('已取消');
  });
});
