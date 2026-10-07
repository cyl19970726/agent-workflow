import { describe, expect, it } from 'vitest';
import type { ReviewDto } from '@signal-room/workflow-space-api/contracts';
import { reviewBaselineLabel, reviewJudgeLabel, reviewStandardLabel } from './review-presentation.js';

describe('saved independent review identity', () => {
  const review = {
    judge: { kind: 'agent', id: 'round05-agent-a' },
    standard: { id: 'round05-mimo-independent', revision: '1' },
    baselineReviewId: null,
    configuration: { promptRevision: 'round05-a-v1' },
  } as unknown as ReviewDto;

  it('shows the saved judge and standard rather than a prompt revision or inferred baseline', () => {
    expect(reviewJudgeLabel(review)).toBe('独立 Agent 评价 · round05-agent-a');
    expect(reviewStandardLabel(review)).toBe('round05-mimo-independent · 修订 1');
    expect(reviewStandardLabel(review)).not.toContain('round05-a-v1');
    expect(reviewBaselineLabel(review)).toBe('未记录关联基线评价');
    expect(reviewJudgeLabel({ ...review, judge: { kind: 'human', id: 'editor' } })).toBe('人工评价 · editor');
    expect(reviewBaselineLabel({ ...review, baselineReviewId: 'review-base' })).toBe('有准确关联基线评价');
  });
});
