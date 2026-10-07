import { describe, expect, it } from 'vitest';
import type { ComparisonReadingDto } from '@signal-room/workflow-space-api/contracts';
import { exactComparisonSubjects } from './comparison-reading.js';

describe('saved comparison subjects', () => {
  const side = (kind: 'baseline' | 'candidate', runId: string, assetId: string) => ({ side: kind, runId, asset: { id: assetId }, review: { runId, assetIds: [assetId] } });
  const pair = { status: 'ready', baseline: side('baseline', 'baseline-run', 'baseline-asset'), candidate: side('candidate', 'candidate-run', 'candidate-asset') } as ComparisonReadingDto;

  it('keeps two exact independent review targets and refuses missing or mismatched sides', () => {
    expect(exactComparisonSubjects(pair)?.map(subject => subject.asset.id)).toEqual(['baseline-asset', 'candidate-asset']);
    expect(exactComparisonSubjects({ ...pair, status: 'unavailable' })).toBeNull();
    expect(exactComparisonSubjects({ ...pair, candidate: null })).toBeNull();
    expect(exactComparisonSubjects({ ...pair, candidate: { ...pair.candidate!, review: { ...pair.candidate!.review, runId: 'other-run' } } })).toBeNull();
    expect(exactComparisonSubjects({ ...pair, baseline: { ...pair.baseline!, review: { ...pair.baseline!.review, assetIds: ['other-asset'] } } })).toBeNull();
  });
});
