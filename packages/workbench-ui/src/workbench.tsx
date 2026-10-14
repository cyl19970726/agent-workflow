import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssetSummaryDto, CaseSummaryDto, ComparisonReadingDto, CursorList, NodeDetailDto, NodeSummaryDto, OccurrenceDetailDto, OccurrenceDto, ReviewDto,
  ProcessDto, RunDetailDto, RunSummaryDto, SpaceSummaryDto, VersionDetailDto, VersionSummaryDto, WorkflowGraphStateDto,
} from '@signal-room/workflow-space-api/contracts';
import { SpaceApi, SpaceApiError } from './api.js';
import { focusGraphNode, isGraphReady, postGraphState, selectedGraphNode, type GraphIdentity } from './bridge.js';
import { sectionsForView, type ReaderSection, type ReaderView } from './reader-sections.js';
import { safeInlineLinks } from './safe-inline-links.js';
import { PlanAction } from './plan-action.js';
import { BusinessAction } from './business-action.js';
import { HandlingNotes } from './handling-notes.js';
import { RunAssessment } from './run-assessment.js';
import { RunDiagnosis, diagnosisDraftStorageKey } from './run-diagnosis.js';
import { Understanding } from './understanding.js';
import { MethodDesign, MethodDesignBasis } from './method-design.js';
import { MethodCandidate } from './method-candidate.js';
import { CaseFrozenInputs } from './case-frozen-inputs.js';
import { agentAttemptContexts, NodeRuntime } from './node-runtime.js';
import { NativeRunEvents } from './native-run-events.js';
import { AssetAttachments } from './asset-attachments.js';
import { toolFieldSummaries } from './tool-schema.js';
import { exactComparisonSubjects } from './comparison-reading.js';
import { isActiveRun, latestOccurrence, needsFinalProcessRefresh } from './process-state.js';
import { mergeCurrentRun, runScopeExplanation, runScopeLabel, runStatusSummary, stateLabel } from './run-presentation.js';
import { reviewBaselineLabel, reviewJudgeLabel, reviewStandardLabel } from './review-presentation.js';
import { discardScopedSpaceData, identityChanged, isAuthDenial, mayDisplaySummary } from './identity-cache.js';
import { closeInspector, readSelection, selectNode, selectRun, selectVersion, validSourceOriginIndex, writeSelection, type Selection } from './selection.js';
import { nodeInspectorReadingKey, readReadingPosition, readingPositionKey } from './reading-position.js';
import { useReadingPosition } from './use-reading-position.js';
import { diagnosisAssetParams, diagnosisReturnParams } from './diagnosis-navigation.js';

export interface SpaceWorkbenchProps { spaceId: string; apiBase?: string; basePath?: string }
export function shouldOpenBlankGoal(params: URLSearchParams, summary: Pick<SpaceSummaryDto, 'businessState' | 'latestVersionId' | 'adoptedVersionId'> | undefined): boolean {
  return params.toString() === '' && !!summary?.businessState && summary.businessState.workflowVersions === 0 && !summary.latestVersionId && !summary.adoptedVersionId;
}
const label = (value: string | null | undefined, fallback = '未记录') => value?.trim() || fallback;
const methodGroups = [['primary','主流程方法'],['auxiliary','辅助流程方法'],['historical-observation','历史运行观察（逐次记录）']] as const;
function VersionOptions({versions}:{versions:VersionSummaryDto[]}) {
  return <>{methodGroups.map(([kind,title])=>{const items=versions.filter(v=>(v.methodKind??'primary')===kind);return items.length?<optgroup key={kind} label={title}>{items.map(v=><option key={v.id} value={v.id}>{v.revision} · {v.label}</option>)}</optgroup>:null;})}</>;
}
function availabilityLabel(version: VersionSummaryDto | undefined): string {
  if (!version) return '执行状态读取中';
  const reason = version.availability.reason ? `：${version.availability.reason}` : '';
  if (version.availability.state === 'available') return `可执行${reason}`;
  if (version.availability.state === 'unavailable') return `当前不可执行${reason}`;
  return `可执行性未知${reason || '：宿主未记录部署状态'}`;
}

type ExpectedAssetView = VersionDetailDto['expectedAssets']['assets'][number];
type MethodVersion = VersionDetailDto;
export const versionPurposeFor = (version: Pick<VersionDetailDto, 'id' | 'purpose'> | undefined, versionId: string | undefined): string | null | undefined => version && version.id === versionId ? version.purpose : undefined;
export function defaultMethodVersionId(selection: Pick<Selection, 'version'>, summary: Pick<SpaceSummaryDto, 'adoptedVersionId' | 'defaultVersionId' | 'latestVersionId'> | undefined, listed?: string): string | undefined {
  return selection.version || summary?.adoptedVersionId || summary?.defaultVersionId || summary?.latestVersionId || listed;
}
export function mainMethodVersionId(summary: Pick<SpaceSummaryDto, 'adoptedVersionId' | 'defaultVersionId'> | undefined, selected?: string): string | undefined {
  return summary?.adoptedVersionId || summary?.defaultVersionId || selected;
}

function adoptionLabel(version: MethodVersion | undefined, summary: SpaceSummaryDto): string {
  if (!version) return '采用状态读取中';
  if (version.adoptionStatus === 'unknown') return '采用状态未知';
  if (version.adoptionSlots.length) return `已采用 · ${version.adoptionSlots.join('、')}`;
  if (version.adoptionStatus === 'recorded') return '未采用';
  return version.id === summary.adoptedVersionId ? '当前范围已采用' : '采用状态未知';
}

function VersionMotive({ version, summary, onPredecessor }: { version: MethodVersion; summary: SpaceSummaryDto; onPredecessor: (id: string) => void }) {
  return <section className="sw-version-motive" aria-label="当前版本的设计目标与改动"><div><small>准确版本 · {version.revision}</small><h3>{version.label}</h3></div><dl><dt>设计用途</dt><dd>{label(version.purpose, '此版本未保存独立的设计用途')}</dd><dt>产生动机</dt><dd>{label(version.changeReason, '变更理由未记录')}</dd><dt>真实前驱</dt><dd>{version.predecessorId ? <button className="sw-link" onClick={() => onPredecessor(version.predecessorId!)}>查看前驱版本 {version.predecessorId}</button> : '未记录前驱；可能是首版'}</dd><dt>采用范围</dt><dd>{adoptionLabel(version, summary)}</dd><dt>执行条件</dt><dd>{availabilityLabel(version)}</dd><dt>实际使用</dt><dd>{version.runCount === 0 ? '0 次运行 · 未验证' : `${version.runCount} 次运行 · 验证结论需单独查看`}</dd><dt>方法定义</dt><dd>{version.definitionAvailability === 'recorded' ? '已保存' : '准确版本缺少方法定义'}</dd></dl><details><summary>准确身份</summary><code>{version.id}</code></details></section>;
}

export const knownNodeLabel = (nodes: readonly Pick<NodeSummaryDto, 'id' | 'label'>[], id: string): string => nodes.find(node => node.id === id)?.label || id;
export const caseForSelection = (caseId: string | undefined, direct: CaseSummaryDto | undefined, listed: readonly CaseSummaryDto[]): CaseSummaryDto | undefined => caseId ? (direct?.id === caseId ? direct : listed.find(item => item.id === caseId)) : undefined;
export function publishedDefinitionParams(current: URLSearchParams, selection: Selection, versionId: string): URLSearchParams {
  const next = writeSelection(current, { ...selectVersion(selection, versionId), view: 'workflow', tab: 'definition' });
  for (const key of ['candidateDesign', 'candidateVersion', 'candidateNode', 'candidateReader']) next.delete(key);
  return next;
}
export function graphEntityKind(tab: string, id: string, expectedAssetIds: readonly string[], graphAssetIds: readonly string[]): 'actual-asset' | 'expected-asset' | 'node' {
  if (tab === 'process' && graphAssetIds.includes(id)) return 'actual-asset';
  if (tab === 'definition' && expectedAssetIds.includes(id)) return 'expected-asset';
  return 'node';
}
function ExpectedAssetInspector({ asset, onNode, nodeLabel }: { asset?: ExpectedAssetView; onNode: (id: string) => void; nodeLabel: (id: string) => string }) {
  if (!asset) return <QueryNotice empty="这项预期资产不在当前准确版本的方法合同中。" />;
  return <div className="sw-detail"><p className="sw-status">方法声明的预期资产 · 尚非实际产物</p><dl><dt>角色</dt><dd>{asset.resultRoles.join('、') || '未标为结果资产'}</dd><dt>合同</dt><dd>{asset.schema ? `${asset.schema.namespace} · ${asset.schema.revision}` : 'Schema 未记录'}</dd><dt>来源</dt><dd>{asset.source.kind === 'run-input' ? `运行输入 ${asset.source.name}` : `节点 ${nodeLabel(asset.source.nodeId)} / ${asset.source.port}`}</dd></dl>{asset.producer && <button className="sw-link" onClick={() => onNode(asset.producer!.nodeId)}>查看生产节点 {nodeLabel(asset.producer.nodeId)}</button>}<h4>预期用途与下游</h4>{asset.consumers.length ? asset.consumers.map((consumer, index) => <button className="sw-row" key={`${consumer.nodeId}:${consumer.port}:${index}`} onClick={() => onNode(consumer.nodeId)}><span><strong>{nodeLabel(consumer.nodeId)} / {consumer.port}</strong><small>声明消费 · {consumer.selection}{consumer.when ? ` · ${consumer.when}` : ''}</small></span><span aria-hidden="true">›</span></button>) : <p className="sw-muted">未声明下游消费节点。</p>}{asset.missing.length > 0 && <section className="sw-expected-gaps"><h4>合同缺项</h4>{asset.missing.map((message, index) => <p key={index}>{message}</p>)}</section>}<details><summary>准确合同身份</summary><code>{asset.id}</code></details></div>;
}

function QueryNotice({ error, retry, empty }: { error?: unknown; retry?: () => void; empty?: string }) {
  if (error) {
    const code = error instanceof SpaceApiError ? error.code : 'ERROR';
    const status = error instanceof SpaceApiError ? error.status : 0;
    const title = status === 404 || code === 'HISTORY_UNAVAILABLE' ? '历史记录缺失' : status === 401 || status === 403 ? '没有读取权限' : '读取失败';
    return <div className="sw-notice" role="alert"><strong>{title}</strong><p>{error instanceof Error ? error.message : '请稍后重试。'}</p>{retry && <button onClick={retry}>重试</button>}</div>;
  }
  return <div className="sw-notice">{empty || '正在读取…'}</div>;
}

function LoadMore<T>({ source, render, empty }: { source: { data?: { pages: CursorList<T>[] }; isPending: boolean; error: unknown; hasNextPage: boolean; fetchNextPage: () => unknown; isFetchingNextPage: boolean; refetch: () => unknown }; render: (item: T) => ReactNode; empty: string }) {
  const items = source.data?.pages.flatMap(page => page.items) || [];
  return <>{items.map(render)}{!items.length && (source.isPending || source.error ? <QueryNotice error={source.error} retry={() => void source.refetch()} /> : <p className="sw-muted">{empty}</p>)}{source.hasNextPage && <button className="sw-more" onClick={() => void source.fetchNextPage()} disabled={source.isFetchingNextPage}>{source.isFetchingNextPage ? '正在读取…' : '加载更多'}</button>}</>;
}

function usePaged<T>(key: unknown[], fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorList<T>>, enabled = true) {
  return useInfiniteQuery({ queryKey: key, queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined, enabled });
}

