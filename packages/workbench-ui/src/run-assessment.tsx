import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { ExternalAgentObservationDto, ExternalAgentObservationReceiptDto, ExternalAgentAssetObservationDto, ExternalAgentAssetObservationReceiptDto, PublishedAssetTargetDto, ReviewSubjectsDto, RunReviewDto, RunReviewRequestDto, RunDispositionRequestDto, RunDispositionRevisionDto, SavedResponseTargetDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';

type Subject = ReviewSubjectsDto['subjects'][number];
type Answers = RunReviewRequestDto['answers'];
const emptyAnswers = (): Answers => ({ good: '', bad: '', improvement: '', unresolved: '' });
const answerLabels: Record<keyof Answers, string> = { good: '有效之处', bad: '不足之处', improvement: '如何改进', unresolved: '尚未解决' };
const actionLabels: Record<RunDispositionRequestDto['action'], string> = { keep: '保留', revise: '修改', supplement: '补充', 'change-method': '调整方法', stop: '停止', defer: '暂缓' };
const subjectKey = (subject: Subject) => subject.kind === 'asset' ? `asset:${subject.asset.id}` : `response:${subject.target.eventId}`;
const targetKey = (target: SavedResponseTargetDto) => `response:${target.eventId}`;
const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);
type ExternalAgent = { id: string; sessionId: string };
type AnyReceipt = ExternalAgentObservationReceiptDto | ExternalAgentAssetObservationReceiptDto;

export function usableAgentObservation(receipt: ExternalAgentObservationReceiptDto | null | undefined, target: SavedResponseTargetDto | undefined, agent: ExternalAgent | undefined, servicePrincipalId: string): boolean {
  if (!receipt || !target || !agent || receipt.delivery !== 'saved-response-read') return false;
  if (receipt.observer.id !== agent.id || receipt.observer.sessionId !== agent.sessionId || receipt.observer.servicePrincipalId !== servicePrincipalId) return false;
  if (agent.sessionId === target.sessionId || agent.sessionId === receipt.producerNativeSessionId) return false;
  return (Object.keys(target) as (keyof SavedResponseTargetDto)[]).every(key => receipt.target[key] === target[key]);
}
export function usableAgentAssetObservation(receipt: ExternalAgentAssetObservationReceiptDto | null | undefined, target: PublishedAssetTargetDto | undefined, agent: ExternalAgent | undefined, servicePrincipalId: string): boolean {
  if (!receipt || !target || !agent || receipt.delivery !== 'published-asset-read') return false;
  if (receipt.observer.id !== agent.id || receipt.observer.sessionId !== agent.sessionId || receipt.observer.servicePrincipalId !== servicePrincipalId) return false;
  if (receipt.source.runId !== target.runId || receipt.source.kind === 'node' && agent.sessionId === receipt.source.sessionId || receipt.producerNativeSessionIds.includes(agent.sessionId)) return false;
  return receipt.target.runId === target.runId && receipt.target.assetVersionId === target.assetVersionId && receipt.target.payloadHash === target.payloadHash;
}
export function standardForSubject(subject: Subject | undefined, responseStandard: ReviewSubjectsDto['standard']) {
  return subject?.kind === 'asset' ? subject.standard ?? null : subject?.standard ?? responseStandard;
}
export function agentDispositionReviewsMatch(reviews: RunReviewDto[], ids: string[], receiptId: string, agent: ExternalAgent, runId: string): boolean {
  const own = reviews.filter(review => review.runId === runId && review.judge.kind === 'agent' && review.judge.id === agent.id && review.judge.sessionId === agent.sessionId && !!review.observationReceiptId);
  return ids.length > 0 && ids.every(id => own.some(review => review.id === id)) && ids.some(id => own.some(review => review.id === id && review.observationReceiptId === receiptId));
}
export function reviewJudgeLabel(review: RunReviewDto): string { return review.judge.kind === 'agent' ? `受信 Agent ${review.judge.id} · 会话 ${review.judge.sessionId || '未记录'}${review.observationReceiptId ? ` · 观察收据 ${review.observationReceiptId}` : ''}` : `人工 ${review.judge.id}`; }
export function dispositionAuthorLabel(item: RunDispositionRevisionDto): string { return item.author.kind === 'agent' ? `受信 Agent ${item.author.id} · 会话 ${item.author.sessionId} · 服务主体 ${item.author.servicePrincipalId}` : `人工作者 ${item.author.id}`; }

