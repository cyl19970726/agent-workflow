import type { AttemptRecord, StepRecord, WorkflowEvent } from './ports.js';

/** Null means the provider or ledger did not report that dimension. */
export interface TokenUsageMetrics {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
}

export interface AttemptMetrics {
  id: string;
  state: AttemptRecord['state'];
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  observedAt: string | null;
  elapsedSoFarMs: number | null;
  usage: TokenUsageMetrics | null;
  /** Sum of reported values; a lower bound when coverage is partial. */
  reportedTokens: TokenUsageMetrics | null;
  /** Complete means each observed call reports input and output counts; optional detail dimensions may still be null. */
  usageCoverage: 'complete' | 'partial' | 'unavailable' | 'not_applicable';
}

export interface StepMetrics {
  stepRunId: string;
  runId: string;
  key: string;
  kind: StepRecord['kind'];
  state: StepRecord['state'];
  startedAt: string | null;
  endedAt: string | null;
  observedAt: string | null;
  elapsedSoFarMs: number | null;
  /** Elapsed wall time from the first start to the last terminal event. */
  wallDurationMs: number | null;
  /** Sum of attempt durations; null if any attempt lacks a terminal timestamp. */
  sumAttemptDurationMs: number | null;
  usage: TokenUsageMetrics | null;
  reportedTokens: TokenUsageMetrics | null;
  usageCoverage: AttemptMetrics['usageCoverage'];
  attempts: AttemptMetrics[];
}

export interface StepMetricsSummary {
  /** Wall interval across the listed steps, including overlap and idle gaps. */
  wallDurationMs: number | null;
  observedAt: string | null;
  elapsedSoFarMs: number | null;
  /** Inclusive sum of all technical steps; parent/child and parallel intervals can overlap. */
  inclusiveStepDurationSumMs: number | null;
  usage: TokenUsageMetrics | null;
  reportedTokens: TokenUsageMetrics | null;
  usageCoverage: AttemptMetrics['usageCoverage'];
}

type TokenKey = keyof TokenUsageMetrics;
const keys: readonly TokenKey[] = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function usageFrom(value: unknown): TokenUsageMetrics | null {
  const raw = asObject(value);
  if (!raw) return null;
  const inputDetails = asObject(raw.input_tokens_details);
  const outputDetails = asObject(raw.output_tokens_details);
  const usage: TokenUsageMetrics = {
    inputTokens: count(raw.inputTokens ?? raw.input_tokens),
    cachedInputTokens: count(raw.cachedInputTokens ?? inputDetails?.cached_tokens),
    outputTokens: count(raw.outputTokens ?? raw.output_tokens),
    reasoningOutputTokens: count(raw.reasoningOutputTokens ?? outputDetails?.reasoning_tokens),
    totalTokens: count(raw.totalTokens ?? raw.total_tokens),
  };
  return keys.some(key => usage[key] !== null) ? usage : null;
}
function timestamp(value: string | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}
function interval(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
}
type UsageProjection = Pick<AttemptMetrics, 'usage' | 'reportedTokens' | 'usageCoverage'>;
function sumTokens(usages: readonly (TokenUsageMetrics | null)[], requireAll: boolean): TokenUsageMetrics | null {
  if (!usages.some(value => value !== null)) return null;
  return Object.fromEntries(keys.map(key => {
    const known = usages.map(value => value?.[key]).filter((value): value is number => value !== null && value !== undefined);
    if (!known.length || requireAll && known.length !== usages.length) return [key, null];
    const sum = known.reduce((total, value) => total + value, 0);
    return [key, Number.isSafeInteger(sum) ? sum : null];
  })) as unknown as TokenUsageMetrics;
}
function maxTokens(usages: readonly (TokenUsageMetrics | null)[]): TokenUsageMetrics | null {
  if (!usages.some(value => value !== null)) return null;
  return Object.fromEntries(keys.map(key => {
    const known = usages.map(value => value?.[key]).filter((value): value is number => value !== null && value !== undefined);
    return [key, known.length ? known.reduce((max, value) => Math.max(max, value), 0) : null];
  })) as unknown as TokenUsageMetrics;
}
function samples(usages: readonly (TokenUsageMetrics | null)[], uncertain = false): UsageProjection {
  const reportedTokens = sumTokens(usages, false);
  if (!reportedTokens) return {usage: null, reportedTokens: null, usageCoverage: 'unavailable'};
  const complete = !uncertain && usages.every(value => value?.inputTokens !== null && value?.inputTokens !== undefined
    && value.outputTokens !== null);
  return {usage: complete ? sumTokens(usages, true) : null, reportedTokens,
    usageCoverage: complete ? 'complete' : 'partial'};
}
function combine(rows: readonly UsageProjection[]): UsageProjection {
  const applicable = rows.filter(row => row.usageCoverage !== 'not_applicable');
  if (!applicable.length) return {usage: null, reportedTokens: null, usageCoverage: 'not_applicable'};
  const reportedTokens = sumTokens(applicable.map(row => row.reportedTokens), false);
  if (!reportedTokens) return {usage: null, reportedTokens: null, usageCoverage: 'unavailable'};
  const complete = applicable.every(row => row.usageCoverage === 'complete');
  return {usage: complete ? sumTokens(applicable.map(row => row.usage), true) : null,
    reportedTokens, usageCoverage: complete ? 'complete' : 'partial'};
}

