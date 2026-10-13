import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import { SpaceApi, SpaceApiError, type UnderstandingRevisionDto, type UnderstandingRevisionRequestDto } from './api.js';
import type { BusinessStateDto } from '@signal-room/workflow-space-api/contracts';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
export const renderUnderstandingMarkdown = (content: string): string => markdown.render(content);
type Source = UnderstandingRevisionDto['sources'][number];
const sourceNumber = (source: Source): string | null => /\bS\d+\b/i.exec(source.title)?.[0].toUpperCase() || /\bS\d+\b/i.exec(source.ref)?.[0].toUpperCase() || null;
export function resolvableBusinessSource(source: Source): { kind: 'asset' | 'case'; id: string } | null {
  if (source.kind !== 'asset' && source.kind !== 'case') return null;
  const ref = source.ref.trim();
  return ref === source.ref && /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(ref) ? { kind: source.kind, id: ref } : null;
}
export function BusinessSourceReadLink({ api, scope, source, onOpen }: { api: SpaceApi; scope: string; source: Source; onOpen: (kind: 'asset' | 'case', id: string) => void }) {
  const target = resolvableBusinessSource(source);
  const asset = useQuery({ queryKey: ['space', scope, api.root, 'source-asset', target?.id], queryFn: ({ signal }) => api.reading(target!.id, signal), enabled: target?.kind === 'asset', retry: false });
  const businessCase = useQuery({ queryKey: ['space', scope, api.root, 'source-case', target?.id], queryFn: ({ signal }) => api.case(target!.id, signal), enabled: target?.kind === 'case', retry: false });
  if (source.kind !== 'asset' && source.kind !== 'case') return null;
  if (!target) return <p className="sw-muted">此引用不是可定位的本 Space 对象 ID；保留原引用供核对，未提供全文入口。</p>;
  const record = target.kind === 'asset' ? asset : businessCase;
  const exact = target.kind === 'asset' ? asset.data?.asset.id === target.id : businessCase.data?.id === target.id;
  if (record.error || record.data && !exact) return <p role="alert">此来源在当前 Space 不可读取或准确身份不匹配。<button type="button" onClick={() => void record.refetch()}>重试读取</button></p>;
  if (!record.data) return <p className="sw-muted">正在核对本 Space 中的准确来源…</p>;
  return <button type="button" className="sw-link" onClick={() => onOpen(target.kind, target.id)}>{target.kind === 'asset' ? `阅读准确资产 · ${asset.data?.title || source.title}` : `阅读案例与全部运行 · ${businessCase.data?.title || source.title}`}</button>;
}
const chapterLabels: Record<string, string> = {
  '我们希望这项创作业务做到什么': '目标',
  '从创作者视角，完整流程及产物是什么': '阶段与产物',
  '我们创作时坚持什么，为什么': '原则',
  '怎样验收目标是否达成': '验收',
  '这些认识怎样随真实创作进化': '进化',
};
export const businessChapterLabel = (title: string): string => chapterLabels[title] || title;
export function understandingRelationSummary(currentRevision: number | undefined, designRevision: number | undefined, designUnderstandingRevision: number | undefined, exactDesignRevision: number | undefined, exactUnderstandingRevision: number | undefined, hasExactVersion = true): string {
  return [currentRevision ? `当前理解 ${currentRevision}` : '当前理解读取中', designRevision ? `草案 ${designRevision} 依据理解 ${designUnderstandingRevision || '待核对'}` : '草案状态待核对', ...(hasExactVersion ? [exactDesignRevision ? `准确版设计 ${exactDesignRevision} 依据理解 ${exactUnderstandingRevision || '待核对'}` : '准确版依据待核对'] : [])].join('；');
}
export function renderBusinessDocument(content: string, sources: Source[]) {
  const tokens = markdown.parse(content, {});
  const availableSources = new Set(sources.map(sourceNumber).filter((number): number is string => !!number));
  const chapters: { id: string; title: string }[] = [];
  let diagram = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'heading_open' && token.tag === 'h2') {
      const id = `business-chapter-${chapters.length + 1}`;
      token.attrSet('id', id);
      chapters.push({ id, title: tokens[index + 1]?.content || `章节 ${chapters.length + 1}` });
    }
    if (token.type !== 'inline') continue;
    if (!diagram && token.children?.some(child => child.type === 'image')) {
      const paragraph = tokens[index - 1];
      if (paragraph?.type === 'paragraph_open') { paragraph.attrSet('id', 'business-diagram'); diagram = true; }
    }
    if (!availableSources.size || !token.children) continue;
    const children = [];
    let existingLinkDepth = 0;
    for (const child of token.children) {
      if (child.type === 'link_open') { existingLinkDepth++; children.push(child); continue; }
      if (child.type === 'link_close') { existingLinkDepth--; children.push(child); continue; }
      if (child.type !== 'text' || existingLinkDepth > 0) { children.push(child); continue; }
      const parts = child.content.split(/(\bS\d+\b)/gi);
      for (const part of parts) {
        if (!part) continue;
        if (availableSources.has(part.toUpperCase())) {
          const open = new Token('link_open', 'a', 1);
          open.attrSet('href', `#business-source-${part.toUpperCase()}`);
          children.push(open);
          const label = new Token('text', '', 0); label.content = part; children.push(label);
          children.push(new Token('link_close', 'a', -1));
        } else { const plain = new Token('text', '', 0); plain.content = part; children.push(plain); }
      }
    }
    token.children = children;
  }
  return { html: markdown.renderer.render(tokens, markdown.options, {}), chapters, diagram };
}
type Draft = Pick<UnderstandingRevisionRequestDto, 'title' | 'content' | 'sources' | 'authorship' | 'changeReason'>;
export function UnderstandingSourceEditor({ source, index, onChange, onRemove }: { source: Source; index: number; onChange: (source: Source) => void; onRemove: () => void }) {
  return <details className="sw-understanding-source-row"><summary><strong>{source.title || `新来源 ${index + 1}`}</strong>{source.excerpt && <small> · {source.excerpt.length > 88 ? `${source.excerpt.slice(0, 88)}…` : source.excerpt}</small>}</summary><div className="sw-understanding-source-edit"><label>类型<select value={source.kind} onChange={event => onChange({ ...source, kind: event.target.value as Source['kind'] })}><option value="document">文档</option><option value="case">业务案例</option><option value="asset">资产</option><option value="user-request">用户请求</option></select></label><label>引用位置<input value={source.ref} onChange={event => onChange({ ...source, ref: event.target.value })} placeholder="路径、URL 或对象 ID" /></label><label>标题<input value={source.title} onChange={event => onChange({ ...source, title: event.target.value })} /></label><label>摘录（可选）<textarea value={source.excerpt || ''} onChange={event => onChange({ ...source, excerpt: event.target.value })} /></label><button type="button" onClick={onRemove}>移除此来源</button></div></details>;
}
const emptyDraft = (name: string): Draft => ({ title: '', content: '', sources: [], authorship: { kind: 'human', name }, changeReason: '' });
export const draftFromRevision = (value: UnderstandingRevisionDto, principal: string): Draft => ({ title: value.title, content: value.content, sources: value.sources, authorship: { kind: 'human', name: principal }, changeReason: '' });
export const understandingAuthorshipForSave = (draft: Draft, externalAgent: { id: string; sessionId: string } | undefined, writable: boolean): Draft['authorship'] => externalAgent && writable ? { kind: 'agent', name: externalAgent.id, sessionId: externalAgent.sessionId } : draft.authorship;
export const mayEditUnderstanding = (writable: boolean, csrfToken: string | null | undefined, editing: boolean, isCurrent: boolean, error: unknown): boolean => writable && !!csrfToken && (editing || (isCurrent && (!error || isMissing(error))));
const failure = (error: unknown) => error instanceof Error ? error.message : '请求失败，请稍后重试。';
const isMissing = (error: unknown) => error instanceof SpaceApiError && error.status === 404;