function SubjectReading({ api, scope, runId, subject, onAsset }: { api: SpaceApi; scope: string; runId: string; subject: Subject; onAsset: (id: string) => void }) {
  const responses = useQuery({ queryKey: ['space', scope, api.root, 'unpublished-responses', runId, subject.kind === 'response' ? subject.target.occurrenceId : ''], queryFn: ({ signal }) => api.unpublishedResponses(runId, subject.kind === 'response' ? subject.target.occurrenceId : '', signal), enabled: subject.kind === 'response', retry: false });
  if (subject.kind === 'asset') return <div className="sw-assessment-subject"><strong>{subject.asset.sourceKind === 'historical-artifact' ? '历史已发布资产' : '已发布资产'} · {subject.asset.title}</strong><p>准确资产 {subject.asset.id} · {subject.asset.schema.namespace} / {subject.asset.schema.revision}</p><button type="button" onClick={() => onAsset(subject.asset.id)}>阅读准确资产正文</button></div>;
  const item = responses.data?.responses.find(response => response.eventId === subject.target.eventId && response.stepRunId === subject.target.stepRunId);
  return <div className="sw-assessment-subject"><strong>未发布响应 · {subject.occurrenceLabel}</strong><p>这是保存的执行响应，未形成已发布资产；评价它不会改变运行结果。</p>{responses.isPending && <p>正在读取保存的响应…</p>}{responses.error && <p role="alert">响应读取失败：{responses.error instanceof Error ? responses.error.message : '未知错误'} <button type="button" onClick={() => void responses.refetch()}>重试</button></p>}{responses.data && !item && <p role="alert">准确事件未能匹配保存的响应。请核对事件身份后再评价。</p>}{item && <><h4>{item.reading.title}</h4>{item.reading.sections.map((section, index) => <section className="sw-reading-section" key={`${section.title}-${index}`}><h5>{section.title}</h5><p>{section.text}</p>{section.pointer && <small>{section.pointer}</small>}</section>)}{(item.reading.readerStatus === 'fallback' || item.coverage === 'truncated') && <p>{item.reading.reason || '正文阅读不完整，请核对原始响应。'}</p>}<details><summary>原始保存响应</summary><pre>{item.output}</pre></details></>}<details><summary>准确事件与原始哈希</summary><code>运行 {subject.target.runId} · 轮次 {subject.target.occurrenceId} · 步骤 {subject.target.stepRunId} · 尝试 {subject.target.attemptId} · 会话 {subject.target.sessionId} · 事件 {subject.target.eventId} / {subject.target.eventSeq} · 原始输出 hash {subject.target.outputHash}</code></details></div>;
}

function ObservationDelivery({ observation }: { observation: ExternalAgentObservationDto | ExternalAgentAssetObservationDto }) {
  const delivered = 'asset' in observation ? observation.asset : observation.response;
  return <details><summary>本次交付给 Agent 的准确正文</summary><h5>{delivered.reading.title}</h5>{delivered.reading.sections.map((section, index) => <section className="sw-reading-section" key={`${section.title}-${index}`}><h5>{section.title}</h5><p>{section.text}</p></section>)}<pre>{'payload' in delivered ? delivered.payload : delivered.output}</pre></details>;
}

function ObservationReceiptCard({ receipt, usable }: { receipt: AnyReceipt; usable: boolean }) {
  return <div className={usable ? 'sw-assessment-receipt valid' : 'sw-assessment-receipt invalid'}><strong>{usable ? '准确观察收据已核对' : '观察收据与当前对象或身份不匹配'}</strong><p>收据 {receipt.id} · Agent {receipt.observer.id} / {receipt.observer.sessionId}</p><small>{receipt.delivery === 'published-asset-read' ? `已发布资产 ${receipt.target.assetVersionId} · 内容 hash ${receipt.target.payloadHash}` : `未发布事件 ${receipt.target.eventId} · 原始输出 hash ${receipt.target.outputHash}`} · {receipt.delivery}。只证明准确正文交付，不证明已理解。</small></div>;
}

