import { describe, expect, it } from 'vitest';
import { attemptDurationLabel, stepDurationLabel, stepTokenLabel } from './step-metrics-presentation.js';

describe('step metric labels', () => {
  it('distinguishes terminal duration, live elapsed time, and unavailable time', () => {
    expect(stepDurationLabel({ wallDurationMs: 63_400, elapsedSoFarMs: null })).toBe('耗时 1 分 3 秒');
    expect(stepDurationLabel({ wallDurationMs: null, elapsedSoFarMs: 2_500 })).toBe('已运行 2.5 秒');
    expect(attemptDurationLabel({ durationMs: 80, elapsedSoFarMs: null })).toBe('耗时 80 毫秒');
    expect(stepDurationLabel({ wallDurationMs: null, elapsedSoFarMs: null })).toBe('耗时未记录');
  });

  it('keeps missing token dimensions unknown and marks partial values as lower bounds', () => {
    const counts = { inputTokens: 1200, cachedInputTokens: null, outputTokens: 50,
      reasoningOutputTokens: null, totalTokens: null };
    expect(stepTokenLabel({ usage: counts, reportedTokens: counts, usageCoverage: 'complete' }))
      .toBe('Token：输入 1,200 · 输出 50 · 缓存输入 未记录');
    expect(stepTokenLabel({ usage: null, reportedTokens: counts, usageCoverage: 'partial' }))
      .toBe('Token 已上报下限：输入 1,200 · 输出 50 · 缓存输入 未记录');
    expect(stepTokenLabel({ usage: null, reportedTokens: null, usageCoverage: 'unavailable' })).toBe('Token 未记录');
    expect(stepTokenLabel({ usage: null, reportedTokens: null, usageCoverage: 'not_applicable' })).toBe('无模型调用');
  });
});