function Tabs({ items, value, onChange }: { items: [string, string][]; value: string; onChange: (value: string) => void }) {
  return <div className="sw-tabs" role="tablist">{items.map(([id, title]) => <button key={id} role="tab" aria-selected={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{title}</button>)}</div>;
}

function Row({ title, sub, onClick, selected }: { title: string; sub?: string; onClick: () => void; selected?: boolean }) {
  return <button className={`sw-row${selected ? ' selected' : ''}`} onClick={onClick}><span><strong>{title}</strong>{sub && <small>{sub}</small>}</span><span aria-hidden="true">›</span></button>;
}

function RunInputs({ api, scope, run, onAsset }: { api: SpaceApi; scope: string; run: RunDetailDto; onAsset: (id: string) => void }) {
  const inputs = useQuery({ queryKey: ['space', scope, api.root, 'run-inputs', run.id], queryFn: ({ signal }) => api.runInputs(run.id, signal), retry: false });
  return <section className="sw-run-inputs"><h4>本次冻结输入 · {inputs.data?.slots.length ?? run.inputAssets.length} 项</h4>{inputs.data ? <>{inputs.data.slots.map(item => <button className="sw-row" key={item.slot} onClick={() => onAsset(item.asset.id)}><span><strong>{item.slot} · {item.asset.title}</strong><small>{assetOriginLabel(item.asset)}</small></span><span aria-hidden="true">›</span></button>)}{!inputs.data.slots.length && <p className="sw-muted">冻结清单没有保存输入槽位。</p>}<details><summary>准确冻结清单与内容校验值</summary><p>清单 {inputs.data.inputManifestId} · {inputs.data.inputManifestHash}</p>{inputs.data.slots.map(item => <p key={item.slot}>{item.slot} · {item.asset.id} · 内容 hash {item.payloadHash}</p>)}</details></> : <><QueryNotice error={inputs.error} retry={() => void inputs.refetch()} empty="正在读取冻结输入槽位…" /><AssetLinks assets={run.inputAssets} choose={onAsset} empty="此运行没有保存可读的输入资产。" /></>}</section>;
}

export function CaseContext({ api, scope, caseData, run, error, retry, onAsset }: { api: SpaceApi; scope: string; caseData?: CaseSummaryDto; run?: RunDetailDto; error: unknown; retry: () => void; onAsset: (id: string) => void }) {
  if (run) return <section className="sw-case-context has-run"><div className="sw-case-compact"><h3>{caseData?.title || run.caseTitle}</h3><p className="sw-runstate"><strong>{runScopeLabel(run)}</strong> · {run.label} · {runStatusSummary(run)}</p></div>{caseData && <p className="sw-case-objective-preview">{caseData.objective}</p>}<details><summary>阅读完整案例目标与运行追溯</summary>{caseData ? <><p>{caseData.objective}</p><small>约束：{caseData.constraints.length ? caseData.constraints.join(' · ') : '未记录'}</small></> : <QueryNotice error={error} retry={retry} empty="正在读取案例目标…" />}<dl className="sw-run-trace"><dt>Run</dt><dd>{run.id}</dd><dt>运行范围原值</dt><dd>{run.executionMode || '未记录'}</dd><dt>方法版本</dt><dd>{run.versionId}</dd><dt>输入清单</dt><dd>{run.inputManifestId}</dd><dt>清单 hash</dt><dd>{run.inputManifestHash}</dd><dt>原始状态</dt><dd>{run.state}</dd><dt>任务状态</dt><dd>{run.taskState || '未记录'}</dd><dt>原始原因</dt><dd>{run.reason || '未记录'}</dd></dl></details><RunInputs key={run.id} api={api} scope={scope} run={run} onAsset={onAsset} /><p className="sw-muted">本次输入以运行冻结清单为准；是否另有普通业务准备记录不改变这些已保存输入。</p></section>;
  return <section className="sw-case-context"><h3>{caseData?.title || '选择案例'}</h3>{caseData ? <><p className="sw-case-objective-preview">{caseData.objective}</p><details><summary>阅读完整目标与约束</summary><p>{caseData.objective}</p><small>约束：{caseData.constraints.length ? caseData.constraints.join(' · ') : '未记录'}</small></details><p className="sw-muted">{caseData.runCount === 0 ? '本案例尚未运行。冻结输入状态见下方；运行成果尚未产生。' : '请选择一次运行，阅读该次冻结输入与成果。'}</p></> : <QueryNotice error={error} retry={retry} empty="从案例列表选择真实业务。" />}</section>;
}

export function RunScopeBanner({ run }: { run: RunDetailDto }) {
  return <section className={`sw-run-scope${run.executionMode === 'research-trial' ? ' trial' : ''}`} aria-label="本次运行范围"><strong>{runScopeLabel(run)}</strong><span>{runScopeExplanation(run)}</span></section>;
}

function CaseSecondary({ title, summary, openForLink = false, children }: { title: string; summary: string; openForLink?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(openForLink);
  useEffect(() => { if (openForLink) setOpen(true); }, [openForLink]);
  return <details className="sw-case-secondary" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><strong>{title}</strong><span>{summary}</span></summary>{children}</details>;
}

export function FailedResponseEntry({ api, scope, runId, occurrence, onOpen }: { api: SpaceApi; scope: string; runId: string; occurrence: OccurrenceDto; onOpen: () => void }) {
  const saved = useQuery({ queryKey: ['space', scope, api.root, 'unpublished-responses', runId, occurrence.id], queryFn: ({ signal }) => api.unpublishedResponses(runId, occurrence.id, signal), retry: false });
  if (saved.isPending) return <p className="sw-muted">正在核对是否保存了未发布响应…</p>;
  if (saved.error) return <QueryNotice error={saved.error} retry={() => void saved.refetch()} />;
  return saved.data?.responses.length ? <button type="button" className="sw-link" onClick={onOpen}>阅读已保存未发布响应 · {saved.data.responses.length} 条</button> : <p className="sw-muted">未发现可读的未发布响应；不能据此推断模型没有留下其他记录。</p>;
}

export function CaseRunOutcome({ api, scope, run, process, error, retry, onAsset, onRecords, onChildRun }: { api: SpaceApi; scope: string; run: RunDetailDto; process?: ProcessDto; error: unknown; retry: () => void; onAsset: (id: string) => void; onRecords: (nodeId: string, occurrenceId: string) => void; onChildRun?: (run: RunSummaryDto) => void }) {
  const nativeAssets = useInfiniteQuery({ queryKey: ['space', scope, api.root, 'run-published-assets', run.id], queryFn: ({ pageParam, signal }) => api.runPublishedAssets(run.id, pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined, enabled: run.executionMode === 'external-host' || run.executionMode === 'imported', retry: false });
  const outputs = process?.occurrences.flatMap(occurrence => occurrence.outputs) || [];
  const exactAssets = nativeAssets.data?.pages.flatMap(page => page.items).filter(asset => asset.runId === run.id && asset.caseId === run.caseId && asset.versionId === run.versionId) ?? [];
  const published = [...new Map([...outputs, ...exactAssets.filter(asset => ['node', 'external-artifact', 'historical-artifact', 'transform'].includes(asset.sourceKind))].map(asset => [asset.id, asset])).values()];
  const associated = exactAssets.filter(asset => asset.sourceKind === 'import');
  const failures = process?.occurrences.filter(occurrence => occurrence.state === 'failed' || !!occurrence.terminalFailure) || [];
  return <section className="sw-case-outcome"><h3>本次结果与失败</h3>{process ? <><div className="sw-case-outcome-assets"><strong>已发布成果 · {published.length} 项</strong><AssetLinks assets={published} choose={onAsset} empty="此运行没有保存已发布的成果资产。" />{associated.length > 0 && <section><h4>关联导入材料 / 历史草稿 · {associated.length} 项</h4><p className="sw-muted">这些材料与此运行关联，未计入本运行自产成果；只读，原始来源仍以资产记录为准。</p><AssetLinks assets={associated} choose={onAsset} empty="没有关联导入材料。" /></section>}{nativeAssets.error && <QueryNotice error={nativeAssets.error} retry={() => void nativeAssets.refetch()} />}{nativeAssets.hasNextPage && <button onClick={() => void nativeAssets.fetchNextPage()}>读取更多本次资产</button>}{run.primaryAssetId && !published.some(asset => asset.id === run.primaryAssetId) && <button type="button" className="sw-link" onClick={() => onAsset(run.primaryAssetId!)}>阅读本次主要成果</button>}</div><NativeChildOutcomes api={api} scope={scope} run={run} onAsset={onAsset} onChildRun={onChildRun}/>{process.coverage !== 'observed' && <p className="sw-muted">过程覆盖为{process.coverage === 'partial' ? '部分' : '未知'}；这里列出准确归属本次运行的已发布成果，生产步骤关联可能仍有缺口。</p>}{failures.map(occurrence => <article className="sw-case-outcome-failure" key={occurrence.id}><strong>{occurrence.label} · {occurrence.terminalFailure ? terminalFailureLabel(occurrence.terminalFailure.error, occurrence.terminalFailure.failedAncestorStepKey) : '执行失败'}</strong><p>{occurrence.terminalFailure?.error || occurrence.failureDetails.map(step => step.error).filter(Boolean).join('；') || '具体原因未记录'}</p>{occurrence.nodeId && <FailedResponseEntry api={api} scope={scope} runId={run.id} occurrence={occurrence} onOpen={() => onRecords(occurrence.nodeId!, occurrence.id)} />}</article>)}{!failures.length && <p className="sw-muted">本次过程未记录失败节点；详情仍以各轮原始步骤为准。</p>}</> : <QueryNotice error={error} retry={retry} empty="正在读取本次准确成果与失败…" />}</section>;
}

function NativeChildOutcomes({ api, scope, run, onAsset, onChildRun }: { api: SpaceApi; scope: string; run: RunDetailDto; onAsset: (id: string) => void; onChildRun?: (run: RunSummaryDto) => void }) {
  const native = run.executionMode === 'external-host' || run.executionMode === 'imported';
  const children = useQuery({ queryKey: ['space', scope, api.root, 'native-child-index', run.id], queryFn: ({ signal }) => api.nativeRunEvents(run.id, 0, signal), enabled: native, retry: false });
  if (!native) return null;
  const bound = children.data?.children.filter(child => child.binding === 'bound') ?? [];
  if (!children.isPending && !children.error && !children.data?.children.length) return null;
  return <section className="sw-native-child-outcomes"><h4>此完整任务的子流程成果</h4><p className="sw-muted">成果保留在真实子流程；这里仅提供只读入口，不代表质量通过或已采用。修订稿仍需单独核验。</p>
    {children.isPending && <p>正在核对子流程关联…</p>}
    {children.error && <QueryNotice error={children.error} retry={() => void children.refetch()} />}
    {bound.map(child => <NativeChildOutcome key={child.runId} api={api} scope={scope} root={run} child={child} onAsset={onAsset} onChildRun={onChildRun}/>)}
    {children.data?.children.filter(child => child.binding === 'pending').map(child => <p key={child.runId}>{child.workflowId} · 关联尚未完成，不能当作本 Case 可读成果。</p>)}
  </section>;
}

function NativeChildOutcome({ api, scope, root, child, onAsset, onChildRun }: { api: SpaceApi; scope: string; root: RunDetailDto; child: { runId: string; workflowId: string; state: string }; onAsset: (id: string) => void; onChildRun?: (run: RunSummaryDto) => void }) {
  const childRun = useQuery({ queryKey: ['space', scope, api.root, 'native-child-run', child.runId], queryFn: ({ signal }) => api.run(child.runId, signal), retry: false });
  const valid = childRun.data?.id === child.runId && childRun.data.caseId === root.caseId && childRun.data.entrypoint === root.entrypoint && childRun.data.executionMode === root.executionMode;
  const assets = useInfiniteQuery({ queryKey: ['space', scope, api.root, 'run-published-assets', child.runId], queryFn: ({ pageParam, signal }) => api.runPublishedAssets(child.runId, pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined, enabled: valid, retry: false });
  const exact = valid ? assets.data?.pages.flatMap(page => page.items).filter(asset => asset.runId === child.runId && asset.caseId === root.caseId && asset.versionId === childRun.data!.versionId) ?? [] : [];
  return <article className="sw-native-child-outcome"><h5>{child.workflowId} · {child.state}</h5><p className="sw-muted">原生子运行 {child.runId} · 只读</p>
    {childRun.isPending && <p>正在核对子运行身份…</p>}
    {childRun.error && <QueryNotice error={childRun.error} retry={() => void childRun.refetch()} />}
    {childRun.data && !valid && <p role="alert">子运行与本 Case 的身份不一致，未展示资产。</p>}
    {valid && <>{onChildRun && <button type="button" className="sw-link" onClick={() => onChildRun(childRun.data!)}>阅读此子流程的运行记录</button>}
      {assets.isPending && <p>正在读取此子流程资产…</p>}
      {assets.error && <QueryNotice error={assets.error} retry={() => void assets.refetch()} />}
      {exact.map(asset => <Row key={asset.id} title={asset.title} sub={`${assetOriginLabel(asset)} · 登记状态 ${asset.state === 'revised-unverified' ? '修订未验证' : asset.state} · 只读`} onClick={() => onAsset(asset.id)}/>)}
      {assets.data && !exact.length && <p className="sw-muted">此子流程暂无可读的同 Case 发布资产。</p>}
      {assets.hasNextPage && <button onClick={() => void assets.fetchNextPage()}>读取更多此子流程资产</button>}</>}
  </article>;
}

function Graph({ url, title, allowedIds, selectedNode, onSelect, graphState, identity }: { url: string | null | undefined; title: string; allowedIds: ReadonlySet<string>; selectedNode?: string; onSelect: (nodeId: string) => void; graphState?: WorkflowGraphStateDto | null; identity?: GraphIdentity }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const serial = useRef(0);
  const safeUrl = useMemo(() => {
    if (!url) return null;
    try { const resolved = new URL(url, window.location.href); return resolved.origin === window.location.origin && resolved.protocol === window.location.protocol ? resolved.href : null; }
    catch { return null; }
  }, [url]);
  const sendState = () => {
    const nextSerial = serial.current + 1;
    if (postGraphState(frame.current?.contentWindow || null, graphState, identity, allowedIds, nextSerial)) serial.current = nextSerial;
  };
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (isGraphReady(event, frame.current?.contentWindow || null, identity)) {
        sendState();
        focusGraphNode(frame.current?.contentWindow || null, selectedNode, allowedIds);
        return;
      }
      const nodeId = selectedGraphNode(event, frame.current?.contentWindow || null, allowedIds);
      if (nodeId) onSelect(nodeId);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [allowedIds, onSelect, identity, graphState, selectedNode]);
  useEffect(() => { sendState(); }, [graphState, identity, allowedIds, safeUrl]);
  useEffect(() => { focusGraphNode(frame.current?.contentWindow || null, selectedNode, allowedIds); }, [selectedNode, allowedIds, safeUrl]);
  return <div className="sw-graph">{safeUrl ? <iframe key={safeUrl} ref={frame} title={title} src={safeUrl} sandbox="allow-scripts allow-downloads" onLoad={() => { sendState(); focusGraphNode(frame.current?.contentWindow || null, selectedNode, allowedIds); }} /> : <QueryNotice empty="这个历史对象没有保存可显示的图。可从列表阅读准确记录。" />}</div>;
}

function AssetLinks({ assets, choose, empty }: { assets: AssetSummaryDto[]; choose: (id: string) => void; empty: string }) {
  return assets.length ? <div className="sw-list">{assets.map(asset => <Row key={asset.id} title={asset.title} sub={assetOriginLabel(asset)} onClick={() => choose(asset.id)} />)}</div> : <p className="sw-muted">{empty}</p>;
}

function assetOriginLabel(asset: AssetSummaryDto): string {
  if (asset.sourceKind === 'import') return '导入资产';
  if (asset.sourceKind === 'transform') return '变换生成资产';
  return `${asset.round == null ? '轮次未记录' : `第 ${asset.round} 轮`}${asset.nodeId ? ` · ${asset.nodeId}` : ''}`;
}

function SavedReaderPane({ title, roundLabel, sections, view, evidence, chooseAsset }: { title?: string; roundLabel?: string; sections: ReaderSection[]; view: ReaderView; evidence?: { id: string; schema: AssetSummaryDto['schema']; readerStatus: string; sourceLinks: { ref: string; asset: AssetSummaryDto; pointer: string | null }[] }; chooseAsset: (id: string) => void }) {
  const shown = sectionsForView(sections, view);
  return <div>{title && <h4>{title}</h4>}{roundLabel && <p className="sw-reader-round">{roundLabel}</p>}{shown.length ? shown.map((section, index) => <section className="sw-reading-section" key={`${section.title}-${index}`}><h4>{section.title}</h4><p>{safeInlineLinks(section.text)}</p>{section.pointer && <small>{section.pointer}</small>}{section.sourceRefs?.length ? <small>来源：{section.sourceRefs.join('、')}</small> : null}</section>) : <p className="sw-muted">{view === 'visual' ? '没有保存画面文字。' : view === 'evidence' ? '没有保存独立的依据段落。' : '没有保存可读正文。'}</p>}{view === 'evidence' && evidence && <><dl><dt>资产 ID</dt><dd>{evidence.id}</dd><dt>Schema</dt><dd>{evidence.schema.namespace} · {evidence.schema.revision}</dd><dt>读取方式</dt><dd>{evidence.readerStatus}</dd></dl><h4>正文来源引用</h4>{evidence.sourceLinks.length ? evidence.sourceLinks.map((link, index) => <Row key={`${link.ref}-${index}`} title={link.asset.title} sub={link.pointer || link.ref} onClick={() => chooseAsset(link.asset.id)} />) : <p className="sw-muted">没有记录正文来源引用。</p>}</>}</div>;
}

const sourceSelectionLabels: Record<string, string> = { 'frozen-input': '冻结输入', 'current-business-round': '当前业务轮', 'previous-business-round': '上一业务轮', 'latest-successful-in-this-run': '本次最近成功' };
function SlotList({ title, slots, direction = 'input' }: { title: string; slots: NodeSummaryDto['inputs']; direction?: 'input' | 'output' }) {
  return <section><h4>{title}</h4>{slots.length ? slots.map(slot => <div className="sw-contract" key={slot.slot}><strong>{slot.label || slot.slot}</strong><span>{slot.schema.namespace} · {slot.schema.revision}</span>{direction === 'input' ? <><small>{slot.optional === null ? '必需性未记录' : slot.optional ? '可选' : '必需'}{slot.states.length ? ` · ${slot.states.join(' / ')}` : ' · 状态未记录'}</small>{slot.sources.length ? slot.sources.map((source, index) => <small key={`${source.source}-${index}`}>{source.when === 'initial-round' ? '首轮' : source.when === 'later-rounds' ? '后续轮次' : '每轮'}：{source.kind === 'run-input' ? '冻结输入' : `节点 ${source.source}${source.port ? ` / ${source.port}` : ''}`} · {sourceSelectionLabels[source.selection] || source.selection}</small>) : <small>来源未记录</small>}{slot.projection && <small>只读取投影字段：{slot.projection.fields.join('、') || '字段未记录'}</small>}</> : <small>{slot.requiredInputs.length ? `依赖保存输入：${slot.requiredInputs.join('、')}` : '依赖输入未记录'}</small>}</div>) : <p className="sw-muted">该版本没有记录此类槽位。</p>}</section>;
}

/** Select an exact saved attempt only when the opened runtime pane has one unambiguous context. */
export function automaticRuntimeAttempt(tab: string, selection: Selection, occurrence: OccurrenceDto | undefined, detail: OccurrenceDetailDto | undefined): Partial<Selection> | undefined {
  if (tab !== 'instructions' || selection.tab !== 'process' || !occurrence || detail?.id !== occurrence.id) return undefined;
  const attempts = agentAttemptContexts(detail.contexts);
  if (selection.runtimeAttempt && attempts.some(context => context.attemptId === selection.runtimeAttempt)) return undefined;
  const context = attempts.length === 1 ? attempts[0] : undefined;
  if (context?.attemptId) return { occurrence: occurrence.id, runtimeAttempt: context.attemptId, nodePane: 'instructions' };
  return selection.runtimeAttempt ? { occurrence: occurrence.id, runtimeAttempt: undefined, nodePane: 'instructions' } : undefined;
}

function WorkbenchInner({ spaceId, apiBase = '/api/workflow-spaces/v1' }: SpaceWorkbenchProps) {
  const api = useMemo(() => new SpaceApi(apiBase, spaceId), [apiBase, spaceId]);
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selection = useMemo(() => readSelection(params), [params]);
  const [nodeTab, setNodeTab] = useState(selection.nodePane || (selection.runtimeAttempt ? 'instructions' : 'overview'));
  const [runtimeCorrection, setRuntimeCorrection] = useState<{ occurrenceId: string; message: string }>();
  const [assetTab, setAssetTab] = useState('body');
  const [expanded, setExpanded] = useState(false);
  const [compareId, setCompareId] = useState<string>();
  const [assetSearch, setAssetSearch] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [planOpen, setPlanOpen] = useState(!!selection.plan && !selection.run && !selection.comparison);
  const [caseDirectoryOpen, setCaseDirectoryOpen] = useState(!selection.case && !selection.run);
  const [authBlocked, setAuthBlocked] = useState(false);
  const [workflowExpanded, setWorkflowExpanded] = useState(true);
  const [activeUnderstandingRevision, setActiveUnderstandingRevision] = useState<string>();
  const [activeMethodDesignRevision, setActiveMethodDesignRevision] = useState<string>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const inspectorScrollRef = useRef<HTMLDivElement>(null);
  const diagnosisAssetOrigin = useRef<{ runId: string; revisionId?: string; top: number | null; returning: boolean } | null>(null);
  const priorIdentity = useRef<string | undefined>(undefined);
  const priorRunState = useRef<{ id: string; state: string } | undefined>(undefined);
  const summaryQuery = useQuery({ queryKey: ['space-summary', api.root], queryFn: ({ signal }) => api.summary(signal), refetchInterval: query => document.visibilityState === 'visible' && !isAuthDenial(query.state.error) ? 5000 : false, retry: 1, staleTime: 0 });
  const deniedNow = isAuthDenial(summaryQuery.error);
  const summary = mayDisplaySummary(summaryQuery.data, summaryQuery.error, authBlocked) ? summaryQuery.data : undefined;
  const businessState = summary?.businessState;
  const scope = summary ? `${summary.subject.id}:${summary.subject.cacheScope}` : undefined;
  const sourceRevision = useQuery({ queryKey: ['space', scope, api.root, 'source-revision', selection.sourceRevision], queryFn: ({ signal }) => api.understanding(selection.sourceRevision!, signal), enabled: !!scope && !!selection.sourceRevision, retry: false });
  const sourceIndex = validSourceOriginIndex(selection.sourceIndex, sourceRevision.data?.sources.length);
  const sourceOrigin = sourceIndex !== null && sourceRevision.data?.id === selection.sourceRevision ? sourceRevision.data?.sources[sourceIndex] : undefined;
  const designSourceRevision = useQuery({ queryKey: ['space', scope, api.root, 'design-source-revision', selection.designSourceRevision], queryFn: ({ signal }) => api.methodDesign(selection.designSourceRevision!, signal), enabled: !!scope && !!selection.designSourceRevision, retry: false });
  const designSourceIndex = validSourceOriginIndex(selection.designSourceIndex, designSourceRevision.data?.sources.length);
  const designSourceOrigin = designSourceIndex !== null && designSourceRevision.data?.id === selection.designSourceRevision ? designSourceRevision.data?.sources[designSourceIndex] : undefined;
  useEffect(() => {
    if (!summary) return;
    const identity = `${summary.subject.id}:${summary.subject.cacheScope}`;
    if (identityChanged(priorIdentity.current, identity)) { discardScopedSpaceData(client, priorIdentity.current); setCompareId(undefined); }
    priorIdentity.current = identity;
  }, [summary?.subject.id, scope, client]);
  useEffect(() => {
    if (deniedNow) { setAuthBlocked(true); discardScopedSpaceData(client); setCompareId(undefined); }
    else if (summaryQuery.isSuccess && !summaryQuery.isFetching && summaryQuery.data) setAuthBlocked(false);
  }, [deniedNow, summaryQuery.isSuccess, summaryQuery.isFetching, summaryQuery.dataUpdatedAt, client]);
  const key = (part: string, ...ids: unknown[]) => ['space', scope, spaceId, part, ...ids];
  const currentDesign = useQuery({ queryKey: key('method-design-current'), queryFn: ({ signal }) => api.methodDesign(undefined, signal), enabled: !!scope && !!summary?.capabilities.methodDesignRead, retry: false });
  const versions = usePaged(key('versions'), (cursor, signal) => api.versions(cursor, signal), !!scope);
  const cases = usePaged(key('cases'), (cursor, signal) => api.cases(cursor, signal), !!scope);
  const assets = usePaged(key('assets', assetSearch), (cursor, signal) => api.assets(cursor, assetSearch || undefined, undefined, signal), !!scope && selection.view === 'assets');
  const loadedVersions = versions.data?.pages.flatMap(page => page.items) || [];
  const loadedCases = cases.data?.pages.flatMap(page => page.items) || [];
  const versionId = defaultMethodVersionId(selection, summary, loadedVersions[0]?.id);
  const mainVersionId = mainMethodVersionId(summary, versionId);
  const candidateRevisionId = params.get('candidateDesign') || (!versionId ? currentDesign.data?.id : null);
  const candidateMode = selection.view === 'workflow' && selection.tab === 'definition' && !!candidateRevisionId && params.get('candidateReader') !== '0' && (!!params.get('candidateDesign') || !versionId);
  const candidateDefinition = useQuery({ queryKey: key('method-design-definition', candidateRevisionId), queryFn: ({ signal }) => api.methodDesignDefinition(candidateRevisionId!, signal), enabled: !!scope && candidateMode, retry: false });
  const readingKey = scope ? readingPositionKey(api.root, scope, { ...selection, version: versionId }, { understanding: activeUnderstandingRevision, methodDesign: activeMethodDesignRevision }) : undefined;
  const inspectorReadingKey = scope && selection.node ? nodeInspectorReadingKey(api.root, scope, { ...selection, version: versionId }, nodeTab) : undefined;
  const sourceReadingKey = scope && selection.sourceRevision ? readingPositionKey(api.root, scope, { ...selection, view: 'goal', understandingRevision: selection.sourceRevision }, { understanding: selection.sourceRevision }) : undefined;
  const locateSourceOnReturn = selection.view === 'goal' && sourceReadingKey && typeof sessionStorage !== 'undefined' && !readReadingPosition(sessionStorage, sourceReadingKey) && sourceOrigin ? sourceIndex ?? undefined : undefined;
  const designSourceReadingKey = scope && selection.designSourceRevision ? readingPositionKey(api.root, scope, { ...selection, view: 'workflow', tab: 'design', methodDesignRevision: selection.designSourceRevision }, { methodDesign: selection.designSourceRevision }) : undefined;
  const locateDesignSourceOnReturn = selection.view === 'workflow' && selection.tab === 'design' && designSourceReadingKey && typeof sessionStorage !== 'undefined' && !readReadingPosition(sessionStorage, designSourceReadingKey) && designSourceOrigin ? designSourceIndex ?? undefined : undefined;
  useReadingPosition(canvasRef, readingKey);
  useReadingPosition(inspectorScrollRef, inspectorReadingKey);
  useLayoutEffect(() => {
    const origin = diagnosisAssetOrigin.current;
    if (!origin?.returning || selection.run !== origin.runId || selection.asset || selection.expectedAsset || selection.comparison || selection.node) return;
    if (origin.top === null) document.getElementById('run-diagnosis')?.scrollIntoView({ block: 'start' });
    else if (canvasRef.current) canvasRef.current.scrollTop = origin.top;
    diagnosisAssetOrigin.current = null;
  }, [selection.run, selection.asset, selection.expectedAsset, selection.comparison, selection.node]);
  useEffect(() => {
    if (summary && !selection.version && versionId) setParams(writeSelection(params, { ...selection, version: versionId }), { replace: true });
  }, [summary, selection.version, versionId, params, setParams]);
  useEffect(() => {
    if (shouldOpenBlankGoal(params, { businessState, latestVersionId: summary?.latestVersionId || null, adoptedVersionId: summary?.adoptedVersionId || null })) {
      setParams(writeSelection(params, { ...selection, view: 'goal' }), { replace: true });
    }
  }, [businessState, summary?.latestVersionId, summary?.adoptedVersionId, params, selection, setParams]);
  const versionQuery = useQuery({ queryKey: key('version', versionId), queryFn: ({ signal }) => api.version(versionId!, signal), enabled: !!scope && !!versionId });
  const versionCases = usePaged(key('version-cases', versionId), (cursor, signal) => api.versionCases(versionId!, cursor, signal), !!scope && !!versionId && selection.view === 'workflow' && selection.tab === 'process');
  const runQuery = useQuery({ queryKey: key('run', selection.run), queryFn: ({ signal }) => api.run(selection.run!, signal), enabled: !!scope && !!selection.run, refetchInterval: query => query.state.data && isActiveRun(query.state.data.state) && document.visibilityState === 'visible' ? 3000 : false });
  const run = runQuery.data;
  const caseId = selection.case || run?.caseId;
  const caseQuery = useQuery({ queryKey: key('case', caseId), queryFn: ({ signal }) => api.case(caseId!, signal), enabled: !!scope && !!caseId });
  const caseData = caseForSelection(caseId, caseQuery.data, loadedCases);
  const caseRuns = usePaged(key('case-runs', caseId), (cursor, signal) => api.caseRuns(caseId!, cursor, signal), !!scope && !!caseId);
  const processQuery = useQuery({ queryKey: key('process', selection.run), queryFn: ({ signal }) => api.process(selection.run!, signal), enabled: !!scope && !!selection.run && selection.tab === 'process', refetchInterval: query => run && isActiveRun(run.state) && document.visibilityState === 'visible' ? 3000 : false });
  const version = versionQuery.data;
  const candidateRegistered = !!(candidateDefinition.data && version && candidateDefinition.data.candidateId === version.id);
  const process = processQuery.data;
  const expectedAssets = version?.expectedAssets.assets || [];
  const expectedAsset = expectedAssets.find(item => item.id === selection.expectedAsset);
  const nodes = selection.tab === 'process' ? process?.nodes || [] : version?.nodes || [];
  const node = nodes.find(item => item.id === selection.node);
  const allowedIds = useMemo(() => new Set([...nodes.map(item => item.id), ...(selection.tab === 'definition' ? expectedAssets.map(item => item.id) : selection.tab === 'process' ? process?.graphAssetIds || [] : [])]), [nodes, expectedAssets, process?.graphAssetIds, selection.tab]);
  const occurrences = process?.occurrences.filter(item => item.nodeId === selection.node) || [];
  const selectedOccurrence = latestOccurrence(occurrences, selection.occurrence);
  const occurrenceQuery = useQuery({ queryKey: key('occurrence', selection.run, selectedOccurrence?.id), queryFn: ({ signal }) => api.occurrence(selection.run!, selectedOccurrence!.id, signal), enabled: !!scope && !!selection.run && !!selectedOccurrence && nodeTab !== 'overview', refetchInterval: () => run && isActiveRun(run.state) && document.visibilityState === 'visible' ? 3000 : false });
  const nodeDetail = useQuery({ queryKey: key('node', versionId, selection.node), queryFn: ({ signal }) => api.node(versionId!, selection.node!, signal), enabled: !!scope && !!versionId && !!selection.node && nodeTab === 'config' && selection.tab !== 'process' });
  const reading = useQuery({ queryKey: key('reading', selection.asset), queryFn: ({ signal }) => api.reading(selection.asset!, signal), enabled: !!scope && !!selection.asset });
  const relations = useQuery({ queryKey: key('relations', selection.asset), queryFn: ({ signal }) => api.relations(selection.asset!, undefined, signal), enabled: !!scope && !!selection.asset });
  const compareReading = useQuery({ queryKey: key('reading', compareId), queryFn: ({ signal }) => api.reading(compareId!, signal), enabled: !!scope && !!compareId });
  const diagnosisDraftKey = selection.run && scope ? diagnosisDraftStorageKey(api.root, scope, selection.run) : null;
  const mayLeaveDiagnosis = (next: Selection) => !diagnosisDraftKey || selection.view !== 'business' || (next.view === 'business' && next.run === selection.run) || !sessionStorage.getItem(diagnosisDraftKey) || window.confirm('本次诊断有未保存修改；离开后草稿仍会保留在此浏览器会话。确定离开？');
  const update = (patch: Partial<Selection>, replace = false) => { const next = { ...selection, ...patch }; if (mayLeaveDiagnosis(next)) { const url = writeSelection(params, next); if (next.view !== 'workflow') for (const key of ['candidateDesign', 'candidateVersion', 'candidateNode', 'candidateReader']) url.delete(key); setParams(url, { replace }); } };
  const openCandidate = (revisionId?: string) => {
    const next = writeSelection(params, { ...selection, view: 'workflow', tab: 'definition', node: undefined, expectedAsset: undefined, asset: undefined });
    const target = revisionId || params.get('candidateDesign') || currentDesign.data?.id;
    if (target) {
      if (next.get('candidateDesign') !== target) { next.delete('candidateVersion'); next.delete('candidateNode'); }
      next.set('candidateDesign', target);
    }
    next.set('candidateReader', '1');
    if (mayLeaveDiagnosis({ ...selection, view: 'workflow', tab: 'definition' })) setParams(next);
  };
  const openPublishedDefinition = (id?: string) => {
    const target = id || versionId;
    if (!target) return;
    const nextSelection = { ...selectVersion(selection, target), view: 'workflow' as const, tab: 'definition' as const };
    if (!mayLeaveDiagnosis(nextSelection)) return;
    setParams(publishedDefinitionParams(params, selection, target));
  };
  useEffect(() => {
    setNodeTab(selection.nodePane || (selection.runtimeAttempt ? 'instructions' : 'overview'));
  }, [selection.node, selection.nodePane, selection.runtimeAttempt, selection.tab]);
  useEffect(() => {
    const patch = node?.kind === 'agent' ? automaticRuntimeAttempt(nodeTab, selection, selectedOccurrence, occurrenceQuery.data) : undefined;
    if (patch) {
      if (selection.runtimeAttempt && selectedOccurrence && occurrenceQuery.data) {
        const previous = occurrenceQuery.data.contexts.find(context => context.attemptId === selection.runtimeAttempt);
        const origin = previous?.producer === 'program' ? '程序上下文' : '非本轮 Agent 尝试';
        setRuntimeCorrection({ occurrenceId: selectedOccurrence.id, message: `原链接尝试 ${selection.runtimeAttempt} 属于${origin}；${patch.runtimeAttempt ? '已定位此轮唯一真实 Agent 尝试。' : '请明确选择保存的 Agent 尝试。'}` });
      }
      update(patch, true);
    }
  }, [nodeTab, node?.kind, selection.tab, selection.runtimeAttempt, selectedOccurrence?.id, occurrenceQuery.data?.id, occurrenceQuery.data?.contexts]);
  const chooseRun = (item: RunSummaryDto) => { const next = selectRun(selection, item); if (!mayLeaveDiagnosis(next)) return; setParams(writeSelection(params, next)); setNodeTab('overview'); };
  const chooseAsset = (id: string) => { update({ asset: id, expectedAsset: undefined, comparison: undefined }); setAssetTab('body'); setExpanded(false); setCompareId(undefined); };
  const openDiagnosisAsset = (id: string) => {
    if (!selection.run) return;
    const revisionId = (params.get('diagnosisRun') === selection.run ? params.get('diagnosisRevision') : null)
      || client.getQueryData<{ id: string } | null>(['space', scope, api.root, 'run-diagnosis', selection.run, 'current'])?.id;
    diagnosisAssetOrigin.current = { runId: selection.run, revisionId: revisionId || undefined, top: canvasRef.current?.scrollTop ?? null, returning: false };
    setParams(diagnosisAssetParams(params, selection, id, selection.run, revisionId || undefined));
    setAssetTab('body'); setExpanded(false); setCompareId(undefined);
  };
  const returnToDiagnosis = () => {
    if (!selection.run) return;
    const saved = diagnosisAssetOrigin.current?.runId === selection.run ? diagnosisAssetOrigin.current : null;
    const revisionId = saved?.revisionId || params.get('diagnosisRevision') || undefined;
    diagnosisAssetOrigin.current = { runId: selection.run, revisionId, top: saved?.top ?? null, returning: true };
    setParams(diagnosisReturnParams(params, selection, selection.run, revisionId));
    setExpanded(false); setCompareId(undefined); setAssetTab('body');
  };
  const openBusinessSource = (kind: 'asset' | 'case', id: string, revisionId: string, index: number) => {
    const next: Selection = { ...selection, view: kind === 'asset' ? 'assets' : 'business', tab: 'process', understandingRevision: revisionId, sourceRevision: revisionId, sourceIndex: String(index), designSourceRevision: undefined, designSourceIndex: undefined, case: kind === 'case' ? id : undefined, run: undefined, node: undefined, occurrence: undefined, asset: kind === 'asset' ? id : undefined, expectedAsset: undefined, comparison: undefined };
    if (!mayLeaveDiagnosis(next)) return;
    setParams(writeSelection(params, next));
    if (kind === 'asset') { setAssetTab('body'); setExpanded(false); setCompareId(undefined); }
  };
  const returnToBusinessSource = () => {
    if (!selection.sourceRevision || sourceIndex === null || !sourceOrigin) return;
    const next: Selection = { ...selection, view: 'goal', understandingRevision: selection.sourceRevision, asset: undefined, expectedAsset: undefined, comparison: undefined, node: undefined, occurrence: undefined };
    if (mayLeaveDiagnosis(next)) setParams(writeSelection(params, next));
  };
  const openDesignSource = (kind: 'asset' | 'case', id: string, revisionId: string, index: number) => {
    const next: Selection = { ...selection, view: kind === 'asset' ? 'assets' : 'business', tab: 'process', methodDesignRevision: revisionId, designSourceRevision: revisionId, designSourceIndex: String(index), sourceRevision: undefined, sourceIndex: undefined, case: kind === 'case' ? id : undefined, run: undefined, node: undefined, occurrence: undefined, asset: kind === 'asset' ? id : undefined, expectedAsset: undefined, comparison: undefined };
    if (!mayLeaveDiagnosis(next)) return;
    setParams(writeSelection(params, next));
    if (kind === 'asset') { setAssetTab('body'); setExpanded(false); setCompareId(undefined); }
  };
  const returnToDesignSource = () => {
    if (!selection.designSourceRevision || designSourceIndex === null || !designSourceOrigin) return;
    const next: Selection = { ...selection, view: 'workflow', tab: 'design', methodDesignRevision: selection.designSourceRevision, asset: undefined, expectedAsset: undefined, comparison: undefined, node: undefined, occurrence: undefined };
    if (mayLeaveDiagnosis(next)) setParams(writeSelection(params, next));
  };
  const diagnosisLink = (field: 'diagnosisReview' | 'diagnosisDisposition', id: string) => { if (!selection.run) return; const next = new URLSearchParams(params); next.set('diagnosisRun', selection.run); next.set(field, id); next.delete(field === 'diagnosisReview' ? 'diagnosisDisposition' : 'diagnosisReview'); next.delete('diagnosisRevision'); setParams(next); requestAnimationFrame(() => document.getElementById('run-diagnosis')?.scrollIntoView({ block: 'start' })); };
  const assessmentLink = (field: 'assessmentReview' | 'assessmentDisposition' | 'assessmentSubject', id: string) => { if (!selection.run) return; const next = new URLSearchParams(params); next.set('assessmentRun', selection.run); next.set(field, id); setParams(next); requestAnimationFrame(() => document.querySelector('.sw-run-assessment')?.scrollIntoView({ block: 'start' })); };
  const chooseExpectedAsset = (id: string) => { update({ expectedAsset: id, asset: undefined, node: undefined, occurrence: undefined, comparison: undefined }); setExpanded(false); };
  const chooseNode = (id: string) => { if (selection.node === id) return; setParams(writeSelection(params, selectNode(selection, id))); setNodeTab('overview'); };
  const chooseGraphEntity = (id: string) => {
    const kind = graphEntityKind(selection.tab, id, expectedAssets.map(item => item.id), process?.graphAssetIds || []);
    if (kind === 'actual-asset') chooseAsset(id);
    else if (kind === 'expected-asset') chooseExpectedAsset(id);
    else chooseNode(id);
  };
  useEffect(() => {
    if (run && (selection.version !== run.versionId || selection.case !== run.caseId)) update({ version: run.versionId, case: run.caseId }, true);
  }, [run?.id, run?.versionId, run?.caseId, selection.version, selection.case]);
  useEffect(() => {
    if (selection.node && nodes.length && !nodes.some(item => item.id === selection.node)) update({ node: undefined, occurrence: undefined }, true);
  }, [selection.node, nodes]);
  useEffect(() => {
    if (selection.expectedAsset && version && !expectedAssets.some(item => item.id === selection.expectedAsset)) update({ expectedAsset: undefined }, true);
  }, [selection.expectedAsset, version?.id, expectedAssets]);
  useEffect(() => {
    if (selection.occurrence && process && !process.occurrences.some(item => item.id === selection.occurrence && item.nodeId === selection.node)) update({ occurrence: undefined }, true);
  }, [selection.occurrence, selection.node, process]);
  useEffect(() => {
    const previous = priorRunState.current;
    if (!run) { priorRunState.current = undefined; return; }
    priorRunState.current = { id: run.id, state: run.state };
    if (needsFinalProcessRefresh(previous, run, selection.tab === 'process')) {
      void processQuery.refetch().then(() => client.invalidateQueries({ queryKey: key('occurrence', run.id) }));
    }
  }, [run?.id, run?.state, selection.tab]);
  const graphUrl = selection.tab === 'process' ? process?.graphUrl : version?.graphUrl;
  const graphTitle = selection.tab === 'process' ? '运行过程图' : '方法定义图';
  const graphIdentity = useMemo<GraphIdentity | undefined>(() => selection.tab === 'process' && selection.run && process ? { spaceId, runId: selection.run, versionId: process.versionId } : undefined, [selection.tab, selection.run, process?.versionId, spaceId]);
  const graphState = selection.tab === 'process'
    ? !selection.run ? 'choose-run' : processQuery.isPending ? 'loading' : processQuery.error ? 'error' : 'ready'
    : !versionId ? 'choose-version' : versionQuery.isPending ? 'loading' : versionQuery.error ? 'error' : version?.definitionAvailability === 'missing' ? 'missing-definition' : 'ready';
  const graphError = selection.tab === 'process' ? processQuery.error : versionQuery.error;
  const retryGraph = () => void (selection.tab === 'process' ? processQuery.refetch() : versionQuery.refetch());
  const allCaseRuns = mergeCurrentRun(caseRuns.data?.pages.flatMap(page => page.items) || [], run, caseId);
  const allRuns = selection.view === 'workflow' ? allCaseRuns.filter(item => item.versionId === versionId) : allCaseRuns;
  const runVersionLabel = loadedVersions.find(item => item.id === run?.versionId)?.label || run?.versionLabel;
  useEffect(() => { if (selection.comparison || selection.run) setPlanOpen(false); else if (selection.plan) setPlanOpen(true); }, [selection.plan, selection.run, selection.comparison]);
  useEffect(() => { if (selection.view === 'workflow' && selection.tab === 'process' && !caseId && !selection.run) setCaseDirectoryOpen(true); }, [selection.view, selection.tab, caseId, selection.run]);
  if (!summary) return <QueryNotice error={summaryQuery.error} retry={() => void summaryQuery.refetch()} empty="正在验证 Space 读取身份…" />;
  return <div className="sw-app">
    <aside className={`sw-sidebar${mobileMenu ? ' open' : ''}`} aria-label="Space 导航">
      <div className="sw-brand"><span>S</span><div>Space<small>工作台</small></div></div>
      <div className="sw-identity"><small>当前 Space</small><h1>{summary.title}</h1><p>{summary.purpose}</p></div>
      <nav aria-label="主导航" className="sw-side-nav">
        <button aria-current={selection.view === 'goal' ? 'page' : undefined} className={selection.view === 'goal' ? 'active' : ''} onClick={() => { update({ view: 'goal', asset: undefined, expectedAsset: undefined, node: undefined, occurrence: undefined }); setMobileMenu(false); }}>业务目标</button>
        <div className="sw-side-group">
          <div className="sw-side-heading"><button aria-current={selection.view === 'workflow' ? 'page' : undefined} className={selection.view === 'workflow' ? 'active' : ''} onClick={() => { update({ view: 'workflow', tab: 'basis', asset: undefined, expectedAsset: undefined, node: undefined, occurrence: undefined }); setWorkflowExpanded(true); setMobileMenu(false); }}>工作流</button><button className="sw-side-expand" aria-label={workflowExpanded ? '收起工作流目录' : '展开工作流目录'} aria-expanded={workflowExpanded} onClick={() => setWorkflowExpanded(!workflowExpanded)}>{workflowExpanded ? '⌄' : '›'}</button></div>
          {workflowExpanded && <div className="sw-side-children">
            {summary.capabilities.methodDesignRead && <button className={selection.view === 'workflow' && selection.tab === 'design' ? 'active' : ''} aria-current={selection.view === 'workflow' && selection.tab === 'design' ? 'page' : undefined} onClick={() => { update({ view: 'workflow', tab: 'design', asset: undefined, expectedAsset: undefined, node: undefined, occurrence: undefined }); setMobileMenu(false); }}>{businessState?.methodDesignRevisions === 0 ? '设计草案' : '现有设计草案'}</button>}
            <button className={selection.view === 'workflow' && selection.tab === 'history' ? 'active' : ''} aria-current={selection.view === 'workflow' && selection.tab === 'history' ? 'page' : undefined} onClick={() => { update({ view: 'workflow', tab: 'history', node: undefined, occurrence: undefined, asset: undefined, expectedAsset: undefined }); setMobileMenu(false); }}>版本总览</button>
            <div className="sw-side-version"><small>准确版本</small><select aria-label="侧栏选择准确方法版本" value={versionId || ''} onChange={event => { const next = { ...selectVersion(selection, event.target.value), view: 'workflow' as const, tab: 'basis' as const }; if (mayLeaveDiagnosis(next)) { const url = writeSelection(params, next); url.set('candidateReader', '0'); setParams(url); } setMobileMenu(false); }}><option value="" disabled>选择版本</option>{versionId && !loadedVersions.some(item => item.id === versionId) && <option value={versionId}>{version?.revision || '已选'} · {version?.label || versionId}</option>}<VersionOptions versions={loadedVersions} /></select>{versions.hasNextPage && <button className="sw-side-more" onClick={() => void versions.fetchNextPage()}>更多版本</button>}</div>
            <div className="sw-side-version-children"><button className={selection.view === 'workflow' && selection.tab === 'definition' ? 'active' : ''} aria-current={selection.view === 'workflow' && selection.tab === 'definition' ? 'page' : undefined} onClick={() => { if (versionId) openPublishedDefinition(); else if (currentDesign.data?.capability) openCandidate(currentDesign.data.id); else update({ view: 'workflow', tab: 'definition', node: undefined, occurrence: undefined, asset: undefined, expectedAsset: undefined }); setMobileMenu(false); }}>方法与产出</button>{versionId && ([['basis', '本版设计'], ['process', '案例与运行']] as const).map(([tab, title]) => <button key={tab} className={selection.view === 'workflow' && selection.tab === tab ? 'active' : ''} aria-current={selection.view === 'workflow' && selection.tab === tab ? 'page' : undefined} onClick={() => { update({ view: 'workflow', tab, node: undefined, occurrence: undefined, asset: undefined, expectedAsset: undefined }); if (tab === 'process') setCaseDirectoryOpen(true); setMobileMenu(false); }}>{title}</button>)}</div>
          </div>}
        </div>
        <button aria-current={selection.view === 'business' ? 'page' : undefined} className={selection.view === 'business' ? 'active' : ''} onClick={() => { update({ view: 'business', tab: 'process', asset: undefined, expectedAsset: undefined, node: undefined, occurrence: undefined }); setMobileMenu(false); }}>业务</button>
        <button aria-current={selection.view === 'assets' ? 'page' : undefined} className={selection.view === 'assets' ? 'active' : ''} onClick={() => { update({ view: 'assets', asset: undefined, expectedAsset: undefined, node: undefined, occurrence: undefined }); setMobileMenu(false); }}>资产</button>
      </nav>
      <div className="sw-sidefoot">真实 Space 数据 · {summary.capabilities.write || summary.capabilities.understandingWrite ? '受限操作' : '只读'}</div>
    </aside>
    <div className="sw-main">
      <header className="sw-topbar"><button className="sw-menu" onClick={() => setMobileMenu(!mobileMenu)} aria-label="打开导航" aria-expanded={mobileMenu}>☰</button><div><small>{selection.view === 'goal' ? '业务目标' : selection.view === 'business' ? run ? `业务 · ${runScopeLabel(run)}` : '业务' : selection.view === 'assets' ? '资产' : '工作流'}</small><h2>{selection.view === 'goal' ? summary.title : selection.view === 'workflow' && selection.tab === 'design' ? businessState?.methodDesignRevisions === 0 ? '设计草案' : '现有设计草案' : candidateMode ? '方法候选预览' : selection.view === 'assets' ? '资产目录' : selection.view === 'business' ? label(caseData?.title, '案例与运行') : versionQuery.error ? '准确版本读取失败' : label(version?.label, '方法版本')}</h2></div><span className="sw-live">实时读取 · {candidateMode ? '候选阅读' : selection.view === 'goal' ? summary.capabilities.understandingWrite ? '可修订理解' : '只读' : selection.view === 'workflow' && selection.tab === 'design' ? summary.capabilities.methodDesignWrite ? '可修订草案' : '只读' : summary.capabilities.write ? '受限操作' : '只读'}</span></header>
      <div className="sw-context">{selection.view === 'goal' ? <><span>业务理解 · 独立修订记录</span><span>正在查看：{selection.understandingRevision ? '指定修订' : '当前修订'}</span></> : selection.view === 'workflow' && selection.tab === 'design' ? <><span>方法形成 · 草案与准确版本分开</span><span>正在查看：{selection.methodDesignRevision ? '指定草案修订' : '当前设计草案'}</span></> : candidateMode ? <><span>{candidateRegistered ? '同 ID 准确版本已登记；此处仍是当前实现编译的候选预览' : '候选预览；登记状态请以准确版本记录为准'}</span><span>设计修订 {candidateRevisionId}</span></> : <><span>当前范围采用：{summary.methodScope.adoptionSlot ? summary.adoptedVersionId ? label(loadedVersions.find(item => item.id === summary.adoptedVersionId)?.label, summary.adoptedVersionId) : '未指定' : '宿主未指定采用范围'}</span><span>正在查看：{versionQuery.error ? `版本 ${versionId} 读取失败` : label(version?.label, '待选择')}{version && ` · ${adoptionLabel(version, summary)}`}{run ? ` · ${runScopeLabel(run)} · ${label(runVersionLabel)} · ${stateLabel(run.state)}` : ''}{version ? ` · ${availabilityLabel(version)}` : ''}</span></>}</div>
        {selection.sourceRevision && selection.view !== 'goal' && <div className="sw-source-return">{sourceOrigin ? <><button type="button" onClick={returnToBusinessSource}>返回业务理解来源 · {sourceOrigin.title}</button><button type="button" onClick={() => update({ sourceRevision: undefined, sourceIndex: undefined })}>结束来源追读</button></> : <span role={sourceRevision.error || sourceRevision.data ? 'alert' : undefined}>{sourceRevision.error ? '原业务理解修订在当前 Space 不可读取；不能返回未核实的来源。' : sourceRevision.data ? '来源位置无效；不能返回未核实的来源。' : '正在核对原业务理解来源…'}{sourceRevision.error && <button type="button" onClick={() => void sourceRevision.refetch()}>重试</button>}</span>}</div>}
        {selection.designSourceRevision && !(selection.view === 'workflow' && selection.tab === 'design') && <div className="sw-source-return">{designSourceOrigin ? <><button type="button" onClick={returnToDesignSource}>返回设计草案来源 · {designSourceOrigin.title}</button><button type="button" onClick={() => update({ designSourceRevision: undefined, designSourceIndex: undefined })}>结束来源追读</button></> : <span role={designSourceRevision.error || designSourceRevision.data ? 'alert' : undefined}>{designSourceRevision.error ? '原设计草案修订在当前 Space 不可读取；不能返回未核实的来源。' : designSourceRevision.data ? '来源位置无效；不能返回未核实的来源。' : '正在核对原设计草案来源…'}{designSourceRevision.error && <button type="button" onClick={() => void designSourceRevision.refetch()}>重试</button>}</span>}</div>}
      <main className="sw-workspace">
        <div className="sw-toolbar">
          {(selection.view === 'business' || (selection.view === 'workflow' && selection.tab !== 'design' && !candidateMode)) && <><label>准确方法 <select aria-label="选择方法版本" value={versionId || ''} onChange={event => { const next = selectVersion(selection, event.target.value); if (mayLeaveDiagnosis(next)) { const url = writeSelection(params, next); url.delete('candidateDesign'); url.delete('candidateVersion'); url.delete('candidateNode'); url.set('candidateReader', '0'); setParams(url); } }}><option value="">选择版本</option>{versionId && !loadedVersions.some(item => item.id === versionId) && <option value={versionId}>已选择版本 · {version?.revision ? `${version.revision} · ` : ''}{version?.label || versionId}</option>}<VersionOptions versions={loadedVersions} /></select></label>{versions.hasNextPage && <button onClick={() => void versions.fetchNextPage()}>更多版本</button>}</>}
          {selection.view === 'workflow' && <Tabs items={summary.capabilities.methodDesignRead ? [["design", businessState?.methodDesignRevisions === 0 ? "设计草案" : "现有设计草案"], ["basis", "本版设计"], ["definition", "方法与产出"], ["process", "案例与运行"], ["history", "版本总览"]] : [["basis", "本版设计"], ["definition", "方法与产出"], ["process", "案例与运行"], ["history", "版本总览"]]} value={selection.tab} onChange={value => { if (value === 'definition' && versionId) openPublishedDefinition(); else if (value === 'definition' && currentDesign.data?.capability) openCandidate(currentDesign.data.id); else update({ tab: value as Selection['tab'], node: undefined, occurrence: undefined, runtimeAttempt: undefined, nodePane: undefined, asset: undefined, expectedAsset: undefined }); setNodeTab('overview'); }} />}
          {(selection.view === 'business' || (selection.view === 'workflow' && selection.tab === 'process')) && <><label>案例 <select aria-label="选择案例" value={caseId || ''} onChange={event => update({ case: event.target.value || undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined, expectedAsset: undefined, plan: undefined, entry: undefined })}><option value="">选择案例</option>{cases.data?.pages.flatMap(page => page.items).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{cases.hasNextPage && <button onClick={() => void cases.fetchNextPage()}>更多案例</button>}</>}
          {(selection.view === 'business' || (selection.view === 'workflow' && selection.tab === 'process')) && <><label>运行 <select aria-label="选择运行" value={selection.run || ''} onChange={event => { const item = allRuns.find(run => run.id === event.target.value); if (item) chooseRun(item); else update({ run: undefined, node: undefined, occurrence: undefined, expectedAsset: undefined }); }}><option value="">选择运行</option>{allRuns.map(item => <option key={item.id} value={item.id}>{item.label} · {runScopeLabel(item)} · {stateLabel(item.state)}</option>)}</select></label>{caseRuns.hasNextPage && <button onClick={() => void caseRuns.fetchNextPage()}>更多运行</button>}</>}
          {selection.view === 'workflow' && <button onClick={() => update({ view: 'business', tab: 'process', case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined })}>查看全部案例</button>}
        </div>
        <div className={`sw-canvas${candidateMode ? ' sw-candidate-canvas' : ''}`} ref={canvasRef}>
          {selection.view === 'goal' && scope && <Understanding key={`${scope}:${api.root}`} api={api} scope={scope} summaryTitle={summary.title} principal={summary.subject.id} csrfToken={summary.csrfToken} writable={summary.capabilities.understandingWrite === true} businessState={businessState} selectedRevisionId={selection.understandingRevision} exactVersionId={mainVersionId} externalAgent={summary.subject.externalAgent} onActiveRevision={setActiveUnderstandingRevision} onSelectRevision={id => update({ understandingRevision: id })} onMethod={() => { if (mainVersionId) setParams(publishedDefinitionParams(params, selection, mainVersionId)); }} onDesign={summary.capabilities.methodDesignRead ? () => update({ view: 'workflow', tab: 'design', methodDesignRevision: undefined }) : undefined} onOpenSource={openBusinessSource} returnSourceIndex={locateSourceOnReturn} />}
          {selection.view === 'workflow' && selection.tab === 'design' && scope && summary.capabilities.methodDesignRead && <MethodDesign api={api} scope={scope} principal={summary.subject.id} workflowId={summary.methodScope.workflowId} entrypoint={summary.methodScope.entrypoint} csrfToken={summary.csrfToken} canWrite={summary.capabilities.methodDesignWrite === true} canPublish={summary.capabilities.methodPublish === true} selectedRevisionId={selection.methodDesignRevision} externalAgent={summary.subject.externalAgent} onActiveRevision={setActiveMethodDesignRevision} onSelectRevision={id => update({ methodDesignRevision: id })} onGoalRevision={id => update({ view: 'goal', understandingRevision: id })} onOpenCandidate={openCandidate} onOpenSource={openDesignSource} returnSourceIndex={locateDesignSourceOnReturn} onPublished={id => { void client.invalidateQueries({ queryKey: key('versions') }); openPublishedDefinition(id); }} />}
          {candidateMode && (candidateDefinition.data ? <MethodCandidate definition={candidateDefinition.data} apiRoot={api.root} registeredVersionId={candidateRegistered ? version?.id : undefined} onOpenRegistered={() => openPublishedDefinition(version?.id)} /> : <QueryNotice error={candidateDefinition.error} retry={() => void candidateDefinition.refetch()} empty="正在读取候选方法与产出…" />)}
          {selection.view === 'assets' ? <section className="sw-catalog"><div className="sw-catalog-head"><h3>跨案例资产</h3><input type="search" value={assetSearch} onChange={event => setAssetSearch(event.target.value)} placeholder="搜索资产" aria-label="搜索资产" /></div><div className="sw-catalog-list"><LoadMore source={assets} empty="没有匹配的资产。" render={item => <Row key={item.id} title={item.title} sub={assetOriginLabel(item)} selected={selection.asset === item.id} onClick={() => chooseAsset(item.id)} />} /></div></section> : null}
          {selection.view === 'business' && scope && <CaseContext api={api} scope={scope} caseData={caseData} run={run} error={caseQuery.error} retry={() => void caseQuery.refetch()} onAsset={chooseAsset} />}
          {selection.view === 'business' && scope && caseId && !run && <CaseFrozenInputs api={api} scope={scope} caseId={caseId} runCount={caseData?.runCount} onAsset={chooseAsset} />}
          {selection.view === 'business' && caseId && <CaseSecondary key={`${caseId}:${run ? 'selected' : 'none'}`} title="本案例全部运行" summary={caseData ? `${allCaseRuns.length} / ${caseData.runCount} 次已读取` : `${allCaseRuns.length} 次已读取`} openForLink={!run}><p>{caseData ? `已读取 ${allCaseRuns.length} / ${caseData.runCount} 次` : `${allCaseRuns.length} 次已读取` } · 选择任意一次查看准确输入、过程与产物。</p>{allCaseRuns.map(item => <Row key={item.id} title={item.label} sub={`${runScopeLabel(item)} · ${stateLabel(item.state)} · ${item.assetCount} 项资产${item.reason ? ` · ${item.reason}` : ''}`} selected={selection.run === item.id} onClick={() => chooseRun(item)} />)}{!allCaseRuns.length && !caseRuns.isPending && !caseRuns.error && <p className="sw-muted">本案例尚无运行。</p>}{caseRuns.error && <QueryNotice error={caseRuns.error} retry={() => void caseRuns.refetch()} />}{caseRuns.hasNextPage && <button className="sw-more" disabled={caseRuns.isFetchingNextPage} onClick={() => void caseRuns.fetchNextPage()}>{caseRuns.isFetchingNextPage ? '正在读取…' : '加载更早运行'}</button>}</CaseSecondary>}
          {selection.view === 'business' && scope && run && <CaseRunOutcome api={api} scope={scope} run={run} process={process} error={processQuery.error} retry={() => void processQuery.refetch()} onAsset={chooseAsset} onChildRun={chooseRun} onRecords={(nodeId, occurrenceId) => { update({ node: nodeId, occurrence: occurrenceId, nodePane: 'records', asset: undefined }); setNodeTab('records'); }} />}
          {selection.view === 'business' && scope && run && <NativeRunEvents key={run.id} api={api} scope={scope} run={run} onRun={chooseRun} />}
          {selection.tab === 'history' && selection.view === 'workflow' ? <section className="sw-history"><h3>版本演进</h3><p>前驱、原因、已有验证计划和运行按准确版本关联。</p><LoadMore source={versions} empty="尚无版本记录。" render={item => <VersionHistory key={item.id} api={api} spaceId={spaceId} cacheScope={scope!} item={item} versions={loadedVersions} summary={summary} onOpen={() => { const url = writeSelection(params, { ...selectVersion(selection, item.id), tab: 'definition' }); url.set('candidateReader', '0'); setParams(url); }} onPredecessor={id => { const url = writeSelection(params, { ...selectVersion(selection, id), tab: 'definition' }); url.set('candidateReader', '0'); setParams(url); }} onPlan={id => update({ view: 'business', tab: 'process', plan: id, entry: undefined, case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined, comparison: undefined, evidence: '1', returnVersion: item.id })} onRun={() => update({ version: item.id, tab: 'process', case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined })} />} /></section> : (selection.view === 'business' || (selection.view === 'workflow' && selection.tab !== 'design' && !candidateMode)) && <>{selection.view === 'workflow' && selection.tab === 'process' && <><button className="sw-case-directory-toggle" onClick={() => setCaseDirectoryOpen(!caseDirectoryOpen)}>{caseDirectoryOpen ? '收起此方法案例' : '查看此方法全部案例'}</button>{caseDirectoryOpen && <section className="sw-version-cases"><strong>此方法的案例</strong><LoadMore source={versionCases} empty="此版本尚无运行案例。可查看方法定义，或进入全部案例。" render={item => <Row key={item.id} title={item.title} sub={`${item.runCount} 次运行`} onClick={() => update({ case: item.id, run: undefined, node: undefined, occurrence: undefined })} />} /></section>}</>}{selection.view === 'workflow' && selection.tab === 'basis' && !version && <QueryNotice error={versionQuery.error} retry={() => void versionQuery.refetch()} empty={versionId ? '正在读取准确版本设计…' : '请选择准确版本。'} />}{selection.view === 'workflow' && selection.tab === 'basis' && version && <VersionMotive version={version} summary={summary} onPredecessor={id => setParams(writeSelection(params, { ...selectVersion(selection, id), view: 'workflow', tab: 'basis' }))} />}{selection.view === 'workflow' && selection.tab === 'basis' && version && scope && <MethodDesignBasis api={api} scope={scope} versionId={version.id} onGoalRevision={id => update({ view: 'goal', understandingRevision: id })} onDesignRevision={id => update({ view: 'workflow', tab: 'design', methodDesignRevision: id })} onMethod={() => { const url = writeSelection(params, { ...selection, view: 'workflow', tab: 'definition', node: undefined, expectedAsset: undefined, asset: undefined }); url.set('candidateReader', '0'); setParams(url); }} />}{selection.tab !== 'basis' && <><div className="sw-canvas-head"><div><small>{selection.tab === 'process' ? run ? `运行过程 · ${runScopeLabel(run)}` : '运行过程' : '方法定义'}</small><h3>{selection.tab === 'process' ? label(run?.label, '选择运行') : label(version?.label, '选择方法')}</h3><p>{selection.tab === 'process' ? run ? runStatusSummary(run) : '选择案例和运行，查看准确过程与产物。' : version?.purpose || '此版本未保存独立的设计用途。选择节点查看职责和输入输出。'}</p></div><span>{selection.tab === 'process' ? '节点 · 状态 · 轮次' : '节点 · 方法关系'}</span></div>{selection.tab === 'process' && run && <RunScopeBanner run={run} />}{graphState === 'ready' ? <Graph url={graphUrl} title={graphTitle} allowedIds={allowedIds} selectedNode={selection.tab === 'definition' ? selection.expectedAsset || selection.node : selection.asset ? (allowedIds.has(selection.asset) ? selection.asset : undefined) : selection.node} onSelect={chooseGraphEntity} graphState={selection.tab === 'process' ? process?.graphState : null} identity={graphIdentity} /> : <div className="sw-graph"><QueryNotice error={graphState === 'error' ? graphError : undefined} retry={graphState === 'error' ? retryGraph : undefined} empty={graphState === 'choose-run' ? '请选择一次准确运行以查看过程图。' : graphState === 'choose-version' ? '请选择方法版本。' : graphState === 'missing-definition' ? '准确版本缺少方法定义，无法显示方法图。仍可阅读此版本的动机与历史记录。' : '正在读取完整流程图…'} /></div>}<div className="sw-graph-foot">{selection.tab === 'process' && process ? `${process.contractSource === 'retrospective' ? '回溯过程 · ' : ''}${process.coverage === 'partial' ? '部分覆盖 · ' : ''}${process.occurrences.length} 项实例` : '方法图展示声明的节点与预期资产；选择图中对象阅读合同。'}</div><details className="sw-node-list"><summary>节点列表 · 键盘可操作</summary>{nodes.length ? nodes.map(item => <Row key={item.id} title={item.label} sub={item.purpose || item.kind} selected={selection.node === item.id} onClick={() => chooseNode(item.id)} />) : <QueryNotice error={graphState === 'error' ? graphError : undefined} retry={graphState === 'error' ? retryGraph : undefined} empty={graphState === 'ready' ? '该版本没有保存节点定义或过程。' : graphState === 'choose-run' ? '选择运行后显示实例节点。' : graphState === 'choose-version' ? '选择版本后显示方法节点。' : '正在读取节点…'} />}</details>{selection.view === 'workflow' && selection.tab === 'definition' && <details className="sw-node-list sw-expected-list"><summary>预期资产 · 键盘可操作 ({expectedAssets.length})</summary><p>这里是方法声明的资产合同，不是实际生成的作品。</p>{expectedAssets.length ? expectedAssets.map(item => <Row key={item.id} title={item.label} sub={item.source.kind === 'run-input' ? '预期运行输入' : `预期输出 · ${knownNodeLabel(nodes, item.source.nodeId)}`} selected={selection.expectedAsset === item.id} onClick={() => chooseExpectedAsset(item.id)} />) : <p className="sw-muted">此版本未声明可显示的预期资产。</p>}{version?.expectedAssets?.gaps.length ? <p className="sw-muted">合同缺项：{version.expectedAssets.gaps.map(gap => gap.message).join('；')}</p> : null}</details>}</>}</>}
          {selection.view === 'business' && scope && run && summary.capabilities.reviewRead && summary.capabilities.dispositionRead && <CaseSecondary title="评价与处置" summary="阅读保存的评价、观察依据与可选判断" openForLink={params.get('assessmentRun') === run.id}>{selection.view === 'business' && scope && run && summary.capabilities.reviewRead && summary.capabilities.dispositionRead && <RunAssessment key={`${scope}:${run.id}`} api={api} scope={scope} runId={run.id} principal={summary.subject.id} externalAgent={summary.subject.externalAgent} observationWritable={summary.capabilities.observationWrite === true} csrfToken={summary.csrfToken} reviewWritable={summary.capabilities.reviewWrite === true} dispositionWritable={summary.capabilities.dispositionWrite === true} onAsset={chooseAsset} onDiagnose={summary.capabilities.diagnosisRead ? (reviewId, dispositionId) => { if (reviewId) diagnosisLink('diagnosisReview', reviewId); if (dispositionId) diagnosisLink('diagnosisDisposition', dispositionId); } : undefined} />} </CaseSecondary>}
          {selection.view === 'business' && scope && run && summary.capabilities.diagnosisRead && <CaseSecondary title="原因诊断" summary="阅读保存的诊断与候选线索；按需继续" openForLink={params.get('diagnosisRun') === run.id}>{selection.view === 'business' && scope && run && summary.capabilities.diagnosisRead && <RunDiagnosis key={`${scope}:${run.id}:diagnosis`} api={api} scope={scope} runId={run.id} versionId={run.versionId} versionAvailability={version?.id === run.versionId ? availabilityLabel(version) : '未知（准确版本尚未读到）'} principal={summary.subject.id} externalAgent={summary.subject.externalAgent} csrfToken={summary.csrfToken} writable={summary.capabilities.diagnosisWrite === true} onAsset={openDiagnosisAsset} onResponse={target => assessmentLink('assessmentSubject', `response:${target.eventId}`)} onReview={id => assessmentLink('assessmentReview', id)} onDisposition={id => assessmentLink('assessmentDisposition', id)} onRunStep={stepId => { const occurrence = process?.occurrences.find(item => !stepId || item.technicalSteps.some(step => step.id === stepId)); if (occurrence?.nodeId) { update({ node: occurrence.nodeId, occurrence: occurrence.id, nodePane: 'records', asset: undefined }); setNodeTab('records'); } else document.querySelector('.sw-graph')?.scrollIntoView({ block: 'start' }); }} onInputs={() => { document.querySelector<HTMLElement>('.sw-run-inputs')?.scrollIntoView({ block: 'start' }); }} />} </CaseSecondary>}
          {selection.view === 'business' && scope && <CaseSecondary title="业务委托与准备" summary="已有准备记录或按需准备新业务">{selection.view === 'business' && scope && <BusinessAction key={`${scope}:${api.root}`} api={api} scope={scope} caseId={caseId} selectedRunId={selection.run} versionId={versionId} versionLabel={version?.label} versionPurpose={versionPurposeFor(version, versionId)} versionPurposeError={!!versionQuery.error} versions={loadedVersions} adoptedVersionId={summary.adoptedVersionId} onVersionSelect={id => { const next = selectVersion(selection, id); if (mayLeaveDiagnosis(next)) setParams(writeSelection(params, next)); }} csrfToken={summary.csrfToken} writable={summary.capabilities.write} onPrepared={prepared => { void client.invalidateQueries({ queryKey: key('cases') }); update({ view: 'business', tab: 'process', case: prepared.caseId, version: prepared.versionId, run: undefined, node: undefined, asset: undefined, plan: undefined, entry: undefined }); }} onRun={chooseRun} onAsset={chooseAsset} />} </CaseSecondary>}
          {selection.view === 'business' && <CaseSecondary title="计划内运行" summary="按需阅读计划条目和验证范围" openForLink={!!selection.plan}>{selection.view === 'business' && <div className="sw-plan-shell">{selection.plan && <button className="sw-plan-return" onClick={() => update({ view: 'workflow', tab: 'history', version: selection.returnVersion || selection.version, returnVersion: undefined, plan: undefined, entry: undefined, evidence: undefined, comparison: undefined, case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined })}>返回版本历史</button>}<button className="sw-plan-toggle" onClick={() => setPlanOpen(!planOpen)} aria-expanded={planOpen}>{planOpen ? '收起计划内运行' : `展开计划内运行${selection.plan ? ' · 已选条目' : ''}`}</button>{planOpen && scope && <PlanAction api={api} spaceId={spaceId} cacheScope={scope} summary={summary} caseId={caseId} viewedRunId={selection.run} planId={selection.plan} entryId={selection.entry} onSelect={(plan, entry) => update({ plan, entry, run: undefined, node: undefined, occurrence: undefined, asset: undefined })} onEntryContext={entry => { if (selection.case !== entry.caseId || selection.version !== entry.versionId) update({ case: entry.caseId, version: entry.versionId, run: undefined, node: undefined, occurrence: undefined, asset: undefined }, true); }} onRun={(item, options) => { const next = selectRun(selection, item); if (!mayLeaveDiagnosis(next)) return; setParams(writeSelection(params, next)); if (options?.collapsePlan) setPlanOpen(false); }} onAsset={chooseAsset} onComparison={id => update({ comparison: id })} evidenceOpen={selection.evidence === '1'} onEvidenceToggle={open => update({ evidence: open ? '1' : undefined })} versionLabelFor={id => version?.id === id ? version.label : loadedVersions.find(item => item.id === id)?.label} />}</div>} </CaseSecondary>}
        </div>
        {!candidateMode && <aside className={`sw-inspector${selection.comparison ? ' comparison' : expanded ? ' expanded' : ''}${selection.comparison || selection.asset || selection.expectedAsset || selection.node ? '' : ' empty'}`} aria-label="详情">
          {selection.comparison || selection.asset || selection.expectedAsset || selection.node ? <>
            <div className="sw-inspector-head">
              <div>
                <small>{selection.comparison ? '配对阅读' : selection.asset ? '实际资产阅读' : selection.expectedAsset ? '预期资产合同' : selection.tab === 'process' ? '运行节点' : '方法节点'}</small>
                <h3>{selection.comparison ? '并看评价对象' : selection.asset ? reading.data?.title || '读取资产' : selection.expectedAsset ? expectedAsset?.label || '预期资产' : node?.label || selection.node}</h3>
                <p>{selection.comparison ? '基线与候选的准确被评资产' : selection.asset ? reading.data ? assetOriginLabel(reading.data.asset) : '正在读取实际资产' : selection.expectedAsset ? '方法中的声明；没有实际正文' : node?.purpose || '该版本未保存节点职责'}</p>
              </div>
              {selection.view === 'business' && selection.run && params.get('diagnosisRun') === selection.run && <button className="sw-diagnosis-return" onClick={returnToDiagnosis}>返回本次诊断</button>}
              {selection.node && !selection.asset && !selection.comparison && <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收窄阅读' : '扩大阅读'}</button>}
              <button aria-label={selection.comparison ? '关闭并排阅读并返回原位置' : selection.asset ? '返回阅读前位置' : '关闭详情'} title="关闭详情" onClick={() => { setParams(writeSelection(params, closeInspector(selection))); setExpanded(false); }}>×</button>
            </div>
            <div className="sw-inspector-scroll" ref={inspectorScrollRef}>
              {selection.comparison && scope ? <ComparisonInspector api={api} spaceId={spaceId} cacheScope={scope} planId={selection.plan} comparisonId={selection.comparison} chooseAsset={chooseAsset} goProducer={producer => { update({ view: 'business', tab: 'process', version: producer.versionId, case: producer.caseId, run: producer.runId, node: producer.nodeId || undefined, occurrence: producer.occurrenceId || undefined, asset: undefined, comparison: undefined }); setExpanded(false); }} />
                : selection.asset ? <>
                    <AssetInspector api={api} spaceId={spaceId} cacheScope={scope!} assetId={selection.asset} reading={reading} relations={relations} tab={assetTab} setTab={setAssetTab} expanded={expanded} setExpanded={setExpanded} compareId={compareId} setCompareId={setCompareId} compareReading={compareReading} sourceVersionLabel={loadedVersions.find(item => item.id === reading.data?.asset.versionId)?.label} chooseAsset={chooseAsset} goProducer={producer => { update({ view: 'business', tab: 'process', version: producer.versionId, case: producer.caseId, run: producer.runId, node: producer.nodeId || undefined, occurrence: producer.occurrenceId || undefined, asset: undefined }); setExpanded(false); }} />
                    {reading.data?.asset && <HandlingNotes key={`${scope}:${api.root}:${reading.data.asset.id}`} api={api} scope={scope!} asset={reading.data.asset} referencedAssets={relations.data?.assessments || []} csrfToken={summary.csrfToken} writable={summary.capabilities.write} chooseAsset={chooseAsset} />}
                  </>
                : selection.expectedAsset ? <ExpectedAssetInspector asset={expectedAsset} onNode={chooseNode} nodeLabel={id => knownNodeLabel(nodes, id)} />
                : <>
                    <Tabs items={selection.tab === 'process' ? [['overview', '状态与产物'], ['inputs', '实际输入与上下文'], ['instructions', '指令与工具'], ['records', '执行记录']] : [['overview', '职责与合同'], ['config', '保存的配置']]} value={nodeTab} onChange={value => { setNodeTab(value); update({ nodePane: value }); }} />
                    {selection.tab === 'process' ? <ProcessNode api={api} scope={scope!} runId={selection.run!} node={node} occurrences={occurrences} selected={selectedOccurrence} detail={occurrenceQuery} tab={nodeTab} chooseOccurrence={id => { setRuntimeCorrection(undefined); update({ occurrence: id, runtimeAttempt: undefined }); }} selectedAttempt={selection.runtimeAttempt} chooseAttempt={id => { setRuntimeCorrection(undefined); update({ runtimeAttempt: id }); }} chooseAsset={chooseAsset} onRecords={() => { setNodeTab('records'); update({ nodePane: 'records', occurrence: selectedOccurrence?.id }); }} runtimeCorrection={runtimeCorrection && runtimeCorrection.occurrenceId === selectedOccurrence?.id ? runtimeCorrection.message : undefined} /> : <DefinitionNode node={node} tab={nodeTab} detail={nodeDetail} />}
                  </>}
            </div>
          </> : <div className="sw-empty-inspector"><strong>选择节点或预期资产</strong><p>在方法图上阅读职责与预期交付；实际作品从运行或资产入口阅读。</p></div>}
        </aside>}
      </main>
    </div>
    {summaryQuery.error && <div className="sw-identity-blocker"><QueryNotice error={summaryQuery.error} retry={() => void summaryQuery.refetch()} /></div>}
  </div>;
}

function VersionHistory({ api, spaceId, cacheScope, item, versions, summary, onOpen, onPredecessor, onPlan, onRun }: { api: SpaceApi; spaceId: string; cacheScope: string; item: VersionSummaryDto; versions: VersionSummaryDto[]; summary: SpaceSummaryDto; onOpen: () => void; onPredecessor: (id: string) => void; onPlan: (id: string) => void; onRun: () => void }) {
  const [iterationsOpen, setIterationsOpen] = useState(false);
  const iterations = usePaged(['space', cacheScope, spaceId, 'version-iterations', item.id], (cursor, signal) => api.versionIterations(item.id, cursor, signal), iterationsOpen);
  const detail = useQuery({ queryKey: ['space', cacheScope, spaceId, 'version', item.id], queryFn: ({ signal }) => api.version(item.id, signal) });
  const predecessor = versions.find(version => version.id === item.predecessorId);
  return <article className="sw-history-item"><h4>{item.revision} · {item.label}</h4><p><strong>产生动机：</strong>{item.changeReason || '变更理由未记录'}</p><dl><dt>设计用途</dt><dd>{detail.data ? label(detail.data.purpose, '未记录') : detail.error ? '定义读取失败' : '读取中'}</dd><dt>前驱</dt><dd>{item.predecessorId ? <button className="sw-link" onClick={() => onPredecessor(item.predecessorId!)}>{predecessor?.label || item.predecessorId}</button> : '未记录前驱；可能是首版'}</dd><dt>采用</dt><dd>{detail.data ? adoptionLabel(detail.data as MethodVersion, summary) : detail.error ? '采用状态读取失败' : '读取中'}</dd><dt>执行条件</dt><dd>{availabilityLabel(item)}</dd><dt>方法定义</dt><dd>{item.definitionAvailability === 'recorded' ? '已保存' : '缺失'}</dd><dt>实际使用</dt><dd>{item.runCount} 次运行 · {item.caseCount} 个案例</dd></dl><div className="sw-actions"><button onClick={onOpen}>查看方法</button><button onClick={onRun}>查看运行</button><button onClick={() => setIterationsOpen(!iterationsOpen)}>{iterationsOpen ? '收起迭代记录' : '阅读迭代记录'}</button>{item.planIds.map(id => <button key={id} onClick={() => onPlan(id)}>查看验证证据</button>)}</div>{iterationsOpen && <section className="sw-iterations"><strong>保存的迭代记录 · 不代表已采用</strong><LoadMore source={iterations} empty="此版本没有保存迭代记录。" render={iteration => <article key={iteration.id}><p>{iteration.hypothesis}</p><small>{iteration.caseIds.length} 个案例 · {iteration.runIds.length} 次运行 · {iteration.reviewIds.length} 份评价</small><details><summary>准确关联</summary><p>迭代 {iteration.id} · 方法 {iteration.workflowVersionId}</p><p>Cases：{iteration.caseIds.join('、') || '未记录'}</p><p>Runs：{iteration.runIds.join('、') || '未记录'}</p><p>评价：{iteration.reviewIds.join('、') || '未记录'}</p></details></article>} /></section>}</article>;
}

function savedJson(value: unknown): string { return JSON.stringify(value, null, 2) || '未记录'; }
export function durationLabel(milliseconds: number | null): string { return milliseconds === null ? '未记录' : milliseconds >= 60_000 ? `${Number((milliseconds / 60_000).toFixed(2))} 分钟（${milliseconds} 毫秒）` : `${milliseconds} 毫秒`; }

export function FrozenAgentDeclaration({ detail }: { detail: NodeDetailDto }) {
  const agent = detail.agentDeclaration;
  const configuredReasoning = typeof detail.configuration?.reasoningEffort === 'string' ? detail.configuration.reasoningEffort : null;
  if (!agent) return <p className="sw-muted">此准确版本没有保存可单独阅读的 Agent 参数声明。下方原始配置仅用于核对已保存字段。</p>;
  return <>
    <h4>模型与运行上限 · 本版声明</h4>
    <dl><dt>模型</dt><dd>{label(detail.model)}</dd><dt>Agent 声明中的推理等级</dt><dd>{label(agent.reasoningEffort)}</dd><dt>保存配置中的推理等级</dt><dd>{label(configuredReasoning)}</dd><dt>超时</dt><dd>{durationLabel(agent.timeoutMs)}</dd><dt>轮数上限</dt><dd>{agent.maxTurns ?? '未记录'}</dd><dt>工具调用上限</dt><dd>{agent.maxToolCalls ?? '未记录'}</dd><dt>输出格式</dt><dd>{label(agent.outputFormat)}</dd></dl>
    <h4>冻结 Prompt</h4><details><summary>{detail.instructions ? '阅读本版保存的完整指令' : '本版未保存完整指令'}</summary><pre>{detail.instructions || '本版未保存完整指令；不能由运行时指令反推此处。'}</pre></details>
    <h4>Skill 来源</h4>{agent.skills === null ? <p className="sw-muted">本版未保存独立 Skill 声明或来源。</p> : agent.skills.length ? agent.skills.map(skill => <article className="sw-frozen-tool" key={`${skill.name}:${skill.sourceRef}`}><strong>{skill.name}</strong><p>来源：{skill.sourceRef}</p><small>修订：{skill.revision || '未记录'}</small></article>) : <p className="sw-muted">本版没有声明 Skill。</p>}
    <h4>静态冻结工具声明</h4><p className="sw-muted">静态名单不是完整执行工具集。阶段动态工具的名称与条件可核对上方冻结 Prompt 和执行器阶段合同；其参数 Schema 未保存在此声明中。实际提供或调用了什么，须查看对应运行记录。</p>{agent.tools === null ? <p className="sw-muted">本版没有保存工具声明；不能从当前部署或运行事件补成冻结定义。</p> : agent.tools.length ? agent.tools.map(tool => <article className="sw-frozen-tool" key={tool.name}><strong>{tool.name}</strong>{tool.coverage === 'name-only' ? <p className="sw-muted">本版只保存工具名称，描述、输入和输出定义均未冻结。</p> : <><p>{tool.description || '描述未记录'}</p><p>必填输入：{tool.required === null ? '未记录' : tool.required.length ? tool.required.join('、') : '声明无必填字段'}</p>{toolFieldSummaries(tool.parameters).map(field => <p className="sw-tool-field" key={field.name}><strong>{field.name}</strong> · {field.type} · {field.required ? '必需' : '可选'}{field.choices.length ? ` · 可选值 ${field.choices.join('、')}${field.moreChoices ? '…' : ''}` : ''}</p>)}<details><summary>原始输入参数 Schema</summary><pre>{tool.parameters === null ? '未记录' : savedJson(tool.parameters)}</pre></details><details><summary>输出合同</summary><pre>{tool.outputSchema === null ? '本版未记录工具输出合同' : savedJson(tool.outputSchema)}</pre></details></>}</article>) : <p className="sw-muted">本版没有声明工具。</p>}
    <h4>输出约束</h4>{agent.outputSchema === null ? <p className="sw-muted">本版未保存 Agent 输出 Schema；可继续核对节点输出槽位合同。</p> : <details><summary>本版保存的 Agent 输出 Schema</summary><pre>{savedJson(agent.outputSchema)}</pre></details>}
    <h4>权限与影响范围 · 本版声明</h4>{agent.permissions ? <><dl><dt>权限修订</dt><dd>{label(agent.permissions.revision)}</dd><dt>沙箱模式</dt><dd>{label(agent.permissions.sandboxMode)}</dd><dt>审批策略</dt><dd>{label(agent.permissions.approvalPolicy)}</dd><dt>联网模式</dt><dd>{label(agent.permissions.webSearchMode)}</dd><dt>条件联网</dt><dd>{label(agent.permissions.conditionalWebSearchMode)}</dd><dt>条件权限修订</dt><dd>{label(agent.permissions.conditionalPermissionsRevision)}</dd><dt>额外目录数</dt><dd>{agent.permissions.additionalDirectoryCount ?? '未记录'}</dd></dl><p className="sw-muted">这些是版本保存的权限声明；实际一次运行是否获得相应能力，须核对该次运行记录。</p></> : <p className="sw-muted">本版未保存独立权限声明；不能推断实际允许的操作。</p>}
  </>;
}

export function DefinitionNode({ node, tab, detail }: { node?: NodeSummaryDto; tab: string; detail: { data?: NodeDetailDto; error: unknown; refetch: () => unknown } }) {
  if (!node) return <QueryNotice empty="此节点在准确版本中没有保存定义。" />;
  if (tab === 'overview') return <div className="sw-detail"><h4>节点职责</h4><p>{node.purpose || '未记录'}</p><SlotList title="声明的输入" slots={node.inputs} /><SlotList title="声明的输出" slots={node.outputs} direction="output" /></div>;
  return <div className="sw-detail sw-node-configuration"><p><strong>{node.kind === 'agent' ? 'Agent 节点' : `${node.kind} 节点`}</strong> · {node.definitionRecorded ? '此准确版本保存了节点定义' : '此准确版本缺少节点定义'}</p><dl><dt>执行器</dt><dd>{node.executor ? `${node.executor.family}${node.executor.adapter ? ` · ${node.executor.adapter}` : ''}` : '未记录'}</dd>{node.kind === 'agent' && <><dt>模型</dt><dd>{label(node.model)}</dd><dt>冻结工具</dt><dd>{node.tools?.length ? node.tools.join('、') : '未记录'}</dd></>}</dl>{node.kind !== 'agent' && <p className="sw-muted">此节点不是 Agent；按保存的职责、输入输出与程序配置阅读，不套用模型、Prompt 或工具声明。</p>}
    {detail.data ? <>{detail.data.agentDeclarationCoverage === 'truncated' && <p role="status">此详情的安全阅读投影部分截断；原始冻结记录未据此推断完整性。</p>}{detail.data.agentDeclarationCoverage === 'full' && <p className="sw-muted">冻结声明投影完整读取（未截断）；这不表示已保存执行时的全部工具。</p>}{node.kind === 'agent' ? <FrozenAgentDeclaration detail={detail.data} /> : <><h4>节点类型与职责</h4><p>{node.purpose || '职责未记录'}</p>{detail.data.instructions && <details><summary>本版保存的程序说明</summary><pre>{detail.data.instructions}</pre></details>}</>}<details><summary>原始保存配置 · 安全投影</summary><pre>{detail.data.configuration ? savedJson(detail.data.configuration) : '未记录'}</pre></details></> : <QueryNotice error={detail.error} retry={() => void detail.refetch()} />}
  </div>;
}

function stepKindLabel(kind: string): string {
  if (kind === 'agent') return 'Agent 尝试';
  if (kind === 'task' || kind === 'program' || kind === 'publish') return `程序步骤（${kind}）`;
  if (kind === 'parallel') return '并行步骤';
  if (kind === 'validate' || kind === 'validation') return '校验步骤';
  return `技术步骤（${kind}）`;
}

function RunSessionTrace({ api, scope, runId, sessionIds }: { api: SpaceApi; scope: string; runId: string; sessionIds: string[] }) {
  const [sessionId, setSessionId] = useState(sessionIds[0] || '');
  const events = useInfiniteQuery({ queryKey: ['space', scope, api.root, 'run-session-events', runId, sessionId], queryFn: ({ pageParam, signal }) => api.runSessionEvents(runId, sessionId, pageParam, signal), initialPageParam: 0, getNextPageParam: page => page.hasMore ? page.nextCursor : undefined, enabled: !!sessionId, retry: false });
  if (!sessionIds.length) return <p className="sw-muted">此轮没有保存会话事件引用。</p>;
  return <section className="sw-run-trace-events"><h4>本轮会话事件</h4><p>以下为此运行已保存的会话事件；不代表完整模型思考，也不包含外层方法设计会话。</p><label>会话 <select value={sessionId} onChange={event => setSessionId(event.target.value)}>{sessionIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>{events.error && <QueryNotice error={events.error} retry={() => void events.refetch()} />}{events.isPending && <p className="sw-muted">正在读取保存的事件…</p>}{events.data?.pages.flatMap(page => page.items).map(event => <details key={`${event.seq}:${event.id}`}><summary>{event.seq} · {event.kind} · {new Date(event.createdAt).toLocaleString()}</summary><p>尝试 {event.attemptId}</p><pre>{typeof event.body === 'string' ? event.body : JSON.stringify(event.body, null, 2) || '正文未记录'}</pre></details>)}{events.data && !events.data.pages.some(page => page.items.length) && !events.error && <p className="sw-muted">此会话没有可读的保存事件。</p>}{events.hasNextPage && <button className="sw-more" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>{events.isFetchingNextPage ? '正在读取…' : '加载更多事件'}</button>}</section>;
}

export function terminalFailureLabel(error: string, stepKey: string): string {
  return /citation|引用/i.test(`${error} ${stepKey}`) ? '引用校验失败' : '发布或校验失败';
}

function UnpublishedResponses({ api, scope, runId, occurrenceId }: { api: SpaceApi; scope: string; runId: string; occurrenceId: string }) {
  const result = useQuery({ queryKey: ['space', scope, api.root, 'unpublished-responses', runId, occurrenceId], queryFn: ({ signal }) => api.unpublishedResponses(runId, occurrenceId, signal), retry: false });
  return <section className="sw-unpublished-response"><h4>未发布响应</h4><p>这是此运行作者步骤保存的响应，尚未形成已发布稿件；它不是成功稿件资产。</p>{result.isPending && <p className="sw-muted">正在读取保存的响应…</p>}{result.error && <QueryNotice error={result.error} retry={() => void result.refetch()} />}{result.data && !result.data.responses.length && <p className="sw-muted">此轮没有可恢复的未发布响应。</p>}{result.data?.responses.map(item => <article key={`${item.stepRunId}:${item.eventId}`}><p><strong>{item.coverage === 'full' ? '完整保存响应' : '保存响应已截断'}</strong> · Agent 尝试 {item.attemptId}</p><h5>{item.reading.title}</h5>{item.reading.sections.map((section, index) => <section className="sw-reading-section" key={`${section.title}-${index}`}><h5>{section.title}</h5><p>{safeInlineLinks(section.text)}</p>{section.pointer && <small>{section.pointer}</small>}{section.sourceRefs?.length ? <small>来源：{section.sourceRefs.join('、')}</small> : null}</section>)}{!item.reading.sections.length && <p className="sw-muted">没有可单独呈现的正文段落，请阅读下方原始保存响应。</p>}{(item.reading.readerStatus === 'fallback' || item.coverage === 'truncated') && <p className="sw-unpublished-reading-limit">{item.reading.reason || (item.coverage === 'truncated' ? '保存响应已截断，以下只展示可恢复的内容。' : '当前没有注册适用的正文阅读方式。')}</p>}<details><summary>原始保存响应{item.coverage === 'truncated' ? '（已截断）' : ''}</summary><pre>{item.output}</pre></details><details><summary>准确事件来源</summary><code>步骤 {item.stepRunId} · 会话 {item.sessionId} · 事件 {item.eventId} / {item.eventSeq}</code></details></article>)}</section>;
}

function NonAgentRuntime({ node, contexts }: { node: NodeSummaryDto; contexts: OccurrenceDetailDto['contexts'] }) {
  return <section><p className="sw-muted">{node.kind} 节点按保存的实际上下文阅读；不套用 Agent 模型请求或工具调用说明。</p>{contexts.length ? contexts.map(context => <article className="sw-runtime-context" key={context.id}><strong>保存的执行上下文</strong><details><summary>执行说明</summary><pre>{context.instructions || '未记录'}</pre></details><details><summary>实际有效配置 · 安全投影</summary><pre>{savedJson(context.effectiveConfig)}</pre></details><details><summary>准确上下文身份</summary><code>步骤 {context.stepRunId} · 尝试 {context.attemptId} · 会话 {context.sessionId} · 上下文 {context.id}</code></details></article>) : <p className="sw-muted">没有保存可读执行上下文；不能推断此节点从未执行。</p>}</section>;
}

export function ProgramContextRecords({ contexts }: { contexts: OccurrenceDetailDto['contexts'] }) {
  const programs = contexts.filter(context => context.producer === 'program');
  return programs.length ? <section><h4>程序执行上下文</h4><p className="sw-muted">这些是保存的程序步骤，不是 Agent 模型尝试。</p>{programs.map(context => <article className="sw-runtime-context" key={context.id}><strong>程序步骤 {context.stepRunId}</strong><details><summary>程序执行说明</summary><pre>{context.instructions || '未记录'}</pre></details><details><summary>实际有效配置 · 安全投影</summary><pre>{savedJson(context.effectiveConfig)}</pre></details><details><summary>准确程序上下文身份</summary><code>尝试 {context.attemptId} · 会话 {context.sessionId} · 上下文 {context.id}</code></details></article>)}</section> : null;
}

function ProcessNode({ api, scope, runId, node, occurrences, selected, detail, tab, chooseOccurrence, selectedAttempt, chooseAttempt, chooseAsset, onRecords, runtimeCorrection }: { api: SpaceApi; scope: string; runId: string; node?: NodeSummaryDto; occurrences: OccurrenceDto[]; selected?: OccurrenceDto; detail: { data?: OccurrenceDetailDto; error: unknown; refetch: () => unknown }; tab: string; chooseOccurrence: (id: string) => void; selectedAttempt?: string; chooseAttempt: (id: string) => void; chooseAsset: (id: string) => void; onRecords: () => void; runtimeCorrection?: string }) {
  if (!node) return <QueryNotice empty="本次过程没有保存此节点。" />;
  return <div className="sw-detail">
    {occurrences.length > 1 && <label>轮次 <select aria-label="选择轮次" value={selected?.id || ''} onChange={event => chooseOccurrence(event.target.value)}>{occurrences.map(item => <option key={item.id} value={item.id}>{item.label}{item.branch ? ` · 分支 ${item.branch}` : ''} · {stateLabel(item.state)}</option>)}</select></label>}
    {!selected ? <p className="sw-muted">此节点没有实际执行记录。</p> : tab === 'overview' ? <>
      <p className="sw-status">{selected.label}{selected.branch ? ` · 分支 ${selected.branch}` : ''} · {stateLabel(selected.state)}</p>
      <p>Agent 尝试：{selected.agentAttemptCount ?? '未记录'} · 技术步骤：{selected.technicalStepCount}</p>
      {selected.terminalFailure && <section className="sw-process-terminal-failure"><strong>派生失败终态 · {terminalFailureLabel(selected.terminalFailure.error, selected.terminalFailure.failedAncestorStepKey)}</strong><p>{selected.terminalFailure.error}</p><small>依据保存的失败步骤 {selected.terminalFailure.failedAncestorStepKey}；原始技术步骤状态仍可在“记录”中核对。</small></section>}
      {selected.failureDetails.length > 0 && <><h4>保存的失败原因</h4>{selected.failureDetails.map(step => <div className="sw-process-failure" key={step.id}><strong>{stepKindLabel(step.kind)} · {step.key}</strong><p>{step.error || '原因未记录'}</p></div>)}</>}
      {selected.state === 'failed' && selected.failureDetails.length === 0 && !selected.terminalFailure && <p className="sw-muted">此轮失败，但没有保存具体失败原因。</p>}
      <h4>{selected.terminalFailure ? '本轮已发布产物' : '本轮产物'}</h4><AssetLinks assets={selected.outputs} choose={chooseAsset} empty={selected.terminalFailure ? '此轮没有发布成功的业务产物。' : '本轮没有保存业务产物。'} />
      {selected.state === 'failed' && <FailedResponseEntry api={api} scope={scope} runId={runId} occurrence={selected} onOpen={onRecords} />}
    </> : tab === 'inputs' ? <><h4>本轮实际输入</h4><AssetLinks assets={selected.inputs} choose={chooseAsset} empty="本轮没有保存可读的输入资产；不代表执行时没有其他上下文。" /><h4>输入合同</h4><SlotList title="声明的输入槽位" slots={node.inputs} /><h4>保存的执行上下文</h4>{detail.data ? detail.data.contexts.length ? detail.data.contexts.map(context => <article className="sw-runtime-context" key={context.id}><strong>{context.producer === 'agent' ? `Agent · ${label(context.model)} · ${label(context.reasoningEffort)}` : '程序步骤 · 非模型尝试'}</strong><p>实际会话 {context.sessionId}</p><details><summary>准确上下文身份</summary><code>步骤 {context.stepRunId} · 尝试 {context.attemptId} · 上下文 {context.id}</code></details></article>) : <p className="sw-muted">此轮未保存可读的执行上下文；不能推断所有输入都为空。</p> : <QueryNotice error={detail.error} retry={() => void detail.refetch()} />}</> : tab === 'instructions' ? <><h4>{node.kind === 'agent' ? '实际指令与工具' : '实际执行说明与配置'}</h4>{node.kind === 'agent' && <p className="sw-muted">这里展示本轮保存的执行上下文；准确版本的冻结 Prompt 与工具声明请返回方法节点“保存的配置”阅读。运行时供应商指令和动态工具只按真实事件单列。</p>}{runtimeCorrection && <p role="status">{runtimeCorrection}</p>}{detail.data ? node.kind === 'agent' ? <NodeRuntime key={selected.id} api={api} scope={scope} runId={runId} occurrenceId={selected.id} contexts={detail.data.contexts} selectedAttempt={selectedAttempt} onSelectAttempt={chooseAttempt} /> : <NonAgentRuntime node={node} contexts={detail.data.contexts} /> : <QueryNotice error={detail.error} retry={() => void detail.refetch()} />}</> : <>
      <dl><dt>状态</dt><dd>{stateLabel(selected.state)}</dd><dt>Agent 尝试</dt><dd>{selected.agentAttemptCount ?? '未记录'}</dd><dt>技术步骤</dt><dd>{selected.technicalStepCount}</dd><dt>会话数</dt><dd>{selected.sessionIds.length}</dd><dt>记录来源</dt><dd>{selected.provenance === 'observed' ? '直接观测' : selected.provenance === 'derived' ? '从保存记录推导' : '未记录'}</dd>{selected.terminalFailure && <><dt>终态推导</dt><dd>{terminalFailureLabel(selected.terminalFailure.error, selected.terminalFailure.failedAncestorStepKey)} · {selected.terminalFailure.error}</dd><dt>失败前驱</dt><dd>{selected.terminalFailure.failedAncestorStepKey} · {selected.terminalFailure.failedAncestorStepId}</dd></>}</dl>
      {selected.terminalFailure && <UnpublishedResponses api={api} scope={scope} runId={runId} occurrenceId={selected.id} />}
      <h4>保存的原始执行步骤</h4>{selected.technicalSteps.length ? selected.technicalSteps.map(step => <p key={step.id}>{stepKindLabel(step.kind)} · {step.key} · {stateLabel(step.state)}{step.error ? ` · ${step.error}` : ''}</p>) : <p className="sw-muted">没有保存执行步骤。</p>}
      {node.kind === 'agent' && detail.data && <ProgramContextRecords contexts={detail.data.contexts} />}
      <details className="sw-process-trace"><summary>会话与上下文引用 · {selected.sessionIds.length} 个会话</summary><p>这里列出已保存的执行关联；下方可阅读此运行的会话事件。</p><h4>会话</h4>{selected.sessionIds.length ? selected.sessionIds.map(id => <code key={id}>{id}</code>) : <p className="sw-muted">没有保存会话引用。</p>}<h4>上下文</h4>{selected.contextIds.length ? selected.contextIds.map(id => <code key={id}>{id}</code>) : <p className="sw-muted">没有保存上下文引用。</p>}</details>

      <RunSessionTrace key={selected.id} api={api} scope={scope} runId={runId} sessionIds={selected.sessionIds} />
    </>}
  </div>;
}

function ReviewCard({ api, spaceId, cacheScope, review, chooseAsset }: { api: SpaceApi; spaceId: string; cacheScope: string; review: ReviewDto; chooseAsset: (id: string) => void }) {
  const [baselineOpen, setBaselineOpen] = useState(false);
  const baseline = useQuery({ queryKey: ['space', cacheScope, spaceId, 'review-reading', review.baselineReviewId], queryFn: ({ signal }) => api.reviewReading(review.baselineReviewId!, signal), enabled: baselineOpen && !!review.baselineReviewId });
  return <article className="sw-review">
    <strong>{reviewJudgeLabel(review)}</strong>
    <p>标准：{reviewStandardLabel(review)}</p>
    <p>被评资产：{review.assetIds.length} 项 · {reviewBaselineLabel(review)}</p>
    {review.baselineReviewId && <button className="sw-link" onClick={() => setBaselineOpen(!baselineOpen)}>{baselineOpen ? '收起关联基线' : '阅读关联基线'}</button>}
    {baselineOpen && (baseline.data ? <div className="sw-review-baseline"><p>基线评价：{baseline.data.review.judge.kind === 'agent' ? '独立 Agent' : baseline.data.review.judge.kind === 'human' ? '人工' : baseline.data.review.judge.kind} · {baseline.data.review.judge.id} · {baseline.data.review.standard.id} / {baseline.data.review.standard.revision}</p>{baseline.data.assets.length ? baseline.data.assets.map(asset => <Row key={asset.id} title={asset.title} sub={assetOriginLabel(asset)} onClick={() => chooseAsset(asset.id)} />) : <p className="sw-muted">关联基线评价没有可读的被评资产。</p>}</div> : <QueryNotice error={baseline.error} retry={() => void baseline.refetch()} />)}
    <details><summary>阅读四问与准确对象</summary><p>好：{review.answers.good}</p><p>不足：{review.answers.bad}</p><p>改进：{review.answers.improvement}</p><p>未解决：{review.answers.unresolved}</p><p>Run {review.runId} · 评价 {review.id}</p>{review.assetIds.map(id => <button className="sw-link" key={id} onClick={() => chooseAsset(id)}>阅读被评资产 {id.slice(0, 8)}</button>)}{review.baselineReviewId && <p>关联基线评价 ID：{review.baselineReviewId}</p>}</details>
  </article>;
}

function ReviewCards({ api, spaceId, cacheScope, reviews, chooseAsset }: { api: SpaceApi; spaceId: string; cacheScope: string; reviews: ReviewDto[]; chooseAsset: (id: string) => void }) {
  if (!reviews.length) return <p className="sw-muted">没有保存此准确资产的独立四问评价。</p>;
  return <>{reviews.map(review => <ReviewCard key={review.id} api={api} spaceId={spaceId} cacheScope={cacheScope} review={review} chooseAsset={chooseAsset} />)}</>;
}

type ComparisonSideDto = NonNullable<ComparisonReadingDto['baseline']>;

function ComparisonSide({ api, spaceId, cacheScope, side, view, chooseAsset, goProducer }: { api: SpaceApi; spaceId: string; cacheScope: string; side: ComparisonSideDto; view: ReaderView | 'reviews' | 'relations'; chooseAsset: (id: string) => void; goProducer: (producer: { runId: string; versionId: string; caseId: string; nodeId: string | null; occurrenceId: string | null }) => void }) {
  const reading = useQuery({ queryKey: ['space', cacheScope, spaceId, 'reading', side.asset.id], queryFn: ({ signal }) => api.reading(side.asset.id, signal) });
  const relations = useQuery({ queryKey: ['space', cacheScope, spaceId, 'relations', side.asset.id], queryFn: ({ signal }) => api.relations(side.asset.id, undefined, signal), enabled: view === 'reviews' || view === 'relations' });
  return <section className="sw-comparison-side">
    <header><small>{side.side === 'baseline' ? '基线' : '候选'} · 第 {side.attempt} 次尝试</small><h3>{side.asset.title}</h3><p>{side.versionLabel} · {side.caseTitle} · {assetOriginLabel(side.asset)}</p><p>运行 {side.runId.slice(0, 8)}</p></header>
    <details><summary>准确对象与输入清单</summary><dl><dt>条目</dt><dd>{side.entryId}</dd><dt>方法版本</dt><dd>{side.versionId}</dd><dt>Case</dt><dd>{side.caseId}</dd><dt>Run</dt><dd>{side.runId}</dd><dt>资产</dt><dd>{side.asset.id}</dd><dt>Schema</dt><dd>{side.asset.schema.namespace} · {side.asset.schema.revision}</dd><dt>资产原始状态</dt><dd>{side.asset.state}</dd><dt>冻结清单</dt><dd>{side.inputManifestId}</dd><dt>清单 hash</dt><dd>{side.inputManifestHash}</dd></dl></details>
    {view === 'reviews' ? <><h4>本侧独立四问</h4><ReviewCards api={api} spaceId={spaceId} cacheScope={cacheScope} reviews={[side.review]} chooseAsset={chooseAsset} /><h4>本侧流程内意见</h4>{relations.data ? <AssetLinks assets={relations.data.assessments} choose={chooseAsset} empty="没有关联的流程内意见。" /> : <QueryNotice error={relations.error} retry={() => void relations.refetch()} />}</> : view === 'relations' ? <>{relations.data ? <><h4>生产来源</h4>{relations.data.producer ? <Row title={relations.data.producer.nodeLabel} sub="打开本侧生产运行与轮次" onClick={() => goProducer(relations.data!.producer!)} /> : <p className="sw-muted">生产来源未记录。</p>}<h4>上一稿</h4>{relations.data.previousDraft ? <Row title={relations.data.previousDraft.title} sub={assetOriginLabel(relations.data.previousDraft)} onClick={() => chooseAsset(relations.data!.previousDraft!.id)} /> : <p className="sw-muted">没有关联前稿。</p>}<h4>依赖资产</h4><AssetLinks assets={relations.data.dependencies} choose={chooseAsset} empty="没有记录依赖资产。" /></> : <QueryNotice error={relations.error} retry={() => void relations.refetch()} />}</> : reading.data ? <SavedReaderPane title={reading.data.title} roundLabel={side.asset.round == null ? '来源／轮次未记录' : `第 ${side.asset.round} 轮`} sections={reading.data.sections} view={view} evidence={{ id: side.asset.id, schema: side.asset.schema, readerStatus: reading.data.readerStatus, sourceLinks: reading.data.sourceLinks }} chooseAsset={chooseAsset} /> : <QueryNotice error={reading.error} retry={() => void reading.refetch()} />}
  </section>;
}

function ComparisonInspector({ api, spaceId, cacheScope, planId, comparisonId, chooseAsset, goProducer }: { api: SpaceApi; spaceId: string; cacheScope: string; planId?: string; comparisonId: string; chooseAsset: (id: string) => void; goProducer: (producer: { runId: string; versionId: string; caseId: string; nodeId: string | null; occurrenceId: string | null }) => void }) {
  const [view, setView] = useState<ReaderView | 'reviews' | 'relations'>('body');
  const comparison = useQuery({ queryKey: ['space', cacheScope, spaceId, 'comparison-reading', planId, comparisonId], queryFn: ({ signal }) => api.comparisonReading(planId!, comparisonId, signal), enabled: !!planId });
  if (!planId) return <QueryNotice empty="比较链接缺少准确计划 ID。" />;
  if (!comparison.data) return <QueryNotice error={comparison.error} retry={() => void comparison.refetch()} />;
  const paired = comparison.data;
  const subjects = exactComparisonSubjects(paired);
  if (!subjects) return <QueryNotice empty={paired.reason || '这份比较没有唯一可信且身份一致的两侧被评对象。'} />;
  return <div className="sw-comparison sw-detail"><p className="sw-comparison-conclusion"><strong>保存的配对结论</strong> · {paired.conclusion}</p><Tabs items={[["body", "正文"], ["visual", "画面"], ["reviews", "评价"], ["relations", "关系"], ["evidence", "证据"]]} value={view} onChange={value => setView(value as typeof view)} /><div className="sw-comparison-columns"><ComparisonSide api={api} spaceId={spaceId} cacheScope={cacheScope} side={subjects[0]!} view={view} chooseAsset={chooseAsset} goProducer={goProducer} /><ComparisonSide api={api} spaceId={spaceId} cacheScope={cacheScope} side={subjects[1]!} view={view} chooseAsset={chooseAsset} goProducer={goProducer} /></div></div>;
}

function AssetInspector({ api, spaceId, cacheScope, assetId, reading, relations, tab, setTab, expanded, setExpanded, compareId, setCompareId, compareReading, sourceVersionLabel, chooseAsset, goProducer }: { api: SpaceApi; spaceId: string; cacheScope: string; assetId: string; reading: { data?: { asset: AssetSummaryDto; title: string; sections: ReaderSection[]; readerStatus: string; sourceLinks: { ref: string; asset: AssetSummaryDto; pointer: string | null }[] }; error: unknown; refetch: () => unknown }; relations: { data?: { producer: { runId: string; versionId: string; caseId: string; nodeId: string | null; nodeLabel: string; occurrenceId: string | null } | null; dependencies: AssetSummaryDto[]; previousDraft: AssetSummaryDto | null; assessments: AssetSummaryDto[]; consumers: { runId: string; caseId: string; versionId: string; nodeId: string | null; nodeLabel: string; occurrenceId: string }[]; reviews: ReviewDto[] }; error: unknown; refetch: () => unknown }; tab: string; setTab: (value: string) => void; expanded: boolean; setExpanded: (value: boolean) => void; compareId?: string; setCompareId: (value: string | undefined) => void; compareReading: { data?: { title: string; asset: AssetSummaryDto; sections: ReaderSection[]; readerStatus: string; sourceLinks: { ref: string; asset: AssetSummaryDto; pointer: string | null }[] }; error: unknown; refetch: () => unknown }; sourceVersionLabel?: string; chooseAsset: (id: string) => void; goProducer: (producer: { runId: string; versionId: string; caseId: string; nodeId: string | null; occurrenceId: string | null }) => void }) {
  if (!reading.data) return <QueryNotice error={reading.error} retry={() => void reading.refetch()} />;
  const asset = reading.data.asset;
  const relation = relations.data;
  return <div className="sw-detail sw-reader"><div className="sw-actions"><button onClick={() => setExpanded(!expanded)}>{expanded ? '收窄阅读' : '扩大阅读'}</button>{relation?.producer && <button onClick={() => goProducer(relation.producer!)}>定位生产节点</button>}</div><p>{assetOriginLabel(asset)}{sourceVersionLabel ? ` · ${sourceVersionLabel}` : ''}</p><details className="sw-asset-trace"><summary>资产追溯</summary><dl><dt>资产 ID</dt><dd>{asset.id}</dd><dt>Schema</dt><dd>{asset.schema.namespace} · {asset.schema.revision}</dd><dt>资产原始状态</dt><dd>{asset.state}</dd><dt>种类</dt><dd>{asset.kind}</dd><dt>版本</dt><dd>{asset.versionId || '未记录'}</dd><dt>Run</dt><dd>{asset.runId || '未记录'}</dd></dl></details><AssetAttachments api={api} scope={cacheScope} assetVersionId={asset.id} /><Tabs items={[["body", "正文"], ["visual", "画面"], ["relations", "关系"], ["reviews", "评价"], ["evidence", "证据"]]} value={tab} onChange={setTab} />{(['body', 'visual', 'evidence'] as const).includes(tab as ReaderView) ? <><div className={compareId ? 'sw-compare' : ''}><SavedReaderPane title={compareId ? reading.data.title : undefined} roundLabel={compareId ? (asset.round == null ? '来源／轮次未记录' : `第 ${asset.round} 轮`) : undefined} sections={reading.data.sections} view={tab as ReaderView} evidence={{ id: asset.id, schema: asset.schema, readerStatus: reading.data.readerStatus, sourceLinks: reading.data.sourceLinks }} chooseAsset={chooseAsset} />{compareId && (compareReading.data ? <SavedReaderPane title={compareReading.data.title} roundLabel={compareReading.data.asset.round == null ? '来源／轮次未记录' : `第 ${compareReading.data.asset.round} 轮`} sections={compareReading.data.sections} view={tab as ReaderView} evidence={{ id: compareReading.data.asset.id, schema: compareReading.data.asset.schema, readerStatus: compareReading.data.readerStatus, sourceLinks: compareReading.data.sourceLinks }} chooseAsset={chooseAsset} /> : <QueryNotice error={compareReading.error} retry={() => void compareReading.refetch()} />)}</div>{compareId && <button onClick={() => setCompareId(undefined)}>关闭并排阅读</button>}</> : !relation ? <QueryNotice error={relations.error} retry={() => void relations.refetch()} /> : tab === 'relations' ? <><h4>生产来源</h4>{relation.producer ? <Row title={relation.producer.nodeLabel} sub="打开生产运行与轮次" onClick={() => goProducer(relation.producer!)} /> : <p className="sw-muted">无生产节点或来源未记录。</p>}<h4>上一稿</h4>{relation.previousDraft ? <Row title={relation.previousDraft.title} onClick={() => chooseAsset(relation.previousDraft!.id)} /> : <p className="sw-muted">没有关联前稿。</p>}<h4>准确评估资产</h4><AssetLinks assets={relation.assessments} choose={chooseAsset} empty="没有关联评估资产。" /><h4>依赖资产</h4><AssetLinks assets={relation.dependencies} choose={chooseAsset} empty="没有记录依赖资产。" /><h4>被使用的轮次</h4>{relation.consumers.length ? relation.consumers.map((consumer, index) => <Row key={`${consumer.runId}-${consumer.occurrenceId}-${index}`} title={consumer.nodeLabel} sub={`运行 ${consumer.runId}`} onClick={() => goProducer({ ...consumer, occurrenceId: consumer.occurrenceId })} />) : <p className="sw-muted">没有记录使用轮次。</p>}<h4>并排阅读</h4><select aria-label="选择对照资产" value={compareId || ''} onChange={event => { setCompareId(event.target.value || undefined); if (event.target.value) setTab('body'); }}><option value="">选择已有相关资产</option>{[...new Map([relation.previousDraft, ...relation.assessments, ...relation.dependencies].filter((item): item is AssetSummaryDto => !!item && item.id !== assetId).map(item => [item.id, item])).values()].map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></> : tab === 'reviews' ? <><h4>独立四问评价</h4><ReviewCards api={api} spaceId={spaceId} cacheScope={cacheScope} reviews={relation.reviews} chooseAsset={chooseAsset} /><h4>流程内意见</h4><AssetLinks assets={relation.assessments} choose={chooseAsset} empty="没有关联的流程内意见。" /></> : <p className="sw-muted">阅读视图未记录。</p>}</div>;
}

export function SpaceWorkbench(props: SpaceWorkbenchProps) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: true } } }));
  return <QueryClientProvider client={client}><BrowserRouter basename={props.basePath || undefined}><WorkbenchInner {...props} /></BrowserRouter></QueryClientProvider>;
}
