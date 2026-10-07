export interface RunStatusFacts {
  state: string;
  taskState: string | null;
  progress?: string | null;
  assetCount: number;
}

const stateLabels: Record<string, string> = {
  completed: '已完成', succeeded: '已完成', success: '已完成',
  failed: '失败', running: '运行中', in_progress: '运行中',
  pending: '待运行', queued: '排队中', starting: '准备执行',
  needs_review: '待审阅', blocked: '受阻', canceled: '已取消', cancelled: '已取消',
  produced: '已生成', partial: '部分覆盖',
};

export function stateLabel(value: string | null | undefined): string {
  return value ? stateLabels[value] || value : '未记录';
}

export function runStatusSummary(run: RunStatusFacts): string {
  const state = stateLabel(run.state);
  const progress = run.progress?.trim() ||
    ((run.state === 'queued' || run.state === 'pending') && run.taskState === 'running' ? '已派发，准备执行' : '');
  const availability = run.assetCount === 0 ? '尚无可读产物' : `${run.assetCount} 项已保存产物`;
  return [state, progress, availability].filter(Boolean).join(' · ');
}

export function mergeCurrentRun<T extends { id: string; caseId: string }>(runs: readonly T[], current: T | undefined, caseId: string | undefined): T[] {
  if (!current || current.caseId !== caseId) return [...runs];
  const index = runs.findIndex(item => item.id === current.id);
  return index < 0 ? [current, ...runs] : runs.map(item => item.id === current.id ? current : item);
}
