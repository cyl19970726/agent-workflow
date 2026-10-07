import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AssetSummaryDto } from '@signal-room/workflow-space-api/contracts';
import { HandlingNotes } from './handling-notes.js';
import { SpaceApi, SpaceApiError } from './api.js';

const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
const scope = 'subject:scope';
const asset: AssetSummaryDto = { id: 'draft-1', title: '过程稿', kind: 'draft', state: 'candidate', createdAt: '2026-10-07T00:00:00Z', schema: { namespace: 'example/draft', revision: '1', hash: 'hash' }, sourceKind: 'node', runId: 'run-1', caseId: 'case-1', versionId: 'version-1', nodeId: 'author', occurrenceId: 'round-1', round: 1 };
const noteKey = ['space', scope, api.root, 'handling-notes', 'run-1', 'draft-1'];
const runKey = ['space', scope, api.root, 'handling-run', 'run-1'];

function view(client: QueryClient, selectedAsset = asset): string {
  return renderToString(createElement(QueryClientProvider, { client }, createElement(HandlingNotes, { api, scope, asset: selectedAsset, referencedAssets: [], csrfToken: 'csrf', writable: true, chooseAsset: () => {} })));
}

describe('handling-note eligibility presentation', () => {
  it('does not show a submit entry while eligibility is being checked', () => {
    const html = view(new QueryClient());
    expect(html).toContain('正在确认此资产的处理建议入口');
    expect(html).not.toContain('记录外部 Agent 建议');
  });

  it('hides the note area after an inapplicable asset returns 404', async () => {
    const client = new QueryClient();
    await expect(client.fetchQuery({ queryKey: noteKey, queryFn: () => Promise.reject(new SpaceApiError('NOT_FOUND', '此资产没有入口', 404)), retry: false })).rejects.toThrow();
    expect(view(client)).toBe('');
  });

  it('shows a real read error without offering the form', async () => {
    const client = new QueryClient();
    await expect(client.fetchQuery({ queryKey: noteKey, queryFn: () => Promise.reject(new SpaceApiError('READ_FAILED', '暂时无法读取', 500)), retry: false })).rejects.toThrow();
    const html = view(client);
    expect(html).toContain('处理建议暂不可读');
    expect(html).toContain('暂时无法读取');
    expect(html).not.toContain('记录外部 Agent 建议');
  });

  it('waits for the exact run state before enabling an otherwise eligible form', () => {
    const client = new QueryClient();
    client.setQueryData(noteKey, { items: [], truncated: false, nextCursor: null, snapshotAt: '2026-10-07T00:00:00Z' });
    const html = view(client);
    expect(html).toContain('正在读取这份稿件的运行状态');
    expect(html).not.toContain('记录外部 Agent 建议');
  });

  it('shows an eligible failed-run process draft without calling it final or accepted', () => {
    const client = new QueryClient();
    client.setQueryData(noteKey, { items: [], truncated: false, nextCursor: null, snapshotAt: '2026-10-07T00:00:00Z' });
    client.setQueryData(runKey, { id: 'run-1', state: 'failed', primaryAssetId: null });
    const html = view(client);
    expect(html).toContain('过程稿');
    expect(html).toContain('运行仍为失败');
    expect(html).toContain('尚未形成最终稿');
    expect(html).toContain('记录外部 Agent 建议');
  });

  it('never offers notes for imported assets', () => {
    expect(view(new QueryClient(), { ...asset, sourceKind: 'import' })).toBe('');
  });
});
