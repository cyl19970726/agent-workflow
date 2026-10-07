import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanAttemptDto, PlanCommandReceiptDto, PlanEntryDto, SpaceSummaryDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi, SpaceApiError } from './api.js';
import { shouldCollapsePlanAfterCommand } from './plan-transition.js';

export interface PlanActionProps {
  api: SpaceApi;
  spaceId: string;
  cacheScope: string;
  summary: SpaceSummaryDto;
  caseId?: string;
  viewedRunId?: string;
  planId?: string;
  entryId?: string;
  onSelect: (planId?: string, entryId?: string) => void;
  onEntryContext: (entry: PlanEntryDto) => void;
  onRun: (run: { id: string; caseId: string; versionId: string }, options?: { collapsePlan: boolean }) => void;
  onAsset: (assetId: string) => void;
  onComparison: (comparisonId: string) => void;
  evidenceOpen: boolean;
  onEvidenceToggle: (open: boolean) => void;
  versionLabelFor: (versionId: string) => string | undefined;
}

function readableError(error: unknown): string {
  if (error instanceof SpaceApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : '请求失败。';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    frozen: '已冻结', missing: '尚未运行', queued: '已排队', running: '运行中',
    needs_review: '待评价', failed: '失败', completed: '已完成', interrupted: '已中断',
    pending: '待处理', canceled: '已取消', reviewed: '已评价',
  };
  return labels[status] || status;
}

function judgeLabel(kind: string): string {
  return kind === 'agent' ? 'Agent 评价' : kind === 'human' ? '人工评价' : kind;
}

function FactualSections({ sections }: { sections: PlanEntryDto['inputSections'] }) {
  return sections.length ? <div className="sw-plan-sections">{sections.map((section, index) => <section key={`${section.title}-${index}`}><strong>{section.title}</strong><p>{section.text}</p>{section.pointer && <small>{section.pointer}</small>}</section>)}</div> : <p className="sw-muted">该冻结条目没有可读的业务输入说明。</p>;
}

function AttemptEvidence({ attempt, entry, onRun }: { attempt: PlanAttemptDto; entry: PlanEntryDto; onRun: PlanActionProps['onRun'] }) {
  return <article className="sw-plan-attempt"><div><strong>第 {attempt.attempt} 次尝试 · {statusLabel(attempt.status)}</strong><button onClick={() => onRun({ id: attempt.runId, caseId: entry.caseId, versionId: entry.versionId })}>查看准确运行</button></div><small>Run {attempt.runId}{attempt.task ? ` · 任务 ${statusLabel(attempt.task.status)}` : ''}{attempt.task?.error ? ` · ${attempt.task.error}` : ''}</small>{attempt.reviews.length ? attempt.reviews.map(review => {
    const proof = attempt.judgeEvidence.find(item => item.reviewId === review.id);
    return <section className="sw-plan-review" key={review.id}><h5>独立四问 · {judgeLabel(review.judge.kind)} / {review.judge.id}</h5><p>标准 {review.standard.id} · {review.standard.revision} · 资产 {review.assetIds.join('、') || '未绑定'}</p><p>判者 profile：{proof?.verified ? '已核验' : proof ? '未通过核验' : '未记录核验'}</p><dl><dt>好</dt><dd>{review.answers.good}</dd><dt>不足</dt><dd>{review.answers.bad}</dd><dt>改进</dt><dd>{review.answers.improvement}</dd><dt>未解决</dt><dd>{review.answers.unresolved}</dd></dl>{review.evidence.length ? <details><summary>保存的评价证据</summary>{review.evidence.map((item, index) => <p key={index}>{item}</p>)}</details> : <p className="sw-muted">没有保存评价证据。</p>}{proof && <details><summary>判者 profile 核验依据</summary><p>预期 profile hash：{proof.expectedProfileHash || '未记录'}</p><p>观测 profile hash：{proof.observedProfileHash || '未记录'}</p>{Object.keys(proof.differences).length > 0 && <pre>{JSON.stringify(proof.differences, null, 2)}</pre>}</details>}</section>;
  }) : <p className="sw-muted">本次尝试没有保存独立四问评价。</p>}</article>;
}

