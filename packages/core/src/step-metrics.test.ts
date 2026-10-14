import { describe, expect, it } from 'vitest';
import type { AttemptRecord, StepRecord, WorkflowEvent } from './ports.js';
import { projectStepMetrics as project, summarizeStepMetrics } from './step-metrics.js';
const projectStepMetrics = (...args: Parameters<typeof project> extends [...infer Inputs, string | null] ? Inputs : never) =>
  project(...args, '2023-11-14T22:13:22.000Z');

const step = (id: string, kind: StepRecord['kind'] = 'agent'): StepRecord => ({
  id, runId: 'run', key: id, kind, workflowId: 'flow', workflowRevision: '1',
  inputFingerprint: 'i', configFingerprint: 'c', state: 'succeeded', validation: 'valid',
});
const attempt = (id: string, stepRunId: string, state: AttemptRecord['state'] = 'succeeded'): AttemptRecord =>
  ({id, runId: 'run', stepRunId, state});
let sequence = 0;
const event = (stepRunId: string, attemptId: string, type: string, ms: number, data?: unknown): WorkflowEvent => ({
  id: `e${++sequence}`, runId: 'run', stepRunId, attemptId, type, seq: sequence,
  timestamp: new Date(1_700_000_000_000 + ms).toISOString(), data,
});

