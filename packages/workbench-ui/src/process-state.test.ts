import { describe, expect, it } from 'vitest';
import { latestOccurrence, needsFinalProcessRefresh } from './process-state.js';
import type { OccurrenceDto } from '@signal-room/workflow-space-api/contracts';

describe('live process selection', () => {
  it('refreshes the final process snapshot exactly on the same run active-to-terminal transition', () => {
    expect(needsFinalProcessRefresh({ id: 'run-1', state: 'running' }, { id: 'run-1', state: 'failed' }, true)).toBe(true);
    expect(needsFinalProcessRefresh({ id: 'run-1', state: 'running' }, { id: 'run-1', state: 'completed' }, true)).toBe(true);
    expect(needsFinalProcessRefresh({ id: 'run-1', state: 'failed' }, { id: 'run-1', state: 'failed' }, true)).toBe(false);
    expect(needsFinalProcessRefresh({ id: 'run-1', state: 'running' }, { id: 'run-2', state: 'failed' }, true)).toBe(false);
  });

  it('defaults to the latest saved round while retaining an exact earlier choice', () => {
    const occurrences = [
      { id: 'round-2', round: 2 }, { id: 'round-1', round: 1 }, { id: 'round-2b', round: 2 },
    ] as OccurrenceDto[];
    expect(latestOccurrence(occurrences)?.id).toBe('round-2b');
    expect(latestOccurrence(occurrences, 'round-1')?.id).toBe('round-1');
  });
});
