import { describe, expect, it, vi } from 'vitest';
import { inspectSpace } from './operator.js';
import type { WorkflowSpaceService } from './service.js';

describe('trusted space operator inspection', () => {
  it('pages exact workflow event types without dropping their source cursor', async () => {
    const listEvents = vi.fn(async () => [{seq:3,type:'agent.trace'}, {seq:4,type:'harness.recovery_patch'}, {seq:8,type:'harness.recovery_patch'}]);
    const service = { overview: async () => ({runs:[{runId:'run-a'}]}), runtimeLedger: async () => ({listEvents}) } as unknown as WorkflowSpaceService;
    expect(await inspectSpace(service,'space-a',{kind:'events',runId:'run-a',after:2,limit:1,type:'harness.recovery_patch'}))
      .toEqual({items:[{seq:4,type:'harness.recovery_patch'}],nextCursor:4,hasMore:true});
    expect(listEvents).toHaveBeenCalledWith('run-a',2);
    await expect(inspectSpace(service,'space-a',{kind:'events',runId:'run-a',limit:0})).rejects.toThrow('page size');
  });
  it('refuses a run outside the authorized space before reading its record', async () => {
    const getRun = vi.fn();
    const service = { overview: async () => ({ runs: [] }), runtimeLedger: async () => ({ getRun }) };
    await expect(inspectSpace(service as unknown as WorkflowSpaceService, 'space-a',
      { kind: 'run', runId: 'private-run-b' })).rejects.toThrow('authorized workflow space');
    expect(getRun).not.toHaveBeenCalled();
  });

  it('preserves session pagination and delegates identity checks to the scoped service', async () => {
    const sessionEvents = vi.fn(async () => ({ items: [{ seq: 11 }], nextCursor: 11, hasMore: true }));
    const service = { sessionEvents } as unknown as WorkflowSpaceService;
    expect(await inspectSpace(service, 'space-a', { kind: 'session', sessionId: 'session-a', after: 10, limit: 1 }))
      .toEqual({ items: [{ seq: 11 }], nextCursor: 11, hasMore: true });
    expect(sessionEvents).toHaveBeenCalledWith('space-a', 'session-a', 10, 1);
  });

  it('keeps asset bodies out of the summary and exposes them only through explicit asset reads', async () => {
    const overview = { space: { id: 'space-a' }, workflows: [], cases: [], runs: [],
      assets: [{ id: 'asset-a', payload: { privateDraft: 'full manuscript' }, payloadHash: 'digest' }],
      reviews: [], comparisons: [], iterations: [], adoptions: [], sessions: [], knowledge: [] };
    const service = { overview: async () => overview, runtimeLedger: async () => ({}),
      readAsset: async () => overview.assets[0] } as unknown as WorkflowSpaceService;
    const summary = await inspectSpace(service, 'space-a', { kind: 'summary' });
    expect(JSON.stringify(summary)).not.toContain('full manuscript');
    expect(await inspectSpace(service, 'space-a', { kind: 'asset', assetVersionId: 'asset-a' }))
      .toEqual(overview.assets[0]);
  });
});

it('dispatches process and bounded neighborhood without a Space-wide overview',async()=>{
 const process=vi.fn(async()=>({occurrences:[]})),assetNeighborhood=vi.fn(async()=>({items:[],hasMore:false,nextCursor:3}));
 const service={process,assetNeighborhood} as unknown as WorkflowSpaceService;
 await inspectSpace(service,'space',{kind:'process',runId:'run'});
 await inspectSpace(service,'space',{kind:'neighborhood',assetVersionId:'asset',runId:'run',cursor:2,limit:1});
 expect(process).toHaveBeenCalledWith('space','run');expect(assetNeighborhood).toHaveBeenCalledWith('space','asset',{kind:'neighborhood',assetVersionId:'asset',runId:'run',cursor:2,limit:1});
});
