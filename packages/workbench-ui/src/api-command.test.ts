import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpaceApi } from './api.js';

const receipt = { requestId: 'req-1', planId: 'plan-1', entryId: 'entry-1', attempt: 1, runId: 'run-1', caseId: 'case-1', versionId: 'version-1', inputManifestId: 'manifest-1', inputManifestHash: 'hash-1', status: 'queued', dispatched: false, dispatchError: null };

describe('plan commands', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends only the frozen manifest ID when starting the exact first attempt', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').startPlanEntry('plan-1', 'entry-1', 1, 'manifest-1', 'csrf-token');
    expect(result.runId).toBe('run-1');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workflow-spaces/v1/spaces/space-1/validation-plans/plan-1/entries/entry-1/attempts/1/start');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('same-origin');
    expect(options.headers).toMatchObject({ 'x-space-csrf': 'csrf-token' });
    expect(JSON.parse(String(options.body))).toEqual({ inputManifestId: 'manifest-1' });
  });

  it('targets only the saved run for explicit recovery and rejects missing CSRF before fetch', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    await api.dispatchPlanRun('plan-1', 'entry-1', 1, 'run-1', 'csrf-token');
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/attempts/1/runs/run-1/dispatch');
    expect(JSON.parse(String(options.body))).toEqual({});
    await expect(api.startPlanEntry('plan-1', 'entry-1', 1, 'manifest-1', '')).rejects.toThrow('未开放');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('ordinary business commands', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ordinaryReceipt = { requestId: 'req-2', runId: 'run-2', caseId: 'case-2', versionId: 'version-2', inputManifestId: 'manifest-2', inputManifestHash: 'hash-2', status: 'queued', dispatched: false, dispatchError: null };

  it('prepares without a validation plan and starts an exact frozen case', async () => {
    const preparation = { caseId: 'case-2', caseTitle: '新业务', objective: '说明目标', versionId: 'version-2', versionLabel: '方法', inputManifestId: 'manifest-2', inputManifestHash: 'hash-2', inputs: [], sections: [], conditions: [], runs: [], actions: { start: true, dispatch: false, reason: null } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(preparation), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(ordinaryReceipt), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    await api.prepareBusiness('version-2', { goal: '说明目标' }, 'stable-key', 'csrf-token');
    await api.startBusiness('case-2', 'version-2', 'manifest-2', 'start-key', 'csrf-token');
    expect(fetcher.mock.calls[0][0]).toBe('/api/workflow-spaces/v1/spaces/space-1/business/preparations');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ key: 'stable-key', versionId: 'version-2', values: { goal: '说明目标' } });
    expect(fetcher.mock.calls[1][0]).toBe('/api/workflow-spaces/v1/spaces/space-1/cases/case-2/runs');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ versionId: 'version-2', inputManifestId: 'manifest-2', key: 'start-key' });
  });

  it('dispatches only the named queued run and posts a declared external note', async () => {
    const note = { id: 'note-1', caseId: 'case-2', runId: 'run-2', subjectAssetId: 'asset-2', createdAt: '2026-10-07', importedBy: 'operator', verification: 'declared-external', author: { kind: 'external-agent', name: 'Agent', threadId: 'thread-1' }, answers: { good: '', bad: '', improvement: '', unresolved: '' }, recommendation: 'needs_revision', nextStep: '修改', referencedAssetIds: [] };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(ordinaryReceipt), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(note), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    await api.dispatchBusiness('case-2', 'run-2', 'version-2', 'manifest-2', 'csrf-token');
    await api.addHandlingNote('run-2', 'asset-2', { key: 'note-key', author: note.author as typeof note.author & { kind: 'external-agent' }, answers: note.answers, recommendation: 'needs_revision', nextStep: '修改', referencedAssetIds: [] }, 'csrf-token');
    expect(fetcher.mock.calls[0][0]).toBe('/api/workflow-spaces/v1/spaces/space-1/cases/case-2/runs/run-2/dispatch');
    expect(fetcher.mock.calls[1][0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-2/assets/asset-2/handling-notes');
    expect(JSON.parse(fetcher.mock.calls[1][1].body).author).toEqual({ kind: 'external-agent', name: 'Agent', threadId: 'thread-1' });
  });

  it('reads the bounded handling-note list and preserves the truncation signal', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [], truncated: true, nextCursor: null, snapshotAt: '2026-10-07T00:00:00Z' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').handlingNotes('run-2', 'asset-2');
    expect(result.truncated).toBe(true);
    expect(result.items).toEqual([]);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-2/assets/asset-2/handling-notes');
  });
});