describe('step metrics projection', () => {
  it('accounts for retries once, including SIWC turns and a failed attempt', () => {
    const events = [
      event('build', 'a1', 'step.started', 0),
      event('build', 'a1', 'siwc.response', 100, {responseId: 'r1', usage: {input_tokens: 10, output_tokens: 4, total_tokens: 14,
        input_tokens_details: {cached_tokens: 2}}}),
      event('build', 'a1', 'siwc.response', 101, {responseId: 'r1', usage: {input_tokens: 10, output_tokens: 4, total_tokens: 14,
        input_tokens_details: {cached_tokens: 2}}}),
      event('build', 'a1', 'step.failed', 200),
      event('build', 'a2', 'step.started', 300),
      event('build', 'a2', 'siwc.response', 400, {responseId: 'r2', usage: {input_tokens: 8, output_tokens: 3, total_tokens: 11}}),
      event('build', 'a2', 'step.completed', 500),
    ];
    const [result] = projectStepMetrics([step('build')], [attempt('a1', 'build', 'failed'), attempt('a2', 'build')], events);
    expect(result).toMatchObject({wallDurationMs: 500, sumAttemptDurationMs: 400, usageCoverage: 'complete',
      usage: {inputTokens: 18, outputTokens: 7, totalTokens: 25, cachedInputTokens: null}});
    expect(result!.attempts.map(value => value.durationMs)).toEqual([200, 200]);
    expect(result!.attempts[0]!.usage?.cachedInputTokens).toBe(2);
  });

  it('prefers normalized usage to its legacy SIWC echo and counts Decisions response once', () => {
    const events = [
      event('agent', 'a', 'step.started', 0),
      event('agent', 'a', 'siwc.response', 5, {responseId: 'r', usage: {input_tokens: 100, output_tokens: 20}}),
      event('agent', 'a', 'agent.usage', 6, {childRunId: 'sdk', usage: {inputTokens: 100, outputTokens: 20}}),
      event('agent', 'a', 'agent.completed', 7, {childRunId: 'sdk', usage: {inputTokens: 100, outputTokens: 20}}),
      event('agent', 'a', 'step.completed', 10),
      event('decision', 'd', 'step.started', 0),
      event('decision', 'd', 'decision.inference.response', 4, {requestId: 'req-1', usage: {inputTokens: 7, outputTokens: 2, totalTokens: 9}}),
      event('decision', 'd', 'decision.inference.response', 4, {requestId: 'req-1', usage: {inputTokens: 7, outputTokens: 2, totalTokens: 9}}),
      event('decision', 'd', 'decision.inference.response', 5, {requestId: 'req-2', usage: {inputTokens: 3, outputTokens: 1, totalTokens: 4}}),
      event('decision', 'd', 'decision.inference.completed', 5, {usage: {inputTokens: 7, outputTokens: 2, totalTokens: 9}}),
      event('decision', 'd', 'step.completed', 10),
    ];
    const result = projectStepMetrics([step('agent'), step('decision', 'decision')],
      [attempt('a', 'agent'), attempt('d', 'decision')], events);
    expect(result[0]?.usage?.inputTokens).toBe(100);
    expect(result[1]?.usage).toMatchObject({inputTokens: 10, outputTokens: 3, totalTokens: 13});
  });

  it('keeps missing and canceled measurements unknown, without counting reuse as another attempt', () => {
    const events = [event('build', 'a1', 'step.started', 0),
      event('build', 'a1', 'siwc.response', 50, {responseId: 'r1', usage: {input_tokens: 3}}),
      event('build', 'a1', 'step.failed', 100),
      event('build', 'a2', 'step.started', 150),
      event('build', 'a2', 'step.failed', 250),
      event('build', 'a2', 'step.reused', 260)];
    const [result] = projectStepMetrics([{...step('build'), state: 'canceled'}],
      [attempt('a1', 'build', 'failed'), attempt('a2', 'build', 'canceled')], events);
    expect(result).toMatchObject({wallDurationMs: 250, sumAttemptDurationMs: 200, usageCoverage: 'partial',
      usage: null, reportedTokens: {inputTokens: 3, outputTokens: null}});
    expect(result!.attempts).toHaveLength(2);
    expect(result!.attempts[1]).toMatchObject({state: 'canceled', usage: null, usageCoverage: 'unavailable'});
    const incomplete = projectStepMetrics([{...step('running', 'task'), state: 'running'}], [attempt('pending', 'running', 'running')],
      [event('running', 'pending', 'step.started', 0)])[0]!;
    expect(incomplete).toMatchObject({endedAt: null, wallDurationMs: null, usage: null,
      observedAt: '2023-11-14T22:13:22.000Z', elapsedSoFarMs: 2000, usageCoverage: 'not_applicable'});
  });

  it('marks an unreported SIWC turn partial and deduplicates legacy completion echoes', () => {
    const siwc = projectStepMetrics([step('siwc')], [attempt('a', 'siwc')], [
      event('siwc', 'a', 'step.started', 0),
      event('siwc', 'a', 'siwc.response', 10, {responseId: 'r1', usage: {input_tokens: 2, output_tokens: 1}}),
      event('siwc', 'a', 'siwc.response', 20, {responseId: 'r2'}),
      event('siwc', 'a', 'step.completed', 30),
    ])[0]!;
    expect(siwc.usageCoverage).toBe('partial');
    expect(siwc.usage).toBeNull();
    expect(siwc.reportedTokens).toMatchObject({inputTokens: 2, outputTokens: 1});
    const legacy = projectStepMetrics([step('legacy')], [attempt('b', 'legacy')], [
      event('legacy', 'b', 'agent.completed', 10, {threadId: 't', usage: {inputTokens: 9, outputTokens: 3}}),
      event('legacy', 'b', 'agent.completed', 11, {threadId: 't', usage: {inputTokens: 9, outputTokens: 3}}),
    ])[0]!;
    expect(legacy.usage).toMatchObject({inputTokens: 9, outputTokens: 3});
    const interrupted = projectStepMetrics([step('interrupted')], [attempt('c', 'interrupted', 'failed')], [
      event('interrupted', 'c', 'siwc.request', 0),
      event('interrupted', 'c', 'siwc.response', 10, {responseId: 'r3', usage: {input_tokens: 2, output_tokens: 1}}),
      event('interrupted', 'c', 'siwc.request', 20),
    ])[0]!;
    expect(interrupted.usage).toBeNull();
    expect(interrupted.reportedTokens).toMatchObject({inputTokens: 2, outputTokens: 1});
    expect(interrupted.usageCoverage).toBe('partial');
    const duplicated = projectStepMetrics([step('duplicated')], [attempt('d', 'duplicated', 'running')], [
      event('duplicated', 'd', 'siwc.request', 0), event('duplicated', 'd', 'siwc.request', 20),
      event('duplicated', 'd', 'siwc.response', 10, {responseId: 'same', usage: {input_tokens: 2, output_tokens: 1}}),
      event('duplicated', 'd', 'siwc.response', 11, {responseId: 'same', usage: {input_tokens: 2, output_tokens: 1}}),
    ])[0]!;
    expect(duplicated.usage).toBeNull();
    expect(duplicated.reportedTokens).toMatchObject({inputTokens: 2, outputTokens: 1});
    expect(duplicated.usageCoverage).toBe('partial');
    for (const kind of ['siwc', 'decision'] as const) {
      const type = kind === 'siwc' ? 'siwc.response' : 'decision.inference.response';
      const data = kind === 'siwc' ? {usage: {input_tokens: 7, output_tokens: 2}}
        : {usage: {inputTokens: 7, outputTokens: 2}};
      const anonymous = projectStepMetrics([step(kind, kind === 'decision' ? 'decision' : 'agent')],
        [attempt('anon', kind)], [event(kind, 'anon', type, 0, data), event(kind, 'anon', type, 1, data)])[0]!;
      expect(anonymous.usageCoverage).toBe('partial');
      expect(anonymous.usage).toBeNull();
      expect(anonymous.reportedTokens).toMatchObject({inputTokens: 7, outputTokens: 2});
    }
    const completionEchoes = projectStepMetrics([step('completion', 'decision')], [attempt('e', 'completion')], [
      event('completion', 'e', 'decision.inference.completed', 0, {usage: {inputTokens: 7, outputTokens: 2}}),
      event('completion', 'e', 'decision.inference.completed', 1, {usage: {inputTokens: 7, outputTokens: 2}}),
    ])[0]!;
    expect(completionEchoes.usageCoverage).toBe('partial');
    expect(completionEchoes.usage).toBeNull();
    expect(completionEchoes.reportedTokens).toMatchObject({inputTokens: 7, outputTokens: 2});
    expect(projectStepMetrics([step('bad')], [attempt('x', 'bad')], [
      event('bad', 'x', 'agent.usage', 0, null), event('bad', 'x', 'siwc.response', 10, null),
    ])[0]).toMatchObject({usage: null, reportedTokens: null, usageCoverage: 'unavailable'});
  });

  it('distinguishes parallel wall time from the sum of step time', () => {
    const events = [event('left', 'l', 'step.started', 0), event('right', 'r', 'step.started', 100),
      event('left', 'l', 'step.completed', 1000), event('right', 'r', 'step.completed', 1100)];
    const result = projectStepMetrics([step('left', 'task'), step('right', 'task')],
      [attempt('l', 'left'), attempt('r', 'right')], events);
    expect(summarizeStepMetrics(result)).toMatchObject({wallDurationMs: 1100, inclusiveStepDurationSumMs: 2000,
      usage: null, reportedTokens: null, usageCoverage: 'not_applicable'});
  });
});
