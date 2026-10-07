import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssetSummaryDto, CaseSummaryDto, ComparisonReadingDto, CursorList, NodeSummaryDto, OccurrenceDto, ReviewDto,
  RunDetailDto, RunSummaryDto, VersionSummaryDto, WorkflowGraphStateDto,
} from '@signal-room/workflow-space-api/contracts';
import { SpaceApi, SpaceApiError } from './api.js';
import { focusGraphNode, isGraphReady, postGraphState, selectedGraphNode, type GraphIdentity } from './bridge.js';
import { sectionsForView, type ReaderSection, type ReaderView } from './reader-sections.js';
import { PlanAction } from './plan-action.js';
import { BusinessAction } from './business-action.js';
import { HandlingNotes } from './handling-notes.js';
import { exactComparisonSubjects } from './comparison-reading.js';
import { isActiveRun, latestOccurrence, needsFinalProcessRefresh } from './process-state.js';
import { mergeCurrentRun, runStatusSummary, stateLabel } from './run-presentation.js';
import { reviewBaselineLabel, reviewJudgeLabel, reviewStandardLabel } from './review-presentation.js';
import { discardScopedSpaceData, identityChanged, isAuthDenial, mayDisplaySummary } from './identity-cache.js';
import { closeInspector, readSelection, selectNode, selectRun, selectVersion, writeSelection, type Selection } from './selection.js';