export function PlanAction({ api, spaceId, cacheScope, summary, caseId, viewedRunId, planId, entryId, onSelect, onEntryContext, onRun, onAsset, onComparison, evidenceOpen, onEvidenceToggle, versionLabelFor }: PlanActionProps) {
  const client = useQueryClient();
  const [receipt, setReceipt] = useState<PlanCommandReceiptDto>();
  const plans = useInfiniteQuery({ queryKey: ['space', cacheScope, spaceId, 'plans'], queryFn: ({ pageParam, signal }) => api.plans(pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined });
  const planDetail = useQuery({ queryKey: ['space', cacheScope, spaceId, 'plan', planId], queryFn: ({ signal }) => api.plan(planId!, signal), enabled: !!planId });
  const entryQuery = useQuery({ queryKey: ['space', cacheScope, spaceId, 'plan-entry', planId, entryId], queryFn: ({ signal }) => api.planEntry(planId!, entryId!, signal), enabled: !!planId && !!entryId, refetchInterval: query => query.state.data && ['queued', 'running', 'interrupted'].includes(query.state.data.status) && document.visibilityState === 'visible' ? 3000 : false });
  const comparisons = useInfiniteQuery({ queryKey: ['space', cacheScope, spaceId, 'plan-comparisons', planId], queryFn: ({ pageParam, signal }) => api.planComparisons(planId!, pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined, enabled: !!planId && evidenceOpen });
  const issues = useInfiniteQuery({ queryKey: ['space', cacheScope, spaceId, 'plan-issues', planId], queryFn: ({ pageParam, signal }) => api.planIssues(planId!, pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined, enabled: !!planId && evidenceOpen });
  const entry = entryQuery.data;
  useEffect(() => { if (entry) onEntryContext(entry); }, [entry?.entryId, entry?.versionId, entry?.caseId]);
  const csrf = summary.csrfToken || '';
  const command = useMutation({ mutationFn: async (kind: 'start' | 'resume') => {
    if (!entry || !planId || !entryId) throw new Error('请先选择冻结计划条目。');
    if (kind === 'start') return api.startPlanEntry(planId, entryId, 1, entry.manifest.id, csrf);
    const target = entry.actions.resumeTarget;
    if (!target) throw new Error('没有已核实的同一运行可恢复。');
    return api.dispatchPlanRun(planId, entryId, target.attempt, target.runId, csrf);
  }, onSuccess: result => {
    setReceipt(result);
    onRun({ id: result.runId, caseId: result.caseId, versionId: result.versionId }, { collapsePlan: shouldCollapsePlanAfterCommand(result) });
    void client.invalidateQueries({ queryKey: ['space', cacheScope, spaceId] });
  } });
  useEffect(() => { setReceipt(undefined); command.reset(); }, [planId, entryId]);
  const availablePlans = plans.data?.pages.flatMap(page => page.items) || [];
  const availableEntries = planDetail.data?.entries.filter(item => !caseId || item.caseId === caseId) || [];
  const startAllowed = !!entry && summary.capabilities.write && !!csrf && entry.actions.start && entry.nextAttempt === 1 && !command.isPending;
  const resumeAllowed = !!entry && summary.capabilities.write && !!csrf && entry.actions.resume && !!entry.actions.resumeTarget && !command.isPending;
  return <section className="sw-plan-action" aria-label="计划内运行">
    <div className="sw-plan-head"><div><small>冻结计划</small><h3>计划内运行</h3></div><span>显式操作 · 准确条目</span></div>
    <div className="sw-plan-pickers"><label>计划<select aria-label="选择冻结计划" value={planId || ''} onChange={event => onSelect(event.target.value || undefined, undefined)}><option value="">选择计划</option>{availablePlans.map(item => <option key={item.id} value={item.id}>{item.question} · {statusLabel(item.status)} · {item.createdAt.slice(0, 10)} · {item.id.slice(0, 8)}</option>)}</select></label>{plans.hasNextPage && <button onClick={() => void plans.fetchNextPage()}>更多计划</button>}<label>条目<select aria-label="选择计划条目" value={entryId || ''} onChange={event => onSelect(planId, event.target.value || undefined)} disabled={!planId}><option value="">选择条目</option>{availableEntries.map(item => <option key={item.id} value={item.id}>{item.side === 'baseline' ? '基线' : item.side === 'candidate' ? '候选' : item.side} · {statusLabel(item.status)} · {item.caseId}</option>)}</select></label></div>
    {plans.error && <p className="sw-plan-error" role="alert">计划列表：{readableError(plans.error)} <button onClick={() => void plans.refetch()}>重试</button></p>}
    {planId && planDetail.error && <p className="sw-plan-error" role="alert">计划详情：{readableError(planDetail.error)} <button onClick={() => void planDetail.refetch()}>重试</button></p>}
    {entryId && !entry && (entryQuery.error ? <p className="sw-plan-error" role="alert">条目：{readableError(entryQuery.error)} <button onClick={() => void entryQuery.refetch()}>重试</button></p> : <p className="sw-muted">正在读取冻结条目与任务清单…</p>)}
    {entry && <>
      <div className="sw-plan-primary">
        <strong>{entry.side === 'baseline' ? '基线' : entry.side === 'candidate' ? '候选' : entry.side} · {entry.caseTitle}</strong>
        <span>{statusLabel(entry.status)} · {entry.inputSummary.length ? entry.inputSummary.join(' · ') : `${entry.manifest.slots.length} 个冻结输入资产`} · {entry.availability.state === 'available' ? '可执行' : entry.availability.state === 'unavailable' ? '不可执行' : '可执行性未知'}</span>
        {entry.availability.reason && <small>{entry.availability.reason}</small>}
      </div>
      <div className="sw-plan-command">
        <button disabled={!startAllowed} onClick={() => void command.mutateAsync('start').catch(() => undefined)}>{command.isPending ? '正在提交…' : '开始运行'}</button>
        {entry.actions.resume && <button disabled={!resumeAllowed} onClick={() => void command.mutateAsync('resume').catch(() => undefined)}>恢复同一排队运行</button>}
        <small>{entry.actions.reason || (!summary.capabilities.write || !csrf ? '当前宿主未开放运行命令。' : entry.nextAttempt !== 1 ? '本次界面只发起首次尝试。' : '')}</small>
      </div>
      {command.error && <p className="sw-plan-error" role="alert">{readableError(command.error)}；选择和已读内容已保留。</p>}
      {receipt && <p className="sw-plan-receipt" role="status">Run {receipt.runId} · {statusLabel(receipt.status)} · {receipt.dispatched ? '已定向派发' : receipt.status === 'queued' ? `已排队，派发未完成${receipt.dispatchError ? `：${receipt.dispatchError}` : ''}` : '已有运行记录，本次未重复派发'}</p>}
      {viewedRunId && !entry.attempts.some(attempt => attempt.runId === viewedRunId) && <p className="sw-plan-error">当前查看的 Run {viewedRunId} 不在此条目{entry.attemptsTruncated ? '最近显示的尝试' : '保存的尝试'}中；请核对运行与计划关系。</p>}
      <div className="sw-plan-details">
        <details className="sw-plan-inputs"><summary>阅读完整目标、要求与冻结材料</summary>
          <FactualSections sections={entry.inputSections} />
          <h4>冻结材料</h4>
          {entry.manifest.slots.length ? entry.manifest.slots.map((slot, index) => <p key={`${slot.slot}-${slot.asset.id}-${index}`}><strong>{slot.slot}</strong> · {slot.asset.title} · {slot.asset.schema.namespace}/{slot.asset.schema.revision}<br /><small>资产 {slot.asset.id} · payload {slot.payloadHash}</small> <button onClick={() => onAsset(slot.asset.id)}>阅读材料</button></p>) : <p className="sw-muted">清单未记录材料槽位。</p>}
        </details>
        <details className="sw-plan-technical"><summary>准确身份与冻结标准</summary>
          <dl><dt>准确方法</dt><dd>{versionLabelFor(entry.versionId) || entry.versionId}<br /><small>{entry.versionId}</small></dd><dt>输入清单</dt><dd>{entry.manifest.id}</dd><dt>清单 hash</dt><dd>{entry.manifest.hash}</dd><dt>冻结标准</dt><dd>{entry.standard.id} · {entry.standard.revision}</dd><dt>Case</dt><dd>{entry.manifest.caseId}</dd></dl>
          <details><summary>冻结标准全文</summary><p>{entry.standard.content}</p></details>
          <p>原始输入与前稿关系以准确资产记录为准。</p>
        </details>
        <details className="sw-plan-queue"><summary>当前任务清单（{entry.queue.length}{entry.queueTruncated ? '+，仍有未显示任务' : ''}）</summary>{entry.queue.length ? entry.queue.map(task => <p key={task.runId}>{statusLabel(task.status)} · Run {task.runId} · 条目 {task.entryId || '未关联'} · 方法 {task.versionId} · executor {task.executorKey}</p>) : <p className="sw-muted">当前没有记录的任务。</p>}</details>
        <details className="sw-plan-attempts"><summary>准确尝试与独立评价（{entry.attempts.length}{entry.attemptsTruncated ? '+' : ''}）</summary>{entry.attempts.length ? entry.attempts.map(attempt => <AttemptEvidence key={`${attempt.attempt}-${attempt.runId}`} attempt={attempt} entry={entry} onRun={onRun} />) : <p className="sw-muted">尚无计划内尝试。</p>}{entry.attemptsTruncated && <p className="sw-muted">这里只展示最近尝试；更早记录可按准确尝试读取。</p>}<h4>所需评价覆盖</h4>{entry.requiredJudgeCoverage.map((coverage, index) => <p key={`${coverage.kind}-${coverage.id}-${index}`}>{judgeLabel(coverage.kind)} / {coverage.id}：{coverage.reviewIds.length} 份已核验，{coverage.unverifiedReviewIds.length} 份未核验</p>)}</details>
      </div>
    </>}
    {planId && <div className="sw-plan-evidence"><button onClick={() => onEvidenceToggle(!evidenceOpen)}>{evidenceOpen ? '收起计划证据' : '查看成对比较与问题'}</button>{evidenceOpen && <><h4>成对比较</h4>{comparisons.data?.pages.flatMap(page => page.items).map(item => <article key={item.id}><p>{item.conclusion}</p><button onClick={() => onComparison(item.id)}>并看准确评价对象</button><small>基线条目 {item.baselineEntryId} · 候选条目 {item.candidateEntryId}</small><details><summary>准确评价与改变条件</summary><p>评价 {item.baselineReviewId} / {item.candidateReviewId}</p><pre>{JSON.stringify(item.changedConditions, null, 2)}</pre></details></article>)}{!comparisons.isPending && !comparisons.data?.pages.some(page => page.items.length) && <p className="sw-muted">没有保存成对比较。</p>}{comparisons.error && <p className="sw-plan-error">{readableError(comparisons.error)} <button onClick={() => void comparisons.refetch()}>重试</button></p>}{comparisons.hasNextPage && <button onClick={() => void comparisons.fetchNextPage()}>加载更多比较</button>}<h4>问题与下一假设</h4>{issues.data?.pages.flatMap(page => page.items).map(item => <article key={item.id}><p>{item.text}</p><small>{item.kind} · {item.category}</small>{item.nextHypothesis && <p>下一假设：{item.nextHypothesis}</p>}<details><summary>准确证据</summary>{item.evidence.map((evidence, index) => <p key={index}>条目 {evidence.entryId} · Case {evidence.caseId} · Run {evidence.runId || '未记录'} · 节点 {evidence.nodeId || '未记录'}</p>)}</details></article>)}{!issues.isPending && !issues.data?.pages.some(page => page.items.length) && <p className="sw-muted">没有保存问题记录。</p>}{issues.error && <p className="sw-plan-error">{readableError(issues.error)} <button onClick={() => void issues.refetch()}>重试</button></p>}{issues.hasNextPage && <button onClick={() => void issues.fetchNextPage()}>加载更多问题</button>}</>}</div>}
  </section>;
}