export function understandingHeadChanged(previous: string | null | undefined, next: string | null | undefined): boolean {
  return next !== undefined && previous !== next;
}

export async function refreshUnderstandingHead(client: QueryClient, scope: string, root: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['space', scope, root, 'understanding', 'current'], exact: true }),
    client.invalidateQueries({ queryKey: ['space', scope, root, 'understanding', 'revisions'], exact: true }),
  ]);
}

export function BlankBusinessState({ state, writable }: { state: BusinessStateDto; writable: boolean }) {
  return <section className="sw-understanding-blank" aria-label="业务空白状态">
    <h3>从业务请求开始</h3>
    <p>这个 Space 还没有保存业务理解。Agent 会根据你的请求形成理解，之后可以在这里共同阅读、核对来源和修订。</p>
    <dl aria-label="已保存的业务对象数量">
      <dt>理解修订</dt><dd>{state.understandingRevisions}</dd>
      <dt>设计修订</dt><dd>{state.methodDesignRevisions}</dd>
      <dt>方法版本</dt><dd>{state.workflowVersions}</dd>
      <dt>案例</dt><dd>{state.cases}</dd>
      <dt>运行</dt><dd>{state.runs}</dd>
      <dt>业务资产</dt><dd>{state.businessAssets}</dd>
    </dl>
    {!writable && <p className="sw-muted">当前身份没有保存理解修订的入口；此处的阅读能力不代表已开放保存能力。</p>}
  </section>;
}