/**
 * Read only accounting from durable events. Prefer normalized agent.usage over
 * the same SDK's legacy SIWC response, and provider responses over completion
 * echoes. Each completed SIWC response is a separate billable turn.
 */
function attemptUsage(kind: StepRecord['kind'], events: readonly WorkflowEvent[]): UsageProjection {
  const ofType = (type: string) => events.filter(event => event.type === type);
  const completedSiwcResponses = new Set(ofType('siwc.response').map(event => {
    const responseId = asObject(event.data)?.responseId;
    return typeof responseId === 'string' && responseId ? responseId : 'anonymous';
  }));
  const unresolvedSiwcRequest = ofType('siwc.request').length > completedSiwcResponses.size;
  const generic = ofType('agent.usage');
  if (generic.length) {
    const latest = new Map<string, TokenUsageMetrics | null>();
    let unidentified = 0;
    for (const event of generic) {
      const data = asObject(event.data) ?? {};
      if (typeof data.childRunId !== 'string' && typeof data.threadId !== 'string') unidentified++;
      const identity = typeof data.childRunId === 'string' ? data.childRunId
        : typeof data.threadId === 'string' ? data.threadId : 'unknown';
      latest.set(identity, usageFrom(data.usage));
    }
    return samples([...latest.values()], unidentified > 1 || unresolvedSiwcRequest);
  }
  const siwc = ofType('siwc.response');
  if (siwc.length) {
    const unique = new Map<string, TokenUsageMetrics | null>();
    const anonymous: Array<TokenUsageMetrics | null> = [];
    for (const event of siwc) {
      const data = asObject(event.data) ?? {};
      if (typeof data.responseId === 'string' && data.responseId) unique.set(data.responseId, usageFrom(data.usage));
      else anonymous.push(usageFrom(data.usage));
    }
    const known = [...unique.values()];
    const conservative = known.length ? known : anonymous.length ? [maxTokens(anonymous)] : [];
    return samples(conservative, anonymous.length > 0 && (known.length > 0 || anonymous.length > 1) || unresolvedSiwcRequest);
  }
  const decisionResponses = ofType('decision.inference.response');
  if (decisionResponses.length) {
    const unique = new Map<string, TokenUsageMetrics | null>();
    const anonymous: Array<TokenUsageMetrics | null> = [];
    for (const event of decisionResponses) {
      const data = asObject(event.data) ?? {};
      const requestId = typeof data.requestId === 'string' && data.requestId ? data.requestId : null;
      if (requestId) unique.set(requestId, usageFrom(data.usage));
      else anonymous.push(usageFrom(data.usage));
    }
    const known = [...unique.values()];
    const conservative = known.length ? known : anonymous.length ? [maxTokens(anonymous)] : [];
    return samples(conservative, anonymous.length > 0 && (known.length > 0 || anonymous.length > 1)
      || ofType('decision.inference.error').length > 0);
  }
  const decisionCompletions = ofType('decision.inference.completed');
  if (decisionCompletions.length) {
    // A completion is an attempt-level echo, not a distinct model call. Without
    // request IDs, repeated records cannot safely be added together.
    const observed = decisionCompletions.map(event => usageFrom(asObject(event.data)?.usage));
    return samples([maxTokens(observed)], decisionCompletions.length > 1);
  }
  const legacy = ofType('agent.completed');
  if (legacy.length) {
    const latest = new Map<string, TokenUsageMetrics | null>();
    let unidentified = 0;
    for (const event of legacy) {
      const data = asObject(event.data) ?? {};
      if (typeof data.childRunId !== 'string' && typeof data.threadId !== 'string') unidentified++;
      const identity = typeof data.childRunId === 'string' ? data.childRunId
        : typeof data.threadId === 'string' ? data.threadId : 'unknown';
      latest.set(identity, usageFrom(data.usage));
    }
    return samples([...latest.values()], unidentified > 1);
  }
  const modelAttempt = kind === 'agent' || events.some(event => event.type.startsWith('siwc.')
    || event.type === 'decision.inference.started' || event.type === 'decision.inference.error');
  return modelAttempt ? samples([]) : {usage: null, reportedTokens: null, usageCoverage: 'not_applicable'};
}

