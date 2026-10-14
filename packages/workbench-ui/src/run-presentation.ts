export interface RunStatusFacts {
  state: string;
  taskState: string | null;
  progress?: string | null;
  assetCount: number;
}

export interface RunScopeFacts { executionMode?: string | null }

export function runScopeLabel(run: RunScopeFacts): string {
  if (run.executionMode === 'research-trial') return '研究节点试做（非完整运行）';
  if (run.executionMode === 'case') return '完整案例运行';
  if (run.executionMode === 'imported') return '历史导入运行';
  if (run.executionMode === 'external-host') return '本 Space 发起的领域运行';
  return run.executionMode ? `运行范围未知（${run.executionMode}）` : '运行范围未记录';
}

export function runScopeExplanation(run: RunScopeFacts): string {
  if (run.executionMode === 'research-trial') return '图展示完整方法结构及已保存的运行记录；本次只是一场研究节点试做。节点出现在图上不代表已执行；试做状态“已完成”不代表整个案例完成。';
  if (run.executionMode === 'case') return '图展示完整方法结构及本次已保存的运行记录；运行状态仍需与实际节点和产物分别阅读。';
  if (run.executionMode === 'imported') return '这次运行及产物来自已保存的历史记录，导入没有重新调用模型，也不计入本轮执行；应按原运行状态和证据判断结果。';
  if (run.executionMode === 'external-host') return '本 Space 关联领域宿主的原生执行；根流程在模型前绑定，辅助步骤与输入准备按准确来源和真实运行记录同步。技术完成不等于内容质量通过或业务采用。';
  return '图展示完整方法结构及已保存的运行记录；此记录未声明可识别的运行范围，不能推断已完成整个案例。';
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
