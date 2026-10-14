import { describe, expect, it } from 'vitest';
import { mergeCurrentRun, runScopeExplanation, runScopeLabel, runStatusSummary, stateLabel } from './run-presentation.js';

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

  it('keeps trial completion separate from complete Case scope, including old and unknown records', () => {
    const completedTrial = { executionMode: 'research-trial', state: 'completed', taskState: 'completed', assetCount: 1 };
    expect(runScopeLabel(completedTrial)).toBe('研究节点试做（非完整运行）');
    expect(runStatusSummary(completedTrial)).toBe('已完成 · 1 项已保存产物');
    expect(runScopeExplanation(completedTrial)).toContain('不代表整个案例完成');
    expect(runScopeLabel({ executionMode: 'case' })).toBe('完整案例运行');
    expect(runScopeLabel({ executionMode: 'imported' })).toBe('历史导入运行');
    expect(runScopeExplanation({ executionMode: 'imported' })).toContain('没有重新调用模型');
    expect(runScopeExplanation({ executionMode: 'imported' })).toContain('不计入本轮执行');
    expect(runScopeLabel({ executionMode: 'external-host' })).toBe('本 Space 发起的领域运行');
    expect(runScopeExplanation({ executionMode: 'external-host' })).toContain('真实运行记录');
    expect(runScopeExplanation({ executionMode: 'external-host' })).toContain('不等于内容质量通过');
    expect(runScopeLabel({})).toBe('运行范围未记录');
    expect(runScopeLabel({ executionMode: 'future-mode' })).toBe('运行范围未知（future-mode）');
    expect(runScopeExplanation({ executionMode: 'future-mode' })).toContain('不能推断已完成整个案例');
  });
});