export function summarizeStepMetrics(steps: readonly StepMetrics[]): StepMetricsSummary {
  const starts = steps.map(step => step.startedAt).filter((value): value is string => value !== null).sort();
  const ends = steps.map(step => step.endedAt).filter((value): value is string => value !== null).sort();
  const allEnded = steps.length > 0 && steps.every(step => step.wallDurationMs !== null);
  const observedAt = steps.find(step => step.observedAt !== null)?.observedAt ?? null;
  const active = steps.some(step => step.elapsedSoFarMs !== null);
  const usage = combine(steps);
  return {
    wallDurationMs: allEnded ? interval(starts[0] ?? null, ends.at(-1) ?? null) : null,
    observedAt,
    elapsedSoFarMs: active ? interval(starts[0] ?? null, observedAt) : null,
    inclusiveStepDurationSumMs: allEnded ? steps.reduce((sum, step) => sum + step.wallDurationMs!, 0) : null,
    usage: usage.usage,
    reportedTokens: usage.reportedTokens,
    usageCoverage: usage.usageCoverage,
  };
}

export function projectStepMetrics(steps: readonly StepRecord[], attempts: readonly AttemptRecord[], events: readonly WorkflowEvent[], observedAtValue: string | null): StepMetrics[] {
  const observedAt = timestamp(observedAtValue ?? undefined);
  const attemptsByStep = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    const list = attemptsByStep.get(attempt.stepRunId) ?? [];
    list.push(attempt);
    attemptsByStep.set(attempt.stepRunId, list);
  }
  const eventsByAttempt = new Map<string, WorkflowEvent[]>();
  for (const event of events) if (event.stepRunId && event.attemptId) {
    const key = `${event.stepRunId}\0${event.attemptId}`;
    const list = eventsByAttempt.get(key) ?? [];
    list.push(event);
    eventsByAttempt.set(key, list);
  }
  return steps.map(step => {
    const stepAttempts = attemptsByStep.get(step.id) ?? [];
    const metrics: AttemptMetrics[] = stepAttempts.map(attempt => {
      const own = eventsByAttempt.get(`${step.id}\0${attempt.id}`) ?? [];
      const startedAt = timestamp(own.find(event => event.type === 'step.started')?.timestamp);
      const endedAt = timestamp([...own].reverse().find(event => event.type === 'step.completed' || event.type === 'step.failed')?.timestamp);
      const usage = attemptUsage(step.kind, own);
      const elapsedSoFarMs = ['queued', 'running', 'waiting'].includes(attempt.state) && !endedAt
        ? interval(startedAt, observedAt) : null;
      return {id: attempt.id, state: attempt.state, startedAt, endedAt,
        observedAt: elapsedSoFarMs !== null ? observedAt : null,
        elapsedSoFarMs, durationMs: interval(startedAt, endedAt), ...usage};
    });
    const starts = metrics.map(attempt => attempt.startedAt).filter((value): value is string => value !== null).sort();
    const ends = metrics.map(attempt => attempt.endedAt).filter((value): value is string => value !== null).sort();
    const allEnded = metrics.length > 0 && metrics.every(attempt => attempt.durationMs !== null);
    const usage = metrics.length ? combine(metrics) : step.kind === 'agent' ? samples([])
      : {usage: null, reportedTokens: null, usageCoverage: 'not_applicable' as const};
    const elapsedSoFarMs = ['queued', 'running', 'waiting'].includes(step.state) && !allEnded
      ? interval(starts[0] ?? null, observedAt) : null;
    return {stepRunId: step.id, runId: step.runId, key: step.key, kind: step.kind, state: step.state,
      startedAt: starts[0] ?? null, endedAt: allEnded ? ends.at(-1) ?? null : null,
      observedAt: elapsedSoFarMs !== null ? observedAt : null, elapsedSoFarMs,
      wallDurationMs: allEnded ? interval(starts[0] ?? null, ends.at(-1) ?? null) : null,
      sumAttemptDurationMs: allEnded ? metrics.reduce((sum, attempt) => sum + attempt.durationMs!, 0) : null,
      ...usage,
      attempts: metrics};
  });
}
