import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { SpaceApi, SpaceApiError } from './api.js';
import { UnderstandingSourceEditor, businessChapterLabel, draftFromRevision, mayEditUnderstanding, refreshUnderstandingHead, renderBusinessDocument, renderUnderstandingMarkdown, resolvableBusinessSource, understandingAuthorshipForSave, understandingHeadChanged, understandingRelationSummary } from './understanding.js';
import { readSelection, writeSelection } from './selection.js';

const revision = { id: 'revision-2', assetId: 'asset-1', revision: 2, payloadHash: 'hash-2', createdAt: '2026-10-09T00:00:00Z', previousRevisionId: 'revision-1', changeReason: '补充未知', title: '业务理解', content: '# 问题\n仍需核对', sources: [{ kind: 'document' as const, ref: 'docs/a.md', title: '材料' }], authorship: { kind: 'agent', name: 'Agent', sessionId: 'session-1' }, recordedBy: 'operator-1', confirmation: 'unconfirmed' };

describe('business understanding', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders Markdown without executing raw HTML or unsafe links', () => {
    const html = renderUnderstandingMarkdown('# 业务理解\n<script>alert(1)</script>\n[unsafe](javascript:alert(1))');
    expect(html).toContain('<h1>业务理解</h1>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });

  it('locates real chapters, the original diagram and numbered sources without nesting links or exposing local paths as links', () => {
    const content = '## 目标\n依据 S1、S2。\n\n## 周期\n[![周期图](https://example.test/cycle.svg)](https://example.test/cycle.html)\n\n[已有 S1 链接](https://example.test/source)\n\n`S1`';
    const result = renderBusinessDocument(content, [{ kind: 'document', title: 'S1 · 原始要求', ref: '/private/source.md', excerpt: '读者目标' }]);
    expect(result.chapters).toEqual([{ id: 'business-chapter-1', title: '目标' }, { id: 'business-chapter-2', title: '周期' }]);
    expect(result.diagram).toBe(true);
    expect(result.html).toContain('id="business-diagram"');
    expect(result.html).toContain('href="#business-source-S1"');
    expect(result.html).not.toContain('href="#business-source-S2"');
    expect(result.html).toContain('<a href="https://example.test/source">已有 S1 链接</a>');
    expect(result.html).toContain('<code>S1</code>');
    expect(result.html).not.toContain('href="/private/source.md"');
  });

  it('shortens only the five known business chapters while keeping unknown headings truthful', () => {
    expect(['我们希望这项创作业务做到什么', '从创作者视角，完整流程及产物是什么', '我们创作时坚持什么，为什么', '怎样验收目标是否达成', '这些认识怎样随真实创作进化'].map(businessChapterLabel)).toEqual(['目标', '阶段与产物', '原则', '验收', '进化']);
    expect(businessChapterLabel('新的业务章节')).toBe('新的业务章节');
  });

  it('summarizes the actual three different bases without inferring a missing version', () => {
    expect(understandingRelationSummary(5, 4, 4, 2, 1)).toBe('当前理解 5；草案 4 依据理解 4；准确版设计 2 依据理解 1');
    expect(understandingRelationSummary(5, 4, 4, undefined, undefined, false)).toBe('当前理解 5；草案 4 依据理解 4');
  });

  it('folds an existing source under a human title and excerpt while retaining every editable field', () => {
    const source = { kind: 'document' as const, ref: '/private/source.md', title: 'S1 · 创作者目标', excerpt: '读者应理解完整过程。' };
    const html = renderToStaticMarkup(createElement(UnderstandingSourceEditor, { source, index: 0, onChange: vi.fn(), onRemove: vi.fn() }));
    expect(html).toContain('<details class="sw-understanding-source-row"><summary><strong>S1 · 创作者目标</strong>');
    expect(html).toContain('读者应理解完整过程。');
    expect(html).not.toContain('<details class="sw-understanding-source-row" open');
    expect(html).toContain('value="/private/source.md"');
    expect(html).toContain('value="S1 · 创作者目标"');
    expect(html).toContain('>读者应理解完整过程。</textarea>');
  });

  it('accepts only an exact bare asset or Case ID and keeps inaccessible Space objects unreadable', async () => {
    const assetSource = { kind: 'asset' as const, ref: 'f073af51-0bb8-43b8-b9f1-b3f770cfa8e8', title: 'S16 · 研究资产' };
    const caseSource = { kind: 'case' as const, ref: 'content-business-f3890b7e260cd8a0499e3eb8e3d6dd51', title: 'S17 · 案例' };
    expect(resolvableBusinessSource(assetSource)).toEqual({ kind: 'asset', id: assetSource.ref });
    expect(resolvableBusinessSource(caseSource)).toEqual({ kind: 'case', id: caseSource.ref });
    expect(resolvableBusinessSource({ ...assetSource, ref: '/local/assets/' + assetSource.ref })).toBeNull();
    expect(resolvableBusinessSource({ ...caseSource, ref: 'https://example.test/cases/' + caseSource.ref })).toBeNull();
    expect(resolvableBusinessSource({ ...assetSource, ref: '' })).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not in this Space', requestId: 'r1' } }), { status: 404 })));
    const api = new SpaceApi('/api/workflow-spaces/v1', 'another-space');
    await expect(api.reading(assetSource.ref)).rejects.toMatchObject({ status: 404 });
    await expect(api.case(caseSource.ref)).rejects.toMatchObject({ status: 404 });
    const fetcher = vi.mocked(fetch);
    expect((fetcher.mock.calls[0] as [string])[0]).toContain('/spaces/another-space/assets/');
    expect((fetcher.mock.calls[1] as [string])[0]).toContain('/spaces/another-space/cases/');
  });

  it('restores a selected historical revision from the URL', () => {
    const selected = readSelection(new URLSearchParams('view=goal&understandingRevision=revision-1'));
    expect(selected.understandingRevision).toBe('revision-1');
    expect(readSelection(writeSelection(new URLSearchParams(), selected)).understandingRevision).toBe('revision-1');
  });

  it('refreshes cached current understanding and history when the summary head advances without replacing an exact historical selection', async () => {
    expect(understandingHeadChanged(null, 'revision-2')).toBe(true);
    expect(understandingHeadChanged('revision-1', 'revision-2')).toBe(true);
    expect(understandingHeadChanged('revision-2', 'revision-2')).toBe(false);
    expect(understandingHeadChanged(undefined, undefined)).toBe(false);
    const client = new QueryClient();
    const root = '/api/workflow-spaces/v1/spaces/space-1';
    const prefix = ['space', 'agent:session', root, 'understanding'];
    const currentKey = [...prefix, 'current'];
    const revisionsKey = [...prefix, 'revisions'];
    const historicalKey = [...prefix, 'revision-1'];
    client.setQueryData(currentKey, null);
    client.setQueryData(revisionsKey, { pages: [{ items: [] }] });
    client.setQueryData(historicalKey, revision);
    const selected = readSelection(new URLSearchParams('view=goal&understandingRevision=revision-1'));
    await refreshUnderstandingHead(client, 'agent:session', root);
    expect(client.getQueryState(currentKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(revisionsKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(historicalKey)?.isInvalidated).toBe(false);
    expect(client.getQueryData(historicalKey)).toEqual(revision);
    expect(selected.understandingRevision).toBe('revision-1');
  });

  it('attributes a new human edit to the active principal and retains the draft after head movement', () => {
    const draft = draftFromRevision(revision as Parameters<typeof draftFromRevision>[0], 'operator-2');
    expect(draft.authorship).toEqual({ kind: 'human', name: 'operator-2' });
    expect(draft.content).toBe(revision.content);
    expect(mayEditUnderstanding(true, 'csrf-1', true, false, null)).toBe(true);
    expect(mayEditUnderstanding(true, 'csrf-1', false, false, null)).toBe(false);
  });

  it('pins a trusted design Agent edit to its credential identity instead of editable draft attribution', () => {
    const draft = draftFromRevision(revision as Parameters<typeof draftFromRevision>[0], 'operator-2');
    expect(understandingAuthorshipForSave(draft, { id: 'design-agent', sessionId: 'outer-session' }, true)).toEqual({ kind: 'agent', name: 'design-agent', sessionId: 'outer-session' });
    expect(understandingAuthorshipForSave(draft, undefined, true)).toEqual({ kind: 'human', name: 'operator-2' });
  });

  it('reads current and exact historical revisions, then saves with CSRF and expected revision', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(revision), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    expect((await api.understanding()).id).toBe('revision-2');
    expect((await api.understanding('revision-1')).id).toBe('revision-2');
    await api.saveUnderstanding({ expectedRevisionId: 'revision-1', title: revision.title, content: revision.content, sources: revision.sources, authorship: revision.authorship as typeof revision.authorship & { kind: 'agent' }, changeReason: revision.changeReason, idempotencyKey: 'key-1' }, 'csrf-1');
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/understanding');
    expect((fetcher.mock.calls[1] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/understanding?revision=revision-1');
    const [url, options] = fetcher.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workflow-spaces/v1/spaces/space-1/understanding/revisions');
    expect(options.headers).toMatchObject({ 'x-space-csrf': 'csrf-1' });
    expect(JSON.parse(String(options.body))).toMatchObject({ expectedRevisionId: 'revision-1', idempotencyKey: 'key-1' });
  });

  it('reads the revision history as bounded records', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [revision], nextCursor: null, snapshotAt: '2026-10-09T00:00:00Z' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').understandingRevisions();
    expect(result.items[0].id).toBe('revision-2');
    expect(result.nextCursor).toBeNull();
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/understanding/revisions');
  });

  it('surfaces concurrent-write conflicts without treating them as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'CONFLICT', message: '已出现新修订', requestId: 'req-1' } }), { status: 409 })));
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    await expect(api.saveUnderstanding({ expectedRevisionId: 'revision-1', title: 'A', content: 'B', sources: [], authorship: { kind: 'human', name: 'operator' }, changeReason: '更正', idempotencyKey: 'key-1' }, 'csrf-1')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' } satisfies Partial<SpaceApiError>);
  });
});
