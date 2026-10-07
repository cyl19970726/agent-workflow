import type { ComparisonReadingDto } from '@signal-room/workflow-space-api/contracts';

export function exactComparisonSubjects(reading: ComparisonReadingDto): NonNullable<ComparisonReadingDto['baseline']>[] | null {
  if (reading.status !== 'ready' || !reading.baseline || !reading.candidate) return null;
  const sides = [reading.baseline, reading.candidate];
  if (sides[0].side !== 'baseline' || sides[1].side !== 'candidate') return null;
  if (sides.some(side => side.review.runId !== side.runId || !side.review.assetIds.includes(side.asset.id))) return null;
  return sides;
}
