import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CaseFrozenInputsDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { CaseFrozenInputs, chosenCaseManifest } from './case-frozen-inputs.js';

const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
const scope = 'subject:reader';
const asset = {
  id: 'asset-opportunity-v1', title: '已保存的原始机会', kind: 'opportunity', state: 'published', createdAt: '2026-10-11T00:00:00.000Z',
  schema: { namespace: 'business.opportunity', revision: '1', hash: 'schema-hash' }, sourceKind: 'import' as const,
  runId: null, caseId: 'case-1', versionId: null, nodeId: null, occurrenceId: null, round: null,
};
const first = { id: 'manifest-a', hash: 'hash-a', slots: [{ slot: 'opportunity', asset, payloadHash: 'payload-a', readingUrl: '/api/workflow-spaces/v1/spaces/space-1/assets/asset-opportunity-v1/reading' }] };
const second = { id: 'manifest-z', hash: 'hash-z', slots: [{ slot: 'materials', asset: { ...asset, id: 'asset-materials-v2', title: '已保存的完整材料' }, payloadHash: 'payload-z', readingUrl: '/api/workflow-spaces/v1/spaces/space-1/assets/asset-materials-v2/reading' }] };
const response = (manifests: CaseFrozenInputsDto['manifests'], hasMore = false): CaseFrozenInputsDto => ({ caseId: 'case-1', manifests, hasMore, nextCursor: hasMore ? 'manifest-a' : null, snapshotAt: '2026-10-11T00:00:00.000Z' });

function renderInputs(manifests: CaseFrozenInputsDto['manifests'], url = '/?view=business&case=case-1', hasMore = false): string {
  const client = new QueryClient();
  client.setQueryData(['space', scope, api.root, 'case-frozen-inputs', 'case-1'], { pages: [response(manifests, hasMore)], pageParams: [undefined] });
  return renderToString(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: [url] }, createElement(CaseFrozenInputs, { api, scope, caseId: 'case-1', runCount: 0, onAsset: () => {} }))));
}

function renderWithClient(client: QueryClient, url: string): string {
  return renderToString(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: [url] }, createElement(CaseFrozenInputs, { api, scope, caseId: 'case-1', runCount: 0, onAsset: () => {} }))));
}

afterEach(() => vi.unstubAllGlobals());

describe('Case-owned frozen inputs before a run', () => {
  it('opens the only saved manifest and links exact source asset versions to the existing reader', () => {
    const html = renderInputs([first]);
    expect(html).toContain('已冻结输入、尚未运行');
    expect(html).toContain('manifest-a');
    expect(html).toContain('hash-a');
    expect(html).toContain('<strong>已保存的原始机会</strong>');
    expect(html.replaceAll('<!-- -->', '')).toContain('输入项：opportunity');
    expect(html).toContain('asset-opportunity-v1');
    expect(html).toContain('payload-a');
    expect(html).not.toContain('本案例尚无运行；尚无本次冻结输入');
  });

  it('does not silently treat ID sorting as the latest freeze for a Case with several manifests', () => {
    expect(chosenCaseManifest(null, [first, second], false)).toBeUndefined();
    expect(chosenCaseManifest(null, [first], true)).toBeUndefined();
    const unselected = renderInputs([first, second]);
    expect(unselected).toContain('请选择准确清单');
    expect(unselected).not.toContain('<h4>已保存的输入</h4>');
    const selected = renderInputs([first, second], '/?view=business&case=case-1&caseManifest=manifest-z');
    expect(selected).toContain('<h4>已保存的输入</h4>');
    expect(selected).toContain('hash-z');
    expect(selected).toContain('已保存的完整材料');
    expect(selected.split('<details class="sw-case-manifest-provenance">')[0]).not.toContain('payload-a');
  });

  it('keeps complete identities and hashes in one expandable provenance area while showing readable assets first', () => {
    const longId = 'a'.repeat(64);
    const longHash = 'b'.repeat(64);
    const html = renderInputs([{ ...first, id: longId, hash: longHash }]);
    const details = html.indexOf('<details class="sw-case-manifest-provenance">');
    expect(details).toBeGreaterThan(0);
    expect(html.slice(0, details)).toContain('已保存的原始机会');
    expect(html.slice(0, details)).not.toContain(longId);
    expect(html.slice(0, details)).not.toContain(longHash);
    expect(html.slice(details)).toContain(longId);
    expect(html.slice(details)).toContain(longHash);
    expect(html.slice(details)).toContain('schema-hash');
    expect(html.slice(details)).toContain('/assets/asset-opportunity-v1/reading');
  });

  it('offers a retry when the first Case input history read fails', async () => {
    const client = new QueryClient();
    await client.fetchInfiniteQuery({
      queryKey: ['space', scope, api.root, 'case-frozen-inputs', 'case-1'],
      queryFn: async () => { throw new Error('读取中断'); },
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
      retry: false,
    }).catch(() => {});
    const html = renderWithClient(client, '/?view=business&case=case-1');
    expect(html).toContain('不能据此判断案例没有输入');
    expect(html).toContain('重新读取案例冻结输入');
    expect(html).not.toContain('此案例未保存可读取的冻结输入清单');
  });

  it('keeps loading distinct from an empty Case and reads an exact manifest outside the first page', () => {
    const url = '/?view=business&case=case-1&caseManifest=manifest-z';
    const loading = renderWithClient(new QueryClient(), url);
    expect(loading).toContain('正在核对案例是否已有冻结输入');
    expect(loading).not.toContain('未保存可读取的冻结输入清单');
    const client = new QueryClient();
    client.setQueryData(['space', scope, api.root, 'case-frozen-inputs', 'case-1'], { pages: [response([first], true)], pageParams: [undefined] });
    client.setQueryData(['space', scope, api.root, 'case-frozen-input', 'case-1', 'manifest-z'], response([second]));
    const exact = renderWithClient(client, url);
    expect(exact).toContain('已保存的完整材料');
    expect(exact).toContain('hash-z');
    expect(exact.split('<details class="sw-case-manifest-provenance">')[0]).not.toContain('payload-a');
  });

  it('sends an exact manifest ID or pagination cursor to the Case-scoped read endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => response([first]) });
    vi.stubGlobal('fetch', fetcher);
    await api.caseFrozenInputs('case-1', { manifestId: 'manifest/a' });
    await api.caseFrozenInputs('case-1', { after: 'cursor/z' });
    const exactUrl = new URL(fetcher.mock.calls[0]![0], 'http://localhost');
    const pageUrl = new URL(fetcher.mock.calls[1]![0], 'http://localhost');
    expect(exactUrl.pathname).toBe('/api/workflow-spaces/v1/spaces/space-1/cases/case-1/inputs');
    expect(exactUrl.searchParams.get('manifestId')).toBe('manifest/a');
    expect(pageUrl.searchParams.get('after')).toBe('cursor/z');
  });
});
