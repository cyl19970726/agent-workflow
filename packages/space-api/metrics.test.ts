import { describe, expect, it } from 'vitest';
import { projectProcess } from '../spaces/process-projection.js';
import { ProcessSchema } from './contracts.js';
import { occurrenceDto } from './read-model.js';

describe('Space process metrics contract', () => {
  it('returns every technical step and attempt, including an unmapped program task', () => {
    const run = {runId: 'run'} as Parameters<typeof projectProcess>[0]['run'];
    const step = {id: 'task', runId: 'run', key: 'prepare', kind: 'task' as const, workflowId: 'flow',
      workflowRevision: '1', inputFingerprint: 'i', configFingerprint: 'c', state: 'succeeded' as const,
      validation: 'valid' as const};
    const attempt = {id: 'a', runId: 'run', stepRunId: 'task', state: 'succeeded' as const};
    const events = [
      {id: 'e1', runId: 'run', stepRunId: 'task', attemptId: 'a', seq: 1, type: 'step.started', timestamp: '2026-01-01T00:00:00.000Z'},
      {id: 'e2', runId: 'run', stepRunId: 'task', attemptId: 'a', seq: 2, type: 'step.completed', timestamp: '2026-01-01T00:00:00.250Z'},
    ];
    const view = projectProcess({run, contractSource: 'unknown', steps: [step], attempts: [attempt],
      contexts: [], outputs: [], assets: [], relations: [], events});
    const parsed = ProcessSchema.parse({runId: 'run', versionId: 'version', caseId: 'case',
      contractSource: view.contractSource, coverage: view.coverage, unmappedStepIds: view.unmappedStepIds,
      nodes: [], occurrences: view.occurrences.map(value => occurrenceDto({assets: [], runs: []}, value)),
      stepMetrics: view.stepMetrics, metrics: view.metrics, graphUrl: null, graphState: null});
    expect(parsed.stepMetrics).toMatchObject([{stepRunId: 'task', wallDurationMs: 250,
      attempts: [{durationMs: 250, usage: null}]}]);
    expect(parsed.occurrences[0]?.metrics.wallDurationMs).toBe(250);
    expect(parsed.metrics).toMatchObject({wallDurationMs: 250, inclusiveStepDurationSumMs: 250,
      usage: null, usageCoverage: 'not_applicable'});
  });
});
