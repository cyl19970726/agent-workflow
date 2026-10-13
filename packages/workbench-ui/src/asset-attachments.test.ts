import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetAttachments } from './asset-attachments.js';
import { SpaceApi } from './api.js';

const item = { id: 'blob-1', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', size: 5, mediaType: 'text/plain' };
afterEach(() => vi.unstubAllGlobals());

describe('exact asset attachment reading', () => {
  it('shows bound metadata without claiming bytes are ready', () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const client = new QueryClient();
    client.setQueryData(['space', 'principal:scope', api.root, 'asset-attachments', 'asset-version-2'], { assetVersionId: 'asset-version-2', assetId: 'asset-1', version: 2, items: [item] });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AssetAttachments, { api, scope: 'principal:scope', assetVersionId: 'asset-version-2' })));
    expect(html).toContain('SHA-256');
    expect(html).toContain('核对并读取附件');
    expect(html).not.toContain('下载已核对附件');
    const wrong = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AssetAttachments, { api, scope: 'principal:scope', assetVersionId: 'asset-version-3' })));
    expect(wrong).not.toContain('blob-1');
    client.setQueryData(['space', 'principal:scope', api.root, 'asset-attachments', 'asset-version-3'], { assetVersionId: 'asset-version-2', assetId: 'asset-1', version: 2, items: [item] });
    const mismatched = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AssetAttachments, { api, scope: 'principal:scope', assetVersionId: 'asset-version-3' })));
    expect(mismatched).toContain('资产版本不一致');
    expect(mismatched).not.toContain('核对并读取附件');
  });
  it('requests only the scoped asset/blob route and rejects a mismatched response header', async () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(new TextEncoder().encode('hello'), { status: 200, headers: { 'x-content-sha256': '0'.repeat(64), 'content-length': '5' } });
    }));
    await expect(api.attachmentContent('asset-version-2', item)).rejects.toThrow('校验值');
    expect(calls).toEqual(['/api/workflow-spaces/v1/spaces/space-1/assets/asset-version-2/attachments/blob-1/content']);
  });
  it('keeps a missing or unavailable blob as a read error', async () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'BLOB_UNAVAILABLE', message: 'Blob storage unavailable', requestId: 'req-1' } }), { status: 405, headers: { 'content-type': 'application/json' } })));
    await expect(api.attachmentContent('asset-version-2', item)).rejects.toMatchObject({ status: 405, code: 'BLOB_UNAVAILABLE' });
  });
});