export function Understanding({ api, scope, summaryTitle, principal, externalAgent, csrfToken, writable, businessState, selectedRevisionId, onSelectRevision, onDesign, exactVersionId, onMethod, onActiveRevision, onOpenSource, returnSourceIndex }: {
  api: SpaceApi; scope: string; summaryTitle: string; principal: string; csrfToken?: string | null; writable: boolean;
  businessState?: BusinessStateDto;
  externalAgent?: { id: string; sessionId: string; role?: 'design' | 'observer' }; selectedRevisionId?: string; onSelectRevision: (id?: string) => void; onDesign?: () => void; exactVersionId?: string; onMethod?: () => void; onActiveRevision?: (id: string | undefined) => void; onOpenSource?: (kind: 'asset' | 'case', id: string, revisionId: string, sourceIndex: number) => void; returnSourceIndex?: number;
}) {
  const client = useQueryClient();
  const currentHeadId = businessState?.understandingRevisionId;
  const previousHeadId = useRef(currentHeadId);
  useEffect(() => {
    if (understandingHeadChanged(previousHeadId.current, currentHeadId)) void refreshUnderstandingHead(client, scope, api.root);
    previousHeadId.current = currentHeadId;
  }, [currentHeadId, client, scope, api.root]);
  const currentKey = ['space', scope, api.root, 'understanding', 'current'];
  const revisionsKey = ['space', scope, api.root, 'understanding', 'revisions'];
  const current = useQuery({ queryKey: currentKey, queryFn: ({ signal }) => api.understanding(undefined, signal), retry: false });
  const selected = useQuery({ queryKey: ['space', scope, api.root, 'understanding', selectedRevisionId], queryFn: ({ signal }) => api.understanding(selectedRevisionId, signal), enabled: !!selectedRevisionId, retry: false });
  const history = useInfiniteQuery({ queryKey: revisionsKey, queryFn: ({ pageParam, signal }) => api.understandingRevisions(pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor || undefined });
  const design = useQuery({ queryKey: ['space', scope, api.root, 'method-design', 'current'], queryFn: ({ signal }) => api.methodDesign(undefined, signal), retry: false, enabled: !!onDesign });
  const designUnderstanding = useQuery({ queryKey: ['space', scope, api.root, 'understanding', 'revision', design.data?.understanding.revisionId], queryFn: ({ signal }) => api.understanding(design.data!.understanding.revisionId, signal), enabled: !!design.data?.understanding.revisionId, retry: false });
  const exactBasis = useQuery({ queryKey: ['space', scope, api.root, 'version-design', exactVersionId], queryFn: ({ signal }) => api.versionDesignBasis(exactVersionId!, signal), retry: false, enabled: !!exactVersionId });
  const revisions = history.data?.pages.flatMap(page => page.items) || [];
  const value = selectedRevisionId ? selected.data : current.data;
  const activeRevisionRef = useRef<string | undefined>(undefined);
  useEffect(() => { if (activeRevisionRef.current !== value?.id) { activeRevisionRef.current = value?.id; onActiveRevision?.(value?.id); } }, [value?.id, onActiveRevision]);
  const selectedError = selectedRevisionId ? selected.error : current.error;
  const selectedPending = selectedRevisionId ? selected.isPending : current.isPending;
  const isCurrent = !selectedRevisionId || selectedRevisionId === current.data?.id;
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(principal));
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const requestKey = useRef(crypto.randomUUID());

  useEffect(() => {
    if (dirty || editing) return;
    setDraft(value ? draftFromRevision(value, principal) : emptyDraft(principal));
  }, [value?.id, principal, selectedRevisionId, dirty, editing]);

  const update = (patch: Partial<Draft>) => { setDraft(previous => ({ ...previous, ...patch })); requestKey.current = crypto.randomUUID(); setDirty(true); setError(''); setSaved(''); };
  const goRevision = (id?: string) => {
    if (dirty && !window.confirm('当前修改尚未保存。离开会丢弃这份草稿，继续吗？')) return;
    setEditing(false); setDirty(false); setError(''); setSaved(''); onSelectRevision(id);
  };
  const save = async () => {
    if (!csrfToken || !writable || saving || !editing) return;
    if (!draft.title.trim() || !draft.content.trim() || !draft.changeReason.trim()) { setError('请填写标题、正文和本次修订原因。'); return; }
    if (draft.sources.some(source => !source.kind.trim() || !source.ref.trim() || !source.title.trim())) { setError('每条来源都需要类型、引用位置和标题。'); return; }
    if (draft.sources.length === 0) { setError('请至少记录一条来源。'); return; }
    if (!author.name.trim()) { setError('请填写声明署名。'); return; }
    setSaving(true); setError('');
    try {
      const savedRevision = await api.saveUnderstanding({ ...draft, title: draft.title.trim(), authorship: { ...author, name: author.name.trim() }, expectedRevisionId: baseRevisionId, idempotencyKey: requestKey.current }, csrfToken);
      client.setQueryData(currentKey, savedRevision);
      await client.invalidateQueries({ queryKey: revisionsKey });
      setDraft(draftFromRevision(savedRevision, principal)); setBaseRevisionId(savedRevision.id); setDirty(false); setEditing(false); onSelectRevision(undefined); setSaved(`已保存修订 ${savedRevision.revision}；仍未经过人工确认。`);
    } catch (cause) {
      if (cause instanceof SpaceApiError && cause.status === 409) {
        setError('保存冲突：当前正文已有新修订。你的草稿已保留，请先核对最新修订，再决定如何调整。');
        await client.invalidateQueries({ queryKey: currentKey });
      } else setError(failure(cause));
    } finally { setSaving(false); }
  };
  const renderedDocument = useMemo(() => renderBusinessDocument(value?.content || '', value?.sources || []), [value?.content, value?.sources]);
  const canEdit = mayEditUnderstanding(writable, csrfToken, editing, isCurrent, selectedError);
  const noCurrent = !selectedRevisionId && isMissing(selectedError);
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const author = understandingAuthorshipForSave(draft, externalAgent, writable);
  useEffect(() => {
    if (returnSourceIndex === undefined || !value?.sources[returnSourceIndex] || !selectedRevisionId || value.id !== selectedRevisionId) return;
    const source = value.sources[returnSourceIndex];
    const id = `business-source-${sourceNumber(source) || returnSourceIndex + 1}`;
    const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [returnSourceIndex, value?.id, selectedRevisionId]);
  const draftUnsynced = !!(design.data && current.data && design.data.understanding.revisionId !== current.data.id);
  const versionUnsynced = !!(exactBasis.data && current.data && exactBasis.data.understanding.id !== current.data.id);

  return <section className="sw-understanding" aria-label="业务理解">
    <header className="sw-understanding-head"><div><small>Space · 业务理解</small><h2>{value?.title || (noCurrent ? '尚未保存业务理解' : summaryTitle)}</h2><p>{value ? `修订 ${value.revision} · ${isCurrent ? '当前修订' : '历史修订，只读'} · 未确认` : '在此记录业务判断、依据、未知与成功标准。'}</p></div><div className="sw-understanding-actions">{!isCurrent && !editing && <button onClick={() => goRevision(undefined)}>返回当前修订</button>}{onDesign && value && !editing && <button onClick={onDesign}>{design.data ? '阅读现有设计草案' : design.isPending ? '查看设计草案状态' : '进入设计草案'}</button>}{onMethod && exactVersionId && !editing && <button onClick={onMethod}>阅读准确方法</button>}{canEdit && !editing && <details className="sw-understanding-extra-actions"><summary>更多操作</summary><button onClick={() => { setDraft(value ? draftFromRevision(value, principal) : emptyDraft(principal)); setBaseRevisionId(current.data?.id || null); requestKey.current = crypto.randomUUID(); setDirty(false); setError(''); setEditing(true); }}>{value ? '修订正文' : '创建理解正文'}</button></details>}</div></header>
    {value && <section className="sw-design-basis-choice" aria-label="当前认识与方法依据" style={{ padding: '8px 11px', marginBottom: 8 }}>
      <p style={{ margin: 0 }}>{selectedRevisionId && current.data && value.id !== current.data.id ? `正在阅读历史修订 ${value.revision}；` : ''}{understandingRelationSummary(current.data?.revision, design.data?.revision, designUnderstanding.data?.revision, exactBasis.data?.design.revision, exactBasis.data?.understanding.revision, !!exactVersionId)}。</p>
      {(draftUnsynced || versionUnsynced) && <p className="sw-muted" style={{ margin: '3px 0 0' }}>{draftUnsynced ? '草案尚未按当前理解同步；' : ''}{versionUnsynced ? '准确版保留旧理解作为冻结依据；' : ''}阅读不会自动改写绑定。</p>}
      <details><summary>完整标题与准确依据</summary><p>正在阅读：理解修订 {value.revision} · {value.title}。</p>{design.data ? <p>草案修订 {design.data.revision} · {design.data.title}；依据{designUnderstanding.data ? `理解修订 ${designUnderstanding.data.revision} · ${designUnderstanding.data.title}` : `准确理解 ${design.data.understanding.revisionId} 暂不可读`}。</p> : <p>{isMissing(design.error) ? '尚无设计草案。' : design.error ? '设计草案读取失败；不能推断尚无草案。' : '正在读取设计草案。'}</p>}{exactVersionId && (exactBasis.data ? <p>准确版本冻结：设计修订 {exactBasis.data.design.revision} · {exactBasis.data.design.title}；理解修订 {exactBasis.data.understanding.revision} · {exactBasis.data.understanding.title}。</p> : <p>{exactBasis.error ? '准确版本依据暂不可读，不能推断它依据当前理解。' : '正在读取准确版本依据。'}</p>)}</details>
    </section>}
    {value && !editing && <nav className="sw-business-chapters" aria-label="业务理解章节">{renderedDocument.chapters.map(chapter => <button type="button" key={chapter.id} title={chapter.title} aria-label={chapter.title} onClick={() => jump(chapter.id)}>{businessChapterLabel(chapter.title)}</button>)}{renderedDocument.diagram && <button type="button" onClick={() => jump('business-diagram')}>完整周期图</button>}<button type="button" onClick={() => jump('business-sources')}>来源</button></nav>}
    {!writable && !selectedPending && <p className="sw-muted">{externalAgent?.role === 'observer' || (externalAgent && externalAgent.role !== 'design') ? '当前为观察 Agent 身份，可阅读准确修订；修订业务理解需要受信设计 Agent 凭据。' : '当前身份只有阅读权限；若需修订，请使用具备业务理解写入能力的身份。'}</p>}
    {selectedPending ? <p className="sw-muted">正在读取业务理解…</p> : selectedError && !noCurrent ? <div className="sw-notice" role="alert"><strong>业务理解读取失败</strong><p>{failure(selectedError)}</p><button onClick={() => void (selectedRevisionId ? selected.refetch() : current.refetch())}>重试</button></div> : null}
    {noCurrent && businessState?.understandingRevisions === 0 && <BlankBusinessState state={businessState} writable={writable} />}
    {saved && <p className="sw-understanding-success" role="status">{saved}</p>}
    {error && <div className="sw-notice" role="alert"><strong>无法保存</strong><p>{error}</p></div>}
    {editing && current.data && current.data.id !== baseRevisionId && <section className="sw-understanding-conflict"><h3>已有更新的当前修订 · {current.data.revision}</h3><p>{current.data.title}</p><div className="sw-understanding-reading" dangerouslySetInnerHTML={{ __html: renderUnderstandingMarkdown(current.data.content) }} /><button onClick={() => { setBaseRevisionId(current.data!.id); requestKey.current = crypto.randomUUID(); setError(''); }}>已核对，以此修订为基础保存我的草稿</button></section>}
    {editing && canEdit ? <div className="sw-understanding-editor">
      <p className="sw-muted">当前身份可修订业务理解；保存将创建未确认的新修订，不会改写旧稿。</p>
      {externalAgent && writable ? <p className="sw-muted">受信设计 Agent 署名：{externalAgent.id} · 会话 {externalAgent.sessionId}。身份来自当前凭据，不可在表单中改写；系统另记实际保存者。</p> : <div className="sw-understanding-meta-edit"><label>声明作者类型<select value={draft.authorship.kind} onChange={event => update({ authorship: { ...draft.authorship, kind: event.target.value as 'human' | 'agent' } })}><option value="human">人</option><option value="agent">Agent</option></select></label><label>声明署名<input value={draft.authorship.name} onChange={event => update({ authorship: { ...draft.authorship, name: event.target.value } })} /></label>{draft.authorship.kind === 'agent' && <label>会话 ID（可选）<input value={draft.authorship.sessionId || ''} onChange={event => update({ authorship: { ...draft.authorship, sessionId: event.target.value || undefined } })} /></label>}</div>}
      <label>本次修订原因<input value={draft.changeReason} onChange={event => update({ changeReason: event.target.value })} placeholder="说明这次新增或改变的判断" /></label>
      <div className="sw-understanding-actions"><button disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存为新修订'}</button><button disabled={saving} onClick={() => { if (dirty && !window.confirm('放弃尚未保存的修改？')) return; setEditing(false); setDirty(false); setError(''); }}>取消</button></div>

      <label>标题<input value={draft.title} onChange={event => update({ title: event.target.value })} maxLength={240} /></label>
      <label>正文（Markdown）<textarea className="sw-understanding-body-input" value={draft.content} onChange={event => update({ content: event.target.value })} spellCheck={false} placeholder="完整记录业务问题、判断、来源、未知与成功标准。" /></label>
      <section><div className="sw-understanding-section-head"><h3>来源（{draft.sources.length}）</h3><button type="button" onClick={() => update({ sources: [...draft.sources, { kind: 'document', ref: '', title: '' }] })}>添加来源</button></div>{draft.sources.map((source, index) => <UnderstandingSourceEditor key={index} source={source} index={index} onChange={next => update({ sources: draft.sources.map((item, at) => at === index ? next : item) })} onRemove={() => update({ sources: draft.sources.filter((_, at) => at !== index) })} />)}</section>
    </div> : value && <><article className="sw-understanding-reading" dangerouslySetInnerHTML={{ __html: renderedDocument.html }} /><details className="sw-understanding-sources" id="business-sources" key={value.id} open><summary>来源（{value.sources.length}）</summary><p className="sw-muted">此处展示已记录的标题与摘录；文档来源尚未接入全文读取。资产和案例只在本 Space 准确读取成功后开放入口。</p>{value.sources.length ? <ol>{value.sources.map((source, index) => <li id={`business-source-${sourceNumber(source) || index + 1}`} key={`${source.ref}-${index}`}><strong>{sourceNumber(source) && source.title.startsWith(`${sourceNumber(source)} ·`) ? source.title : `${sourceNumber(source) || index + 1} · ${source.title}`}</strong>{source.excerpt && <p>{source.excerpt}</p>}{onOpenSource && <BusinessSourceReadLink api={api} scope={scope} source={source} onOpen={(kind, id) => onOpenSource(kind, id, value.id, index)} />}<details><summary>来源类型与准确引用</summary><code>{source.kind} · {source.ref}</code></details>{!source.excerpt && <p className="sw-muted">没有单列摘录；可据标题和引用位置核对原材料。</p>}</li>)}</ol> : <p className="sw-muted">这份修订没有单列来源；正文中的依据请按原文阅读。</p>}</details><div className="sw-understanding-provenance"><p>声明作者：{value.authorship.kind === 'agent' ? 'Agent' : '人'} · {value.authorship.name}{value.authorship.sessionId ? ` · 会话 ${value.authorship.sessionId}` : ''}</p><p>系统记录保存者：{value.recordedBy} · {new Date(value.createdAt).toLocaleString()}</p><p>本次修订：{value.changeReason || '未记录原因'}</p>{value.previousRevisionId && <button className="sw-link" onClick={() => goRevision(value.previousRevisionId!)}>阅读上一修订</button>}<details><summary>准确身份</summary><code>修订 {value.id} · 资产 {value.assetId} · 内容 hash {value.payloadHash}{value.previousRevisionId ? ` · 前驱 ${value.previousRevisionId}` : ''}</code></details></div></>}
    <section className="sw-understanding-history"><h3>修订历史</h3>{history.error && <div className="sw-notice" role="alert"><p>{failure(history.error)}</p><button onClick={() => void history.refetch()}>重试</button></div>}{!history.error && !revisions.length && <p className="sw-muted">{history.isPending ? '正在读取修订历史…' : '尚无修订。'}</p>}{revisions.map(revision => <button key={revision.id} className={`sw-understanding-revision${revision.id === value?.id ? ' active' : ''}`} onClick={() => goRevision(revision.id === current.data?.id ? undefined : revision.id)}><span><strong>修订 {revision.revision} · {revision.title}</strong><small>{revision.changeReason || '未记录原因'} · {new Date(revision.createdAt).toLocaleString()}</small></span><span>{revision.id === current.data?.id ? '当前' : '阅读'}</span></button>)}{history.hasNextPage && <button className="sw-more" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>加载更多修订</button>}</section>
  </section>;
}
