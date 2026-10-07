import type { ReviewDto } from '@signal-room/workflow-space-api/contracts';

export function reviewJudgeLabel(review: ReviewDto): string {
  return `${review.judge.kind === 'human' ? '人工评价' : review.judge.kind === 'agent' ? '独立 Agent 评价' : `评价（${review.judge.kind}）`} · ${review.judge.id}`;
}

export function reviewStandardLabel(review: ReviewDto): string {
  return `${review.standard.id} · 修订 ${review.standard.revision}`;
}

export function reviewBaselineLabel(review: ReviewDto): string {
  return review.baselineReviewId ? '有准确关联基线评价' : '未记录关联基线评价';
}
