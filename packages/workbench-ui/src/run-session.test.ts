import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpaceApi } from './api.js';
import { terminalFailureLabel } from './workbench.js';

describe('bounded run session reading', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests only the exact run and session, then advances with the saved cursor', async () => {
    const first = { runId: 'run-1', sessionId: 'session/1', items: [{ id: 'event-1', seq: 1, attemptId: 'attempt-1', kind: 'tool', body: { result: 'saved' }, createdAt: '2026-10-09T00:00:00Z' }], nextCursor: 1, hasMore: true, snapshotAt: '2026-10-09T00:00:00Z' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(first), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ ...first, items: [], hasMore: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const page = await api.runSessionEvents('run-1', 'session/1');
    expect(page.items[0].kind).toBe('tool');
    await api.runSessionEvents('run-1', 'session/1', page.nextCursor);
    expect((fetcher.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/sessions/session%2F1/events?after=0&limit=50');
    expect((fetcher.mock.calls[1] as [string, RequestInit])[0]).toContain('after=1&limit=50');
  });

  it('reads exact frozen input slots and payload hashes for the selected run', async () => {
    const asset = { id: 'asset-1', title: '业务机会', kind: 'input', state: 'ready', createdAt: '2026-10-09T00:00:00Z', schema: { namespace: 'creation/content-opportunity', revision: '1', hash: 'schema-hash' }, sourceKind: 'import', runId: null, caseId: 'case-1', versionId: null, nodeId: null, occurrenceId: null, round: null };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ runId: 'run-1', caseId: 'case-1', versionId: 'version-1', inputManifestId: 'manifest-1', inputManifestHash: 'manifest-hash', slots: [{ slot: 'opportunity', asset, payloadHash: 'payload-hash' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').runInputs('run-1');
    expect(result.slots[0]).toMatchObject({ slot: 'opportunity', payloadHash: 'payload-hash' });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/inputs');
  });

  it('reads the saved unpublished response with full event provenance', async () => {
    const response = { runId: 'run-1', occurrenceId: 'author-1', responses: [{ stepRunId: 'step-1', attemptId: 'attempt-1', sessionId: 'session-1', eventId: 'event-2', eventSeq: 7, publication: 'unpublished', output: '{"script":"完整响应"}', coverage: 'full', reading: { title: '未发布口播稿', sections: [{ title: '正文', text: '完整响应', view: 'body' }], readerStatus: 'registered', reason: null } }] };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const saved = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').unpublishedResponses('run-1', 'author-1');
    expect(saved.responses[0]).toMatchObject({ publication: 'unpublished', output: '{"script":"完整响应"}', coverage: 'full', eventSeq: 7, reading: { sections: [{ text: '完整响应' }], readerStatus: 'registered' } });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/occurrences/author-1/responses');
    expect(terminalFailureLabel('Citation provenance mismatch', 'publish')).toBe('引用校验失败');
    expect(terminalFailureLabel('Validator failed', 'publish')).toBe('发布或校验失败');
  });
});
