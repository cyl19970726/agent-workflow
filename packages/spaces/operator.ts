import type { WorkflowSpaceService } from './service.js';

export type SpaceInspection =
  | { kind: 'summary' }
  | { kind: 'validation-plans' }
  | { kind: 'validation'; planId:string }
  | { kind: 'run'; runId: string }
  | { kind: 'process'; runId: string }
  | { kind: 'neighborhood'; assetVersionId: string; runId?: string; cursor?: number; limit?: number }
  | { kind: 'events'; runId: string; after?: number; limit?: number; type?: string }
  | { kind: 'asset'; assetVersionId: string }
  | { kind: 'context'; contextId: string }
  | { kind: 'session'; sessionId: string; after?: number; limit?: number };

/** Trusted operator reads. This is not a capability to inject into an execution node. */
export async function inspectSpace(service: WorkflowSpaceService, spaceId: string, query: SpaceInspection): Promise<unknown> {
  if (query.kind === 'validation-plans') return service.validationPlans(spaceId);
  if (query.kind === 'validation') return service.validationSummary(spaceId,query.planId);
  if (query.kind === 'process') return service.process(spaceId, query.runId);
  if (query.kind === 'neighborhood') return service.assetNeighborhood(spaceId,query.assetVersionId,query);
  if (query.kind === 'asset') return service.readAsset(spaceId, query.assetVersionId);
  if (query.kind === 'context') return service.readContext(spaceId, query.contextId);
  if (query.kind === 'session') return service.sessionEvents(spaceId, query.sessionId, query.after, query.limit);
  const overview = await service.overview(spaceId);
  const ledger = await service.runtimeLedger(spaceId);
  if (query.kind === 'summary') return {
    space: overview.space, workflows: overview.workflows, cases: overview.cases,
    runs: await Promise.all(overview.runs.map(async binding => ({ ...binding, record: await ledger.getRun(binding.runId) }))),
    assets: overview.assets.map(({ payload: _payload, ...asset }) => asset),
    reviews: overview.reviews, comparisons: overview.comparisons, iterations: overview.iterations,
    adoptions: overview.adoptions, sessions: overview.sessions, knowledge: overview.knowledge,
  };
  const binding = overview.runs.find(run => run.runId === query.runId);
  if (!binding) throw new Error('Run is not in the authorized workflow space');
  if (query.kind === 'events') {
    const after = query.after ?? 0, limit = query.limit ?? 100;
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid event cursor or page size');
    }
    const events = (await ledger.listEvents(query.runId, after)).filter(event => !query.type || event.type === query.type);
    const items = events.slice(0, limit);
    return { items, nextCursor: items.at(-1)?.seq ?? after, hasMore: events.length > limit };
  }
  return {
    binding, record: await ledger.getRun(query.runId), inputManifest: await service.readManifest(spaceId, binding.inputManifestId),
    steps: await ledger.listSteps(query.runId), contexts: await service.runtimeContexts(spaceId, query.runId),
    assets: overview.assets.filter(asset => asset.source.kind === 'node' && asset.source.runId === query.runId),
    reviews: overview.reviews.filter(review => review.runId === query.runId),
  };
}