export function RunAssessment({ api, scope, runId, principal, externalAgent, observationWritable, csrfToken, reviewWritable, dispositionWritable, onAsset, onDiagnose }: { api: SpaceApi; scope: string; runId: string; principal: string; externalAgent?: ExternalAgent; observationWritable: boolean; csrfToken?: string | null; reviewWritable: boolean; dispositionWritable: boolean; onAsset: (id: string) => void; onDiagnose?: (reviewId?: string, dispositionId?: string) => void }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const linked = params.get('assessmentRun') === runId;
  const exactReviewId = linked ? params.get('assessmentReview') : null;
  const exactDispositionId = linked ? params.get('assessmentDisposition') : null;
  const observationId = linked ? params.get('assessmentObservation') : null;
  const link = (name: 'assessmentSubject' | 'assessmentReview' | 'assessmentDisposition' | 'assessmentObservation', value: string) => { const next = new URLSearchParams(params); next.set('assessmentRun', runId); next.set(name, value); setParams(next, { replace: true }); };
  const prefix = ['space', scope, api.root, 'run-assessment', runId];
  const subjects = useQuery({ queryKey: [...prefix, 'subjects'], queryFn: ({ signal }) => api.reviewSubjects(runId, signal), retry: false });
  const reviews = useInfiniteQuery({ queryKey: [...prefix, 'reviews'], queryFn: ({ pageParam, signal }) => api.runReviews(runId, pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined, retry: false });
  const dispositions = useInfiniteQuery({ queryKey: [...prefix, 'dispositions'], queryFn: ({ pageParam, signal }) => api.runDispositions(runId, pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined, retry: false });
  const exactReview = useQuery({ queryKey: [...prefix, 'review', exactReviewId], queryFn: ({ signal }) => api.runReview(runId, exactReviewId!, signal), enabled: !!exactReviewId, retry: false });
  const exactDisposition = useQuery({ queryKey: [...prefix, 'disposition', exactDispositionId], queryFn: ({ signal }) => api.runDisposition(runId, exactDispositionId!, signal), enabled: !!exactDispositionId, retry: false });
  const savedObservation = useQuery({ queryKey: [...prefix, 'observation', observationId], queryFn: ({ signal }) => api.reviewObservation(runId, observationId!, signal), enabled: !!externalAgent && !!observationId, retry: false });
  const allReviews = reviews.data?.pages.flatMap(page => page.items) || [];
  const allDispositions = dispositions.data?.pages.flatMap(page => page.items) || [];
  const latest = allDispositions.reduce<RunDispositionRevisionDto | null>((head, item) => !head || item.revision > head.revision ? item : head, null);
  const [selectedKey, setSelectedKey] = useState(linked ? params.get('assessmentSubject') || '' : '');
  useEffect(() => { const requested = linked ? params.get('assessmentSubject') : null; if (requested && requested !== selectedKey) setSelectedKey(requested); }, [linked, params, selectedKey]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [answers, setAnswers] = useState<Answers>(emptyAnswers);
  const [pointerText, setPointerText] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [observation, setObservation] = useState<ExternalAgentObservationDto | ExternalAgentAssetObservationDto | null>(null);
  const [observationBusy, setObservationBusy] = useState(false);
  const [observationError, setObservationError] = useState('');
  const reviewId = useRef(crypto.randomUUID());
  const [dispositionOpen, setDispositionOpen] = useState(false);
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const [action, setAction] = useState<RunDispositionRequestDto['action']>('defer');
  const [reason, setReason] = useState('');
  const [unknowns, setUnknowns] = useState('');
  const [evidenceKeys, setEvidenceKeys] = useState<string[]>([]);
  const [baseId, setBaseId] = useState<string | null>(null);
  const dispositionKey = useRef(crypto.randomUUID());
  const [dispositionBusy, setDispositionBusy] = useState(false);
  const [dispositionError, setDispositionError] = useState('');
  useEffect(() => { if (!selectedKey && subjects.data?.subjects.length) setSelectedKey(subjectKey(subjects.data.subjects[0])); }, [subjects.data?.subjects, selectedKey]);
  const selected = subjects.data?.subjects.find(subject => subjectKey(subject) === selectedKey);
  const standard = standardForSubject(selected, subjects.data?.standard ?? null);
  const responseTarget = selected?.kind === 'response' ? selected.target : undefined;
  const assetTarget = selected?.kind === 'asset' ? selected.target : undefined;
  const receipt = observation?.receipt.id === observationId ? observation.receipt : savedObservation.data;
  const receiptUsable = receipt?.delivery === 'saved-response-read' ? usableAgentObservation(receipt, responseTarget, externalAgent, principal) : receipt?.delivery === 'published-asset-read' ? usableAgentAssetObservation(receipt, assetTarget, externalAgent, principal) : false;
  const agentReviews = externalAgent ? allReviews.filter(review => review.judge.kind === 'agent' && review.judge.id === externalAgent.id && review.judge.sessionId === externalAgent.sessionId && !!review.observationReceiptId) : [];
  const selectableReviews = externalAgent ? agentReviews : allReviews;
  const observe = async () => {
    if (!selected || !externalAgent || !observationWritable || !csrfToken || observationBusy) return;
    setObservationBusy(true); setObservationError('');
    try { const saved = selected.kind === 'asset' ? await api.observePublishedAsset(runId, selected.target, csrfToken) : await api.observeSavedResponse(runId, selected.target, csrfToken); setObservation(saved); link('assessmentObservation', saved.receipt.id); }
    catch (error) { setObservationError(error instanceof Error ? error.message : '观察准确对象失败。'); }
    finally { setObservationBusy(false); }
  };
  const modifyReview = () => { reviewId.current = crypto.randomUUID(); setReviewError(''); };
  const modifyDisposition = () => { dispositionKey.current = crypto.randomUUID(); setDispositionError(''); };
  const openDisposition = () => { setBaseId(latest?.id || null); setDispositionOpen(true); setDispositionError(''); };
  const saveReview = async () => {
    if (!selected || !csrfToken || reviewBusy) return;
    if (externalAgent && !receiptUsable) { setReviewError('Agent 评价必须先以当前受信会话读取准确对象并取得匹配的观察收据。'); return; }
    if (!standard) { setReviewError('本次冻结评价标准缺失，不能保存独立评价。'); return; }
    if (Object.values(answers).some(value => !value.trim())) { setReviewError('请填写完整四问；不知道的内容请明确写“未知”或“未评估”。'); return; }
    const pointers = lines(pointerText);
    if (selected.kind === 'response' && pointers.some(pointer => !pointer.startsWith('/'))) { setReviewError('响应依据须使用原始输出的 JSON Pointer，例如 /script/segments/0/voiceover。'); return; }
    const input: RunReviewRequestDto = { id: reviewId.current, runId, assetVersionIds: selected.kind === 'asset' ? [selected.asset.id] : [], ...(selected.kind === 'response' ? { responseTarget: selected.target, evidencePointers: pointers } : {}), ...(externalAgent ? { observationReceiptId: receipt!.id } : {}), standard, judge: externalAgent ? { kind: 'agent', id: externalAgent.id, sessionId: externalAgent.sessionId } : { kind: 'human', id: principal }, evidence: selected.kind === 'asset' ? [selected.asset.id] : [], answers: { good: answers.good.trim(), bad: answers.bad.trim(), improvement: answers.improvement.trim(), unresolved: answers.unresolved.trim() } };
    setReviewBusy(true); setReviewError('');
    try { const saved = await api.saveRunReview(runId, input, csrfToken); await client.invalidateQueries({ queryKey: [...prefix, 'reviews'] }); link('assessmentReview', saved.id); setReviewOpen(false); setAnswers(emptyAnswers()); setPointerText(''); reviewId.current = crypto.randomUUID(); }
    catch (error) { setReviewError(error instanceof Error ? error.message : '保存失败；表单已保留。'); }
    finally { setReviewBusy(false); }
  };
  const saveDisposition = async () => {
    if (!csrfToken || dispositionBusy) return;
    if (!reviewIds.length || !reason.trim()) { setDispositionError('请选择至少一条本次评价并填写处理理由。'); return; }
    if (externalAgent && (!receiptUsable || !agentDispositionReviewsMatch(agentReviews, reviewIds, receipt!.id, externalAgent, runId))) { setDispositionError('Agent 处置须包含至少一条与当前收据匹配的本人评价；同次运行的其他本人评价可一并关联。'); return; }
    const evidenceRefs: RunDispositionRequestDto['evidenceRefs'] = (subjects.data?.subjects || []).filter(subject => evidenceKeys.includes(subjectKey(subject))).map(subject => subject.kind === 'asset' ? { kind: 'asset' as const, assetVersionId: subject.asset.id } : { kind: 'response' as const, target: subject.target });
    for (const failure of subjects.data?.failures || []) if (evidenceKeys.includes(`step:${failure.stepRunId}`)) evidenceRefs.push({ kind: 'run', runId, stepRunId: failure.stepRunId });
    const input: RunDispositionRequestDto = { runId, reviewIds, action, reason: reason.trim(), unknowns: lines(unknowns), evidenceRefs, ...(externalAgent ? { observationReceiptId: receipt!.id } : {}), expectedRevisionId: baseId, idempotencyKey: dispositionKey.current };
    setDispositionBusy(true); setDispositionError('');
    try { const saved = await api.saveRunDisposition(runId, input, csrfToken); await client.invalidateQueries({ queryKey: [...prefix, 'dispositions'] }); link('assessmentDisposition', saved.id); setDispositionOpen(false); setReason(''); setUnknowns(''); setReviewIds([]); setEvidenceKeys([]); dispositionKey.current = crypto.randomUUID(); }
    catch (error) { setDispositionError(error instanceof Error ? error.message : '保存失败；表单已保留。'); }
    finally { setDispositionBusy(false); }
  };
  return <section className="sw-run-assessment"><header><h3>本次结果的评价与处置</h3><p>独立记录对准确对象的判断与下一步意向。保存不会执行、采用、登记新方法或接受稿件。</p>{params.get('diagnosisRun') === runId && <button type="button" onClick={() => document.getElementById('run-diagnosis')?.scrollIntoView({ block: 'start' })}>返回本次诊断</button>}</header>
    {subjects.error && <p role="alert">评价对象读取失败：{subjects.error instanceof Error ? subjects.error.message : '未知错误'} <button onClick={() => void subjects.refetch()}>重试</button></p>}
    {subjects.isPending && <p className="sw-muted">正在确认本次可评价的准确对象…</p>}
    {subjects.data && <><h4>准确评价对象</h4>{subjects.data.subjects.length ? <><label>选择对象 <select value={selectedKey} onChange={event => { setSelectedKey(event.target.value); link('assessmentSubject', event.target.value); setReviewOpen(false); setDispositionOpen(false); setReviewIds([]); modifyReview(); modifyDisposition(); }} >{subjects.data.subjects.map(subject => <option key={subjectKey(subject)} value={subjectKey(subject)}>{subject.kind === 'asset' ? `已发布资产 · ${subject.asset.title}` : `未发布响应 · ${subject.occurrenceLabel}`}</option>)}</select></label>{selected ? <SubjectReading key={selectedKey} api={api} scope={scope} runId={runId} subject={selected} onAsset={onAsset} /> : <p role="alert">指定对象不在当前准确对象清单中，请重新选择。</p>}</> : <p className="sw-muted">本次没有可核实的已发布资产或保存的未发布响应；暂不能创建对象评价。</p>}{subjects.data.failures.length > 0 && <details><summary>保存的失败步骤 · {subjects.data.failures.length}</summary>{subjects.data.failures.map(failure => <p key={failure.stepRunId}>{failure.key} · {failure.error}</p>)}</details>}</>}
    {externalAgent && <section className="sw-assessment-observation">
      <h4>受信 Agent 阅读凭据</h4>
      <p>当前 Agent {externalAgent.id} · 独立会话 {externalAgent.sessionId}。凭据只证明准确原文交付，不代表完整思考轨迹或已理解。</p>
      {selected ? <>{observationWritable ? <button type="button" disabled={observationBusy || !csrfToken} onClick={() => void observe()}>{observationBusy ? '正在交付准确正文…' : selected.kind === 'asset' ? '读取准确资产正文并登记观察' : '读取准确未发布响应并登记观察'}</button> : <p className="sw-muted">当前宿主没有开放受信 Agent 观察登记。</p>}
        {observationError && <p role="alert">{observationError}</p>}
        {observationId && savedObservation.isPending && <p>正在核对已有观察收据…</p>}
        {savedObservation.error && <p role="alert">观察收据读取失败：{savedObservation.error instanceof Error ? savedObservation.error.message : '未知错误'}</p>}
        {receipt && <ObservationReceiptCard receipt={receipt} usable={receiptUsable} />}
        {observation && observation.receipt.id === receipt?.id && <ObservationDelivery observation={observation} />}
      </> : <p className="sw-muted">先选择准确评价对象。</p>}
    </section>}
    <h4>独立四问评价</h4><p className="sw-muted">以下为本次运行的独立评价，不等于流程内意见或外部 Agent 处理建议。</p>{reviews.error && <p role="alert">评价历史读取失败：{reviews.error instanceof Error ? reviews.error.message : '未知错误'} <button onClick={() => void reviews.refetch()}>重试</button></p>}{reviews.isPending && <p className="sw-muted">正在读取评价历史…</p>}{allReviews.map(review => <article key={review.id} className="sw-assessment-record"><button type="button" onClick={() => link('assessmentReview', review.id)}>打开准确评价</button>{onDiagnose && <button type="button" onClick={() => onDiagnose(review.id)}>由此评价进入原因诊断</button>}<ReviewRecord review={review} subjects={subjects.data?.subjects || []} onAsset={onAsset} onResponse={target => { setSelectedKey(targetKey(target)); link('assessmentSubject', targetKey(target)); }} /></article>)}{reviews.data && !allReviews.length && <p className="sw-muted">尚无独立评价，质量和可用性未评估。</p>}{reviews.hasNextPage && <button onClick={() => void reviews.fetchNextPage()} disabled={reviews.isFetchingNextPage}>{reviews.isFetchingNextPage ? '正在读取…' : '更多评价'}</button>}{exactReviewId && <div className="sw-assessment-exact"><h5>指定评价 · {exactReviewId}</h5>{exactReview.data ? <ReviewRecord review={exactReview.data} subjects={subjects.data?.subjects || []} onAsset={onAsset} onResponse={target => { setSelectedKey(targetKey(target)); link('assessmentSubject', targetKey(target)); }} /> : <p role={exactReview.error ? 'alert' : undefined}>{exactReview.error instanceof Error ? exactReview.error.message : '正在读取准确评价…'}</p>}</div>}
    {externalAgent && selected && !receiptUsable && <p className="sw-muted">Agent 四问登记尚不可用：请先取得与当前对象和受信会话匹配的观察收据。</p>}
    {reviewWritable && selected && (!externalAgent || receiptUsable) && <><button type="button" onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? '收起评价表单' : '记录对此对象的评价'}</button>{reviewOpen && <form onSubmit={event => { event.preventDefault(); void saveReview(); }}><p>{externalAgent ? `评价主体：受信 Agent ${externalAgent.id} · 独立会话 ${externalAgent.sessionId} · 观察收据 ${receipt?.id}` : `评价主体：人工 · 当前登录主体 ${principal}。此表单不代填 Agent 身份。`}</p><fieldset><legend>本次冻结评价标准 · 不可在此修改</legend>{standard ? <><p>ID {standard.id} · 修订 {standard.revision}</p><p className="sw-assessment-standard">{standard.content}</p></> : <p role="alert">本次冻结标准未记录，暂不能保存评价。</p>}</fieldset>{(Object.keys(answerLabels) as (keyof Answers)[]).map(field => <label key={field}>{answerLabels[field]}<textarea required rows={3} value={answers[field]} onChange={event => { setAnswers({ ...answers, [field]: event.target.value }); modifyReview(); }} /></label>)}{selected.kind === 'response' && <label>依据指针（可选，每行一个原始输出 JSON Pointer）<textarea rows={2} value={pointerText} onChange={event => { setPointerText(event.target.value); modifyReview(); }} placeholder="/script/segments/0/voiceover" /></label>}<button disabled={reviewBusy || !csrfToken || !standard}>{reviewBusy ? '正在保存…' : '保存独立评价'}</button>{reviewError && <p role="alert">{reviewError}</p>}</form>}</>}
    <h4>本次处理意向</h4><p className="sw-muted">仅记录当前认证主体的选择及所依据的评价；不会触发修改、补充、停止或其他执行。</p>{dispositions.error && <p role="alert">处理历史读取失败：{dispositions.error instanceof Error ? dispositions.error.message : '未知错误'} <button onClick={() => void dispositions.refetch()}>重试</button></p>}{allDispositions.map(item => <article className="sw-assessment-record" key={item.id}><button type="button" onClick={() => link('assessmentDisposition', item.id)}>打开准确处置</button>{onDiagnose && <button type="button" onClick={() => onDiagnose(undefined, item.id)}>由此处置进入原因诊断</button>}<DispositionRecord item={item} onReview={id => link('assessmentReview', id)} onAsset={onAsset} onResponse={target => { setSelectedKey(targetKey(target)); link('assessmentSubject', targetKey(target)); }} /></article>)}{dispositions.data && !allDispositions.length && <p className="sw-muted">尚未记录本次处理意向。</p>}{dispositions.hasNextPage && <button onClick={() => void dispositions.fetchNextPage()} disabled={dispositions.isFetchingNextPage}>{dispositions.isFetchingNextPage ? '正在读取…' : '更多处理修订'}</button>}{exactDispositionId && <div className="sw-assessment-exact"><h5>指定处理修订 · {exactDispositionId}</h5>{exactDisposition.data ? <DispositionRecord item={exactDisposition.data} onReview={id => link('assessmentReview', id)} onAsset={onAsset} onResponse={target => { setSelectedKey(targetKey(target)); link('assessmentSubject', targetKey(target)); }} /> : <p role={exactDisposition.error ? 'alert' : undefined}>{exactDisposition.error instanceof Error ? exactDisposition.error.message : '正在读取准确处理修订…'}</p>}</div>}
    {dispositionWritable && reviews.data && (!externalAgent || receiptUsable) && <><button type="button" onClick={() => dispositionOpen ? setDispositionOpen(false) : openDisposition()}>{dispositionOpen ? '收起处理表单' : '记录处理意向'}</button>{dispositionOpen && <form onSubmit={event => { event.preventDefault(); void saveDisposition(); }}><p>{externalAgent ? `受信 Agent ${externalAgent.id} · 独立会话 ${externalAgent.sessionId} · 观察收据 ${receipt?.id}。` : ''}基于当前处理修订：{baseId || '尚无修订'}。保存新修订不改变已有记录。</p><fieldset><legend>依据本次评价</legend>{selectableReviews.length ? selectableReviews.map(review => <label key={review.id}><input type="checkbox" checked={reviewIds.includes(review.id)} onChange={event => { setReviewIds(current => event.target.checked ? [...current, review.id] : current.filter(id => id !== review.id)); modifyDisposition(); }} />评价 {review.id} · {review.judge.kind === 'human' ? '人工' : 'Agent'}</label>) : <p>{externalAgent ? '此观察收据尚无当前 Agent 自己保存的评价；请先完成四问。' : '当前未读到评价；请先保存一条独立评价。'}</p>}</fieldset><label>处理选择<select value={action} onChange={event => { setAction(event.target.value as RunDispositionRequestDto['action']); modifyDisposition(); }}>{Object.entries(actionLabels).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><label>理由<textarea required rows={3} value={reason} onChange={event => { setReason(event.target.value); modifyDisposition(); }} /></label><label>仍未知的事（每行一项；没有则留空）<textarea rows={2} value={unknowns} onChange={event => { setUnknowns(event.target.value); modifyDisposition(); }} /></label><fieldset><legend>准确依据（可选）</legend>{subjects.data?.subjects.map(subject => <label key={subjectKey(subject)}><input type="checkbox" checked={evidenceKeys.includes(subjectKey(subject))} onChange={event => { setEvidenceKeys(current => event.target.checked ? [...current, subjectKey(subject)] : current.filter(key => key !== subjectKey(subject))); modifyDisposition(); }} />{subject.kind === 'asset' ? `资产 ${subject.asset.title}` : `未发布响应 ${subject.occurrenceLabel}`}</label>)}{subjects.data?.failures.map(failure => <label key={failure.stepRunId}><input type="checkbox" checked={evidenceKeys.includes(`step:${failure.stepRunId}`)} onChange={event => { setEvidenceKeys(current => event.target.checked ? [...current, `step:${failure.stepRunId}`] : current.filter(key => key !== `step:${failure.stepRunId}`)); modifyDisposition(); }} />失败步骤 {failure.key}</label>)}</fieldset><button disabled={dispositionBusy || !csrfToken || !selectableReviews.length}>{dispositionBusy ? '正在保存…' : '保存处理意向'}</button>{dispositionError && <p role="alert">{dispositionError}{latest?.id !== baseId && <button type="button" onClick={() => { setBaseId(latest?.id || null); dispositionKey.current = crypto.randomUUID(); setDispositionError(''); }}>改以当前修订为基础重试</button>}</p>}</form>}</>}
  </section>;
}

function ReviewRecord({ review, subjects, onAsset, onResponse }: { review: RunReviewDto; subjects: Subject[]; onAsset: (id: string) => void; onResponse: (target: SavedResponseTargetDto) => void }) {
  const asset = subjects.find(subject => subject.kind === 'asset' && review.assetVersionIds.includes(subject.asset.id));
  return <><strong>{review.assetVersionIds.length ? '已发布资产评价' : '未发布响应评价'} · {reviewJudgeLabel(review)}</strong><p>标准 {review.standard.id} / {review.standard.revision} · {review.createdAt}</p>{review.assetVersionIds.map(id => <button key={id} onClick={() => onAsset(id)}>返回被评资产 {asset?.kind === 'asset' && asset.asset.id === id ? asset.asset.title : id}</button>)}{review.responseTarget && <button onClick={() => onResponse(review.responseTarget!)}>返回被评未发布响应 · 事件 {review.responseTarget.eventId}</button>}<details><summary>四问与准确依据</summary><p>好：{review.answers.good}</p><p>不足：{review.answers.bad}</p><p>改进：{review.answers.improvement}</p><p>未解决：{review.answers.unresolved}</p><p>标准正文：{review.standard.content}</p><p>资产依据：{review.evidence.join('、') || '未记录'} · 响应指针：{review.evidencePointers?.join('、') || '未记录'}</p><code>评价 {review.id}{review.responseTarget ? ` · 原始输出 hash ${review.responseTarget.outputHash}` : ''}</code></details></>;
}

function DispositionRecord({ item, onReview, onAsset, onResponse }: { item: RunDispositionRevisionDto; onReview: (id: string) => void; onAsset: (id: string) => void; onResponse: (target: SavedResponseTargetDto) => void }) {
  return <><strong>修订 {item.revision} · {actionLabels[item.action]}</strong><p>{item.reason}</p><p>未解问题：{item.unknowns.join('；') || '未记录'}</p><small>未确认 · {dispositionAuthorLabel(item)} · 实际记录主体 {item.recordedBy}</small><div>{item.reviewIds.map(id => <button key={id} onClick={() => onReview(id)}>查看所据评价 {id}</button>)}</div><details><summary>准确身份与依据</summary><code>{item.id} · {item.payloadHash}{item.observationReceiptId ? ` · 主观察收据 ${item.observationReceiptId}` : ''}</code>{item.observationReceiptIds.length > 0 && <p>所据评价的全部观察收据：{item.observationReceiptIds.join('、')}</p>}<div>{item.evidenceRefs.map((ref, index) => ref.kind === 'asset' ? <button key={index} onClick={() => onAsset(ref.assetVersionId)}>资产 {ref.assetVersionId}{ref.pointer ? ` ${ref.pointer}` : ''}</button> : ref.kind === 'response' ? <button key={index} onClick={() => onResponse(ref.target)}>未发布响应 · 事件 {ref.target.eventId}{ref.pointer ? ` ${ref.pointer}` : ''}</button> : <p key={index}>运行 {ref.runId}{ref.stepRunId ? ` · 步骤 ${ref.stepRunId}` : ''}</p>)}</div></details></>;
}