export interface SpaceWorkbenchProps { spaceId: string; apiBase?: string; basePath?: string }
const label = (value: string | null | undefined, fallback = '未记录') => value?.trim() || fallback;
function availabilityLabel(version: VersionSummaryDto | undefined): string {
  if (!version) return '执行状态读取中';
  const reason = version.availability.reason ? `：${version.availability.reason}` : '';
  if (version.availability.state === 'available') return `可执行${reason}`;
  if (version.availability.state === 'unavailable') return `当前不可执行${reason}`;
  return `可执行性未知${reason || '：宿主未记录部署状态'}`;
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

function CaseContext({ caseData, run, error, retry }: { caseData?: CaseSummaryDto; run?: RunDetailDto; error: unknown; retry: () => void }) {
  if (run) return <section className="sw-case-context has-run"><div className="sw-case-compact"><h3>{caseData?.title || run.caseTitle}</h3><p className="sw-runstate">{run.label} · {runStatusSummary(run)}</p></div><details><summary>阅读案例目标与运行追溯</summary>{caseData ? <><p>{caseData.objective}</p><small>约束：{caseData.constraints.length ? caseData.constraints.join(' · ') : '未记录'}</small></> : <QueryNotice error={error} retry={retry} empty="正在读取案例目标…" />}<dl className="sw-run-trace"><dt>Run</dt><dd>{run.id}</dd><dt>原始状态</dt><dd>{run.state}</dd><dt>任务状态</dt><dd>{run.taskState || '未记录'}</dd><dt>原始原因</dt><dd>{run.reason || '未记录'}</dd></dl></details></section>;
  return <section className="sw-case-context"><h3>{caseData?.title || '选择案例'}</h3>{caseData ? <><p className="sw-case-objective-preview">{caseData.objective}</p><details><summary>阅读完整目标与约束</summary><p>{caseData.objective}</p><small>约束：{caseData.constraints.length ? caseData.constraints.join(' · ') : '未记录'}</small></details></> : <QueryNotice error={error} retry={retry} empty="从案例列表选择真实业务。" />}</section>;
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
  return <div>{title && <h4>{title}</h4>}{roundLabel && <p className="sw-reader-round">{roundLabel}</p>}{shown.length ? shown.map((section, index) => <section className="sw-reading-section" key={`${section.title}-${index}`}><h4>{section.title}</h4><p>{section.text}</p>{section.pointer && <small>{section.pointer}</small>}{section.sourceRefs?.length ? <small>来源：{section.sourceRefs.join('、')}</small> : null}</section>) : <p className="sw-muted">{view === 'visual' ? '没有保存画面文字。' : view === 'evidence' ? '没有保存独立的依据段落。' : '没有保存可读正文。'}</p>}{view === 'evidence' && evidence && <><dl><dt>资产 ID</dt><dd>{evidence.id}</dd><dt>Schema</dt><dd>{evidence.schema.namespace} · {evidence.schema.revision}</dd><dt>读取方式</dt><dd>{evidence.readerStatus}</dd></dl><h4>正文来源引用</h4>{evidence.sourceLinks.length ? evidence.sourceLinks.map((link, index) => <Row key={`${link.ref}-${index}`} title={link.asset.title} sub={link.pointer || link.ref} onClick={() => chooseAsset(link.asset.id)} />) : <p className="sw-muted">没有记录正文来源引用。</p>}</>}</div>;
}

const sourceSelectionLabels: Record<string, string> = { 'frozen-input': '冻结输入', 'current-business-round': '当前业务轮', 'previous-business-round': '上一业务轮', 'latest-successful-in-this-run': '本次最近成功' };
function SlotList({ title, slots, direction = 'input' }: { title: string; slots: NodeSummaryDto['inputs']; direction?: 'input' | 'output' }) {
  return <section><h4>{title}</h4>{slots.length ? slots.map(slot => <div className="sw-contract" key={slot.slot}><strong>{slot.label || slot.slot}</strong><span>{slot.schema.namespace} · {slot.schema.revision}</span>{direction === 'input' ? <><small>{slot.optional === null ? '必需性未记录' : slot.optional ? '可选' : '必需'}{slot.states.length ? ` · ${slot.states.join(' / ')}` : ' · 状态未记录'}</small>{slot.sources.length ? slot.sources.map((source, index) => <small key={`${source.source}-${index}`}>{source.when === 'initial-round' ? '首轮' : source.when === 'later-rounds' ? '后续轮次' : '每轮'}：{source.kind === 'run-input' ? '冻结输入' : `节点 ${source.source}${source.port ? ` / ${source.port}` : ''}`} · {sourceSelectionLabels[source.selection] || source.selection}</small>) : <small>来源未记录</small>}{slot.projection && <small>只读取投影字段：{slot.projection.fields.join('、') || '字段未记录'}</small>}</> : <small>{slot.requiredInputs.length ? `依赖保存输入：${slot.requiredInputs.join('、')}` : '依赖输入未记录'}</small>}</div>) : <p className="sw-muted">该版本没有记录此类槽位。</p>}</section>;
}

function WorkbenchInner({ spaceId, apiBase = '/api/workflow-spaces/v1' }: SpaceWorkbenchProps) {
  const api = useMemo(() => new SpaceApi(apiBase, spaceId), [apiBase, spaceId]);
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selection = useMemo(() => readSelection(params), [params]);
  const [nodeTab, setNodeTab] = useState('overview');
  const [assetTab, setAssetTab] = useState('body');
  const [expanded, setExpanded] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [compareId, setCompareId] = useState<string>();
  const [assetSearch, setAssetSearch] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [planOpen, setPlanOpen] = useState(!!selection.plan && !selection.run && !selection.comparison);
  const [caseDirectoryOpen, setCaseDirectoryOpen] = useState(!selection.case && !selection.run);
  const [authBlocked, setAuthBlocked] = useState(false);
  const priorIdentity = useRef<string | undefined>(undefined);
  const priorRunState = useRef<{ id: string; state: string } | undefined>(undefined);
  const summaryQuery = useQuery({ queryKey: ['space-summary', api.root], queryFn: ({ signal }) => api.summary(signal), refetchInterval: query => document.visibilityState === 'visible' && !isAuthDenial(query.state.error) ? 5000 : false, retry: 1, staleTime: 0 });
  const deniedNow = isAuthDenial(summaryQuery.error);
  const summary = mayDisplaySummary(summaryQuery.data, summaryQuery.error, authBlocked) ? summaryQuery.data : undefined;
  const scope = summary ? `${summary.subject.id}:${summary.subject.cacheScope}` : undefined;
  useEffect(() => {
    if (!summary) return;
    const identity = `${summary.subject.id}:${summary.subject.cacheScope}`;
    if (identityChanged(priorIdentity.current, identity)) { discardScopedSpaceData(client, priorIdentity.current); setCompareId(undefined); setPromptOpen(false); }
    priorIdentity.current = identity;
  }, [summary?.subject.id, scope, client]);
  useEffect(() => {
    if (deniedNow) { setAuthBlocked(true); discardScopedSpaceData(client); setCompareId(undefined); }
    else if (summaryQuery.isSuccess && !summaryQuery.isFetching && summaryQuery.data) setAuthBlocked(false);
  }, [deniedNow, summaryQuery.isSuccess, summaryQuery.isFetching, summaryQuery.dataUpdatedAt, client]);
  const key = (part: string, ...ids: unknown[]) => ['space', scope, spaceId, part, ...ids];
  const versions = usePaged(key('versions'), (cursor, signal) => api.versions(cursor, signal), !!scope);
  const cases = usePaged(key('cases'), (cursor, signal) => api.cases(cursor, signal), !!scope);
  const assets = usePaged(key('assets', assetSearch), (cursor, signal) => api.assets(cursor, assetSearch || undefined, undefined, signal), !!scope && selection.view === 'assets');
  const loadedVersions = versions.data?.pages.flatMap(page => page.items) || [];
  const versionId = selection.version || summary?.adoptedVersionId || summary?.latestVersionId || loadedVersions[0]?.id;
  const versionQuery = useQuery({ queryKey: key('version', versionId), queryFn: ({ signal }) => api.version(versionId!, signal), enabled: !!scope && !!versionId });
  const versionCases = usePaged(key('version-cases', versionId), (cursor, signal) => api.versionCases(versionId!, cursor, signal), !!scope && !!versionId && selection.view === 'workflow' && selection.tab === 'process');
  const runQuery = useQuery({ queryKey: key('run', selection.run), queryFn: ({ signal }) => api.run(selection.run!, signal), enabled: !!scope && !!selection.run, refetchInterval: query => query.state.data && isActiveRun(query.state.data.state) && document.visibilityState === 'visible' ? 3000 : false });
  const run = runQuery.data;
  const caseId = selection.case || run?.caseId;
  const caseQuery = useQuery({ queryKey: key('case', caseId), queryFn: ({ signal }) => api.case(caseId!, signal), enabled: !!scope && !!caseId });
  const caseRuns = usePaged(key('case-runs', caseId), (cursor, signal) => api.caseRuns(caseId!, cursor, signal), !!scope && !!caseId);
  const processQuery = useQuery({ queryKey: key('process', selection.run), queryFn: ({ signal }) => api.process(selection.run!, signal), enabled: !!scope && !!selection.run && selection.tab === 'process', refetchInterval: query => run && isActiveRun(run.state) && document.visibilityState === 'visible' ? 3000 : false });
  const version = versionQuery.data;
  const process = processQuery.data;
  const nodes = selection.tab === 'process' ? process?.nodes || [] : version?.nodes || [];
  const node = nodes.find(item => item.id === selection.node);
  const allowedIds = useMemo(() => new Set(nodes.map(item => item.id)), [nodes]);
  const occurrences = process?.occurrences.filter(item => item.nodeId === selection.node) || [];
  const selectedOccurrence = latestOccurrence(occurrences, selection.occurrence);
  const occurrenceQuery = useQuery({ queryKey: key('occurrence', selection.run, selectedOccurrence?.id), queryFn: ({ signal }) => api.occurrence(selection.run!, selectedOccurrence!.id, signal), enabled: !!scope && !!selection.run && !!selectedOccurrence && nodeTab === 'records', refetchInterval: () => run && isActiveRun(run.state) && document.visibilityState === 'visible' ? 3000 : false });
  const nodeDetail = useQuery({ queryKey: key('node', versionId, selection.node), queryFn: ({ signal }) => api.node(versionId!, selection.node!, signal), enabled: !!scope && !!versionId && !!selection.node && promptOpen && selection.tab !== 'process' });
  const reading = useQuery({ queryKey: key('reading', selection.asset), queryFn: ({ signal }) => api.reading(selection.asset!, signal), enabled: !!scope && !!selection.asset });
  const relations = useQuery({ queryKey: key('relations', selection.asset), queryFn: ({ signal }) => api.relations(selection.asset!, undefined, signal), enabled: !!scope && !!selection.asset });
  const compareReading = useQuery({ queryKey: key('reading', compareId), queryFn: ({ signal }) => api.reading(compareId!, signal), enabled: !!scope && !!compareId });
  const update = (patch: Partial<Selection>, replace = false) => { setParams(writeSelection(params, { ...selection, ...patch }), { replace }); };
  const chooseRun = (item: RunSummaryDto) => { setParams(writeSelection(params, selectRun(selection, item))); setNodeTab('overview'); };
  const chooseAsset = (id: string) => { update({ asset: id, comparison: undefined }); setAssetTab('body'); setExpanded(false); setCompareId(undefined); };
  const chooseNode = (id: string) => { if (selection.node === id) return; setParams(writeSelection(params, selectNode(selection, id))); setNodeTab('overview'); setPromptOpen(false); };
  useEffect(() => {
    if (run && (selection.version !== run.versionId || selection.case !== run.caseId)) update({ version: run.versionId, case: run.caseId }, true);
  }, [run?.id, run?.versionId, run?.caseId, selection.version, selection.case]);
  useEffect(() => {
    if (selection.node && nodes.length && !allowedIds.has(selection.node)) update({ node: undefined, occurrence: undefined }, true);
  }, [selection.node, nodes]);
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
    : !versionId ? 'choose-version' : versionQuery.isPending ? 'loading' : versionQuery.error ? 'error' : 'ready';
  const graphError = selection.tab === 'process' ? processQuery.error : versionQuery.error;
  const retryGraph = () => void (selection.tab === 'process' ? processQuery.refetch() : versionQuery.refetch());
  const allCaseRuns = mergeCurrentRun(caseRuns.data?.pages.flatMap(page => page.items) || [], run, caseId);
  const allRuns = selection.view === 'workflow' ? allCaseRuns.filter(item => item.versionId === versionId) : allCaseRuns;
  const runVersionLabel = loadedVersions.find(item => item.id === run?.versionId)?.label || run?.versionLabel;
  useEffect(() => { if (selection.comparison || selection.run) setPlanOpen(false); else if (selection.plan) setPlanOpen(true); }, [selection.plan, selection.run, selection.comparison]);
  useEffect(() => { setCaseDirectoryOpen(!caseId && !selection.run); }, [caseId, selection.run]);
  if (!summary) return <QueryNotice error={summaryQuery.error} retry={() => void summaryQuery.refetch()} empty="正在验证 Space 读取身份…" />;
  return <div className="sw-app">
    <aside className={`sw-sidebar${mobileMenu ? ' open' : ''}`} aria-label="Space 导航">
      <div className="sw-brand"><span>S</span><div>Space<small>工作台</small></div></div>
      <div className="sw-identity"><small>当前 Space</small><h1>{summary.title}</h1><p>{summary.purpose}</p></div>
      <nav aria-label="主导航">{([['workflow', '工作流'], ['business', '业务'], ['assets', '资产']] as const).map(([id, title]) => <button key={id} aria-current={selection.view === id ? 'page' : undefined} className={selection.view === id ? 'active' : ''} onClick={() => { update({ view: id, asset: undefined, node: undefined, occurrence: undefined, tab: id === 'business' ? 'process' : id === 'workflow' ? 'definition' : selection.tab }); setMobileMenu(false); }}>{title}</button>)}</nav>
      <div className="sw-sidefoot">真实 Space 数据 · {summary.capabilities.write ? '受限操作' : '只读'}</div>
    </aside>
    <div className="sw-main">
      <header className="sw-topbar"><button className="sw-menu" onClick={() => setMobileMenu(!mobileMenu)} aria-label="打开导航" aria-expanded={mobileMenu}>☰</button><div><small>{selection.view === 'business' ? '业务' : selection.view === 'assets' ? '资产' : '工作流'}</small><h2>{selection.view === 'assets' ? '资产目录' : selection.view === 'business' ? label(caseQuery.data?.title, '案例与运行') : label(version?.label, '方法版本')}</h2></div><span className="sw-live">实时读取 · {summary.capabilities.write ? '受限操作' : '只读'}</span></header>
      <div className="sw-context"><span>当前采用：{summary.adoptedVersionId ? label(loadedVersions.find(item => item.id === summary.adoptedVersionId)?.label, '版本已采用') : '尚未指定'}</span><span>正在查看：{label(version?.label, '待选择')}{version && version.id !== summary.adoptedVersionId ? ' · 未采用' : ''}{run ? ` · ${label(runVersionLabel)} · ${stateLabel(run.state)}` : ''} · {availabilityLabel(version)}</span></div>
      <main className="sw-workspace">
        <div className="sw-toolbar">
          {selection.view !== 'assets' && <><label>方法 <select aria-label="选择方法版本" value={versionId || ''} onChange={event => setParams(writeSelection(params, selectVersion(selection, event.target.value)))}><option value="">选择版本</option>{loadedVersions.map(item => <option key={item.id} value={item.id}>{item.label}{item.id === summary.adoptedVersionId ? ' · 已采用' : ''}</option>)}</select></label>{versions.hasNextPage && <button onClick={() => void versions.fetchNextPage()}>更多版本</button>}</>}
          {selection.view === 'workflow' && <Tabs items={[["definition", "方法定义"], ["process", "运行过程"], ["history", "版本历史"]]} value={selection.tab} onChange={value => update({ tab: value as Selection['tab'], node: undefined, occurrence: undefined, asset: undefined })} />}
          {(selection.view === 'business' || selection.tab === 'process') && <><label>案例 <select aria-label="选择案例" value={caseId || ''} onChange={event => update({ case: event.target.value || undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined, plan: undefined, entry: undefined })}><option value="">选择案例</option>{cases.data?.pages.flatMap(page => page.items).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{cases.hasNextPage && <button onClick={() => void cases.fetchNextPage()}>更多案例</button>}</>}
          {(selection.tab === 'process' || selection.view === 'business') && <><label>运行 <select aria-label="选择运行" value={selection.run || ''} onChange={event => { const item = allRuns.find(run => run.id === event.target.value); if (item) chooseRun(item); else update({ run: undefined, node: undefined, occurrence: undefined }); }}><option value="">选择运行</option>{allRuns.map(item => <option key={item.id} value={item.id}>{item.label} · {stateLabel(item.state)}</option>)}</select></label>{caseRuns.hasNextPage && <button onClick={() => void caseRuns.fetchNextPage()}>更多运行</button>}</>}
          {selection.view === 'workflow' && <button onClick={() => update({ view: 'business', tab: 'process', case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined })}>查看全部案例</button>}
        </div>
        <div className="sw-canvas">
          {selection.view === 'assets' ? <section className="sw-catalog"><div className="sw-catalog-head"><h3>跨案例资产</h3><input type="search" value={assetSearch} onChange={event => setAssetSearch(event.target.value)} placeholder="搜索资产" aria-label="搜索资产" /></div><div className="sw-catalog-list"><LoadMore source={assets} empty="没有匹配的资产。" render={item => <Row key={item.id} title={item.title} sub={assetOriginLabel(item)} selected={selection.asset === item.id} onClick={() => chooseAsset(item.id)} />} /></div></section> : null}
          {selection.view === 'business' && <CaseContext caseData={caseQuery.data} run={run} error={caseQuery.error} retry={() => void caseQuery.refetch()} />}
          {selection.view === 'business' && run?.primaryAssetId && <button className="sw-primary-asset" onClick={() => chooseAsset(run.primaryAssetId!)}>阅读本次稿件与对应意见</button>}
          {selection.view === 'business' && scope && <BusinessAction key={`${scope}:${api.root}`} api={api} scope={scope} caseId={caseId} selectedRunId={selection.run} versionId={versionId} versionLabel={version?.label} versionPurpose={version?.id === versionId ? version.purpose : undefined} versionPurposeError={!!versionQuery.error} versions={loadedVersions} adoptedVersionId={summary.adoptedVersionId} onVersionSelect={id => setParams(writeSelection(params, selectVersion(selection, id)))} csrfToken={summary.csrfToken} writable={summary.capabilities.write} onPrepared={prepared => { void client.invalidateQueries({ queryKey: key('cases') }); update({ view: 'business', tab: 'process', case: prepared.caseId, version: prepared.versionId, run: undefined, node: undefined, asset: undefined, plan: undefined, entry: undefined }); }} onRun={chooseRun} onAsset={chooseAsset} />}
          {selection.view === 'business' && <div className="sw-plan-shell">{selection.plan && <button className="sw-plan-return" onClick={() => update({ view: 'workflow', tab: 'history', version: selection.returnVersion || selection.version, returnVersion: undefined, plan: undefined, entry: undefined, evidence: undefined, comparison: undefined, case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined })}>返回版本历史</button>}<button className="sw-plan-toggle" onClick={() => setPlanOpen(!planOpen)} aria-expanded={planOpen}>{planOpen ? '收起计划内运行' : `展开计划内运行${selection.plan ? ' · 已选条目' : ''}`}</button>{planOpen && scope && <PlanAction api={api} spaceId={spaceId} cacheScope={scope} summary={summary} caseId={caseId} viewedRunId={selection.run} planId={selection.plan} entryId={selection.entry} onSelect={(plan, entry) => update({ plan, entry, run: undefined, node: undefined, occurrence: undefined, asset: undefined })} onEntryContext={entry => { if (selection.case !== entry.caseId || selection.version !== entry.versionId) update({ case: entry.caseId, version: entry.versionId, run: undefined, node: undefined, occurrence: undefined, asset: undefined }, true); }} onRun={(item, options) => { setParams(writeSelection(params, selectRun(selection, item))); if (options?.collapsePlan) setPlanOpen(false); }} onAsset={chooseAsset} onComparison={id => update({ comparison: id })} evidenceOpen={selection.evidence === '1'} onEvidenceToggle={open => update({ evidence: open ? '1' : undefined })} versionLabelFor={id => version?.id === id ? version.label : loadedVersions.find(item => item.id === id)?.label} />}</div>}
          {selection.tab === 'history' && selection.view === 'workflow' ? <section className="sw-history"><h3>版本演进</h3><p>前驱、原因、已有验证计划和运行按准确版本关联。</p><LoadMore source={versions} empty="尚无版本记录。" render={item => <VersionHistory key={item.id} api={api} spaceId={spaceId} cacheScope={scope!} item={item} versions={loadedVersions} onOpen={() => setParams(writeSelection(params, { ...selectVersion(selection, item.id), tab: 'definition' }))} onPlan={id => update({ view: 'business', tab: 'process', plan: id, entry: undefined, case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined, comparison: undefined, evidence: '1', returnVersion: item.id })} onRun={() => update({ version: item.id, tab: 'process', case: undefined, run: undefined, node: undefined, occurrence: undefined, asset: undefined })} />} /></section> : selection.view !== 'assets' && <>{selection.view === 'workflow' && selection.tab === 'process' && <><button className="sw-case-directory-toggle" onClick={() => setCaseDirectoryOpen(!caseDirectoryOpen)}>{caseDirectoryOpen ? '收起此方法案例' : '查看此方法全部案例'}</button>{caseDirectoryOpen && <section className="sw-version-cases"><strong>此方法的案例</strong><LoadMore source={versionCases} empty="此版本尚无运行案例。可查看方法定义，或进入全部案例。" render={item => <Row key={item.id} title={item.title} sub={`${item.runCount} 次运行`} onClick={() => update({ case: item.id, run: undefined, node: undefined, occurrence: undefined })} />} /></section>}</>}<div className="sw-canvas-head"><div><small>{selection.tab === 'process' ? '运行过程' : '方法定义'}</small><h3>{selection.tab === 'process' ? label(run?.label, '选择运行') : label(version?.label, '选择方法')}</h3><p>{selection.tab === 'process' ? run ? runStatusSummary(run) : '选择案例和运行，查看准确过程与产物。' : version?.purpose || version?.changeReason || '选择节点查看职责和输入输出。'}</p></div><span>{selection.tab === 'process' ? '节点 · 状态 · 轮次' : '节点 · 方法关系'}</span></div>{graphState === 'ready' ? <Graph url={graphUrl} title={graphTitle} allowedIds={allowedIds} selectedNode={selection.node} onSelect={chooseNode} graphState={selection.tab === 'process' ? process?.graphState : null} identity={graphIdentity} /> : <div className="sw-graph"><QueryNotice error={graphState === 'error' ? graphError : undefined} retry={graphState === 'error' ? retryGraph : undefined} empty={graphState === 'choose-run' ? '请选择一次准确运行以查看过程图。' : graphState === 'choose-version' ? '请选择方法版本。' : '正在读取完整流程图…'} /></div>}<div className="sw-graph-foot">{selection.tab === 'process' && process ? `${process.contractSource === 'retrospective' ? '回溯过程 · ' : ''}${process.coverage === 'partial' ? '部分覆盖 · ' : ''}${process.occurrences.length} 项实例` : '选择图中节点，或使用下方节点列表。'}</div><details className="sw-node-list"><summary>节点列表 · 键盘可操作</summary>{nodes.length ? nodes.map(item => <Row key={item.id} title={item.label} sub={item.purpose || item.kind} selected={selection.node === item.id} onClick={() => chooseNode(item.id)} />) : <QueryNotice error={graphState === 'error' ? graphError : undefined} retry={graphState === 'error' ? retryGraph : undefined} empty={graphState === 'ready' ? '该版本没有保存节点定义或过程。' : graphState === 'choose-run' ? '选择运行后显示实例节点。' : graphState === 'choose-version' ? '选择版本后显示方法节点。' : '正在读取节点…'} />}</details></>}
        </div>
        <aside className={`sw-inspector${selection.comparison ? ' comparison' : expanded ? ' expanded' : ''}${selection.comparison || selection.asset || selection.node ? '' : ' empty'}`} aria-label="详情">{selection.comparison || selection.asset || selection.node ? <><div className="sw-inspector-head"><div><small>{selection.comparison ? '配对阅读' : selection.asset ? '资产阅读' : selection.tab === 'process' ? '运行节点' : '方法节点'}</small><h3>{selection.comparison ? '并看评价对象' : selection.asset ? reading.data?.title || '读取资产' : node?.label || selection.node}</h3><p>{selection.comparison ? '基线与候选的准确被评资产' : selection.asset ? reading.data ? assetOriginLabel(reading.data.asset) : '正在读取资产' : node?.purpose || '该版本未保存节点职责'}</p></div><button aria-label={selection.comparison ? "关闭并排阅读并返回原位置" : selection.asset ? "返回阅读前位置" : "关闭详情"} title={selection.comparison ? "关闭并排阅读并返回原位置" : selection.asset ? "返回阅读前位置" : "关闭详情"} onClick={() => { setParams(writeSelection(params, closeInspector(selection))); setExpanded(false); }}>×</button></div><div className="sw-inspector-scroll">{selection.comparison && scope ? <ComparisonInspector api={api} spaceId={spaceId} cacheScope={scope} planId={selection.plan} comparisonId={selection.comparison} chooseAsset={chooseAsset} goProducer={producer => { update({ view: 'business', tab: 'process', version: producer.versionId, case: producer.caseId, run: producer.runId, node: producer.nodeId || undefined, occurrence: producer.occurrenceId || undefined, asset: undefined, comparison: undefined }); setExpanded(false); }} /> : selection.asset ? <><AssetInspector api={api} spaceId={spaceId} cacheScope={scope!} assetId={selection.asset} reading={reading} relations={relations} tab={assetTab} setTab={setAssetTab} expanded={expanded} setExpanded={setExpanded} compareId={compareId} setCompareId={setCompareId} compareReading={compareReading} sourceVersionLabel={loadedVersions.find(item => item.id === reading.data?.asset.versionId)?.label} chooseAsset={chooseAsset} goProducer={(producer) => { update({ view: 'business', tab: 'process', version: producer.versionId, case: producer.caseId, run: producer.runId, node: producer.nodeId || undefined, occurrence: producer.occurrenceId || undefined, asset: undefined }); setExpanded(false); }} />{reading.data?.asset && <HandlingNotes key={`${scope}:${api.root}:${reading.data.asset.id}`} api={api} scope={scope!} asset={reading.data.asset} referencedAssets={relations.data?.assessments || []} csrfToken={summary.csrfToken} writable={summary.capabilities.write} chooseAsset={chooseAsset} />}</> : <><Tabs items={selection.tab === 'process' ? [['overview', '状态与产物'], ['inputs', '输入与来源'], ['records', '记录']] : [['overview', '职责与合同'], ['config', '配置']]} value={nodeTab} onChange={setNodeTab} />{selection.tab === 'process' ? <ProcessNode node={node} occurrences={occurrences} selected={selectedOccurrence} detail={occurrenceQuery} tab={nodeTab} chooseOccurrence={id => update({ occurrence: id })} chooseAsset={chooseAsset} /> : <DefinitionNode node={node} tab={nodeTab} promptOpen={promptOpen} setPromptOpen={setPromptOpen} detail={nodeDetail} />}</>}</div></> : <div className="sw-empty-inspector"><strong>选择节点或资产</strong><p>图中节点与下方键盘列表可打开准确方法或运行记录。资产可在资料库阅读。</p></div>}</aside>
      </main>
    </div>
    {summaryQuery.error && <div className="sw-identity-blocker"><QueryNotice error={summaryQuery.error} retry={() => void summaryQuery.refetch()} /></div>}
  </div>;
}

function VersionHistory({ api, spaceId, cacheScope, item, versions, onOpen, onPlan, onRun }: { api: SpaceApi; spaceId: string; cacheScope: string; item: VersionSummaryDto; versions: VersionSummaryDto[]; onOpen: () => void; onPlan: (id: string) => void; onRun: () => void }) {
  const [iterationsOpen, setIterationsOpen] = useState(false);
  const iterations = usePaged(['space', cacheScope, spaceId, 'version-iterations', item.id], (cursor, signal) => api.versionIterations(item.id, cursor, signal), iterationsOpen);
  const predecessor = versions.find(version => version.id === item.predecessorId);
  return <article className="sw-history-item"><h4>{item.label} <small>{item.revision}</small></h4><p>{item.changeReason || '变更理由未记录'}</p><dl><dt>前驱</dt><dd>{item.predecessorId ? predecessor?.label || '前驱版本尚未加载' : '首版或未记录'}</dd><dt>部署</dt><dd>{item.availability.state === 'available' ? '可执行' : item.availability.reason || item.availability.state}</dd><dt>运行</dt><dd>{item.runCount} 次 · {item.caseCount} 个案例</dd></dl><div className="sw-actions"><button onClick={onOpen}>查看方法</button><button onClick={onRun}>查看运行</button><button onClick={() => setIterationsOpen(!iterationsOpen)}>{iterationsOpen ? '收起迭代记录' : '阅读迭代记录'}</button>{item.planIds.map(id => <button key={id} onClick={() => onPlan(id)}>查看验证证据</button>)}</div>{iterationsOpen && <section className="sw-iterations"><strong>保存的迭代记录 · 不代表已采用</strong><LoadMore source={iterations} empty="此版本没有保存迭代记录。" render={iteration => <article key={iteration.id}><p>{iteration.hypothesis}</p><small>{iteration.caseIds.length} 个案例 · {iteration.runIds.length} 次运行 · {iteration.reviewIds.length} 份评价</small><details><summary>准确关联</summary><p>迭代 {iteration.id} · 方法 {iteration.workflowVersionId}</p><p>Cases：{iteration.caseIds.join('、') || '未记录'}</p><p>Runs：{iteration.runIds.join('、') || '未记录'}</p><p>评价：{iteration.reviewIds.join('、') || '未记录'}</p></details></article>} /></section>}</article>;
}

function DefinitionNode({ node, tab, promptOpen, setPromptOpen, detail }: { node?: NodeSummaryDto; tab: string; promptOpen: boolean; setPromptOpen: (value: boolean) => void; detail: { data?: { instructions: string | null; configuration: Record<string, unknown> | null }; error: unknown; refetch: () => unknown } }) {
  if (!node) return <QueryNotice empty="此节点在准确版本中没有保存定义。" />;
  return <div className="sw-detail">{tab === 'overview' ? <><h4>节点职责</h4><p>{node.purpose || '未记录'}</p><SlotList title="声明的输入" slots={node.inputs} /><SlotList title="声明的输出" slots={node.outputs} direction="output" /></> : <><dl><dt>执行方式</dt><dd>{node.executor ? `${node.executor.family}${node.executor.adapter ? ` · ${node.executor.adapter}` : ''}` : '未记录'}</dd><dt>模型</dt><dd>{label(node.model)}</dd><dt>工具</dt><dd>{node.tools?.join('、') || '未记录'}</dd></dl><button className="sw-link" onClick={() => setPromptOpen(!promptOpen)}>{promptOpen ? '收起完整指令' : '展开完整指令'}</button>{promptOpen && (detail.data ? <><pre>{detail.data.instructions || '该版本未保存完整指令。'}</pre>{detail.data.configuration && <details><summary>保存的配置</summary><pre>{JSON.stringify(detail.data.configuration, null, 2)}</pre></details>}</> : <QueryNotice error={detail.error} retry={() => void detail.refetch()} />)}</>}</div>;
}

function stepKindLabel(kind: string): string {
  if (kind === 'agent') return 'Agent 尝试';
  if (kind === 'task' || kind === 'program' || kind === 'publish') return `程序步骤（${kind}）`;
  if (kind === 'parallel') return '并行步骤';
  if (kind === 'validate' || kind === 'validation') return '校验步骤';
  return `技术步骤（${kind}）`;
}

function ProcessNode({ node, occurrences, selected, detail, tab, chooseOccurrence, chooseAsset }: { node?: NodeSummaryDto; occurrences: OccurrenceDto[]; selected?: OccurrenceDto; detail: { data?: { contexts: { id: string; model: string | null; instructions: string; reasoningEffort: string | null }[] }; error: unknown; refetch: () => unknown }; tab: string; chooseOccurrence: (id: string) => void; chooseAsset: (id: string) => void }) {
  if (!node) return <QueryNotice empty="本次过程没有保存此节点。" />;
  return <div className="sw-detail">
    {occurrences.length > 1 && <label>轮次 <select aria-label="选择轮次" value={selected?.id || ''} onChange={event => chooseOccurrence(event.target.value)}>{occurrences.map(item => <option key={item.id} value={item.id}>{item.label}{item.branch ? ` · 分支 ${item.branch}` : ''} · {stateLabel(item.state)}</option>)}</select></label>}
    {!selected ? <p className="sw-muted">此节点没有实际执行记录。</p> : tab === 'overview' ? <>
      <p className="sw-status">{selected.label}{selected.branch ? ` · 分支 ${selected.branch}` : ''} · {stateLabel(selected.state)}</p>
      <p>Agent 尝试：{selected.agentAttemptCount ?? '未记录'} · 技术步骤：{selected.technicalStepCount}</p>
      {selected.failureDetails.length > 0 && <><h4>保存的失败原因</h4>{selected.failureDetails.map(step => <div className="sw-process-failure" key={step.id}><strong>{stepKindLabel(step.kind)} · {step.key}</strong><p>{step.error || '原因未记录'}</p></div>)}</>}
      {selected.state === 'failed' && selected.failureDetails.length === 0 && <p className="sw-muted">此轮失败，但没有保存具体失败原因。</p>}
      <h4>本轮产物</h4><AssetLinks assets={selected.outputs} choose={chooseAsset} empty="本轮没有保存业务产物。" />
    </> : tab === 'inputs' ? <><h4>本轮输入</h4><AssetLinks assets={selected.inputs} choose={chooseAsset} empty="本轮没有保存输入资产。" /><h4>声明的输入合同</h4><SlotList title="输入槽位" slots={node.inputs} /></> : <>
      <dl><dt>状态</dt><dd>{stateLabel(selected.state)}</dd><dt>Agent 尝试</dt><dd>{selected.agentAttemptCount ?? '未记录'}</dd><dt>技术步骤</dt><dd>{selected.technicalStepCount}</dd><dt>会话数</dt><dd>{selected.sessionIds.length}</dd><dt>记录来源</dt><dd>{selected.provenance === 'observed' ? '直接观测' : selected.provenance === 'derived' ? '从保存记录推导' : '未记录'}</dd></dl>
      <h4>保存的执行步骤</h4>{selected.technicalSteps.length ? selected.technicalSteps.map(step => <p key={step.id}>{stepKindLabel(step.kind)} · {step.key} · {stateLabel(step.state)}{step.error ? ` · ${step.error}` : ''}</p>) : <p className="sw-muted">没有保存执行步骤。</p>}
      <h4>实际执行上下文</h4>{detail.data ? detail.data.contexts.length ? detail.data.contexts.map(context => <details key={context.id}><summary>{label(context.model)} · {label(context.reasoningEffort)}</summary><pre>{context.instructions}</pre></details>) : <p className="sw-muted">没有保存执行上下文。</p> : <QueryNotice error={detail.error} retry={() => void detail.refetch()} />}
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
  return <div className="sw-detail sw-reader"><div className="sw-actions"><button onClick={() => setExpanded(!expanded)}>{expanded ? '收窄阅读' : '扩大阅读'}</button>{relation?.producer && <button onClick={() => goProducer(relation.producer!)}>定位生产节点</button>}</div><p>{assetOriginLabel(asset)}{sourceVersionLabel ? ` · ${sourceVersionLabel}` : ''}</p><details className="sw-asset-trace"><summary>资产追溯</summary><dl><dt>资产 ID</dt><dd>{asset.id}</dd><dt>Schema</dt><dd>{asset.schema.namespace} · {asset.schema.revision}</dd><dt>资产原始状态</dt><dd>{asset.state}</dd><dt>种类</dt><dd>{asset.kind}</dd><dt>版本</dt><dd>{asset.versionId || '未记录'}</dd><dt>Run</dt><dd>{asset.runId || '未记录'}</dd></dl></details><Tabs items={[["body", "正文"], ["visual", "画面"], ["relations", "关系"], ["reviews", "评价"], ["evidence", "证据"]]} value={tab} onChange={setTab} />{(['body', 'visual', 'evidence'] as const).includes(tab as ReaderView) ? <><div className={compareId ? 'sw-compare' : ''}><SavedReaderPane title={compareId ? reading.data.title : undefined} roundLabel={compareId ? (asset.round == null ? '来源／轮次未记录' : `第 ${asset.round} 轮`) : undefined} sections={reading.data.sections} view={tab as ReaderView} evidence={{ id: asset.id, schema: asset.schema, readerStatus: reading.data.readerStatus, sourceLinks: reading.data.sourceLinks }} chooseAsset={chooseAsset} />{compareId && (compareReading.data ? <SavedReaderPane title={compareReading.data.title} roundLabel={compareReading.data.asset.round == null ? '来源／轮次未记录' : `第 ${compareReading.data.asset.round} 轮`} sections={compareReading.data.sections} view={tab as ReaderView} evidence={{ id: compareReading.data.asset.id, schema: compareReading.data.asset.schema, readerStatus: compareReading.data.readerStatus, sourceLinks: compareReading.data.sourceLinks }} chooseAsset={chooseAsset} /> : <QueryNotice error={compareReading.error} retry={() => void compareReading.refetch()} />)}</div>{compareId && <button onClick={() => setCompareId(undefined)}>关闭并排阅读</button>}</> : !relation ? <QueryNotice error={relations.error} retry={() => void relations.refetch()} /> : tab === 'relations' ? <><h4>生产来源</h4>{relation.producer ? <Row title={relation.producer.nodeLabel} sub="打开生产运行与轮次" onClick={() => goProducer(relation.producer!)} /> : <p className="sw-muted">无生产节点或来源未记录。</p>}<h4>上一稿</h4>{relation.previousDraft ? <Row title={relation.previousDraft.title} onClick={() => chooseAsset(relation.previousDraft!.id)} /> : <p className="sw-muted">没有关联前稿。</p>}<h4>准确评估资产</h4><AssetLinks assets={relation.assessments} choose={chooseAsset} empty="没有关联评估资产。" /><h4>依赖资产</h4><AssetLinks assets={relation.dependencies} choose={chooseAsset} empty="没有记录依赖资产。" /><h4>被使用的轮次</h4>{relation.consumers.length ? relation.consumers.map((consumer, index) => <Row key={`${consumer.runId}-${consumer.occurrenceId}-${index}`} title={consumer.nodeLabel} sub={`运行 ${consumer.runId}`} onClick={() => goProducer({ ...consumer, occurrenceId: consumer.occurrenceId })} />) : <p className="sw-muted">没有记录使用轮次。</p>}<h4>并排阅读</h4><select aria-label="选择对照资产" value={compareId || ''} onChange={event => { setCompareId(event.target.value || undefined); if (event.target.value) setTab('body'); }}><option value="">选择已有相关资产</option>{[...new Map([relation.previousDraft, ...relation.assessments, ...relation.dependencies].filter((item): item is AssetSummaryDto => !!item && item.id !== assetId).map(item => [item.id, item])).values()].map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></> : tab === 'reviews' ? <><h4>独立四问评价</h4><ReviewCards api={api} spaceId={spaceId} cacheScope={cacheScope} reviews={relation.reviews} chooseAsset={chooseAsset} /><h4>流程内意见</h4><AssetLinks assets={relation.assessments} choose={chooseAsset} empty="没有关联的流程内意见。" /></> : <p className="sw-muted">阅读视图未记录。</p>}</div>;
}

export function SpaceWorkbench(props: SpaceWorkbenchProps) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: true } } }));
  return <QueryClientProvider client={client}><BrowserRouter basename={props.basePath || undefined}><WorkbenchInner {...props} /></BrowserRouter></QueryClientProvider>;
}
