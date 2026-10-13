import { afterEach, describe, expect, it, vi } from 'vitest';
import {ExternalAgentAssetObservationReceiptSchema,type RunDispositionRevisionDto, type RunReviewDto} from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { agentDispositionReviewsMatch, dispositionAuthorLabel, reviewJudgeLabel, standardForSubject, usableAgentAssetObservation, usableAgentObservation } from './run-assessment.js';

const target = { runId: 'run-1', occurrenceId: 'occ-1', stepRunId: 'step-1', attemptId: 'attempt-1', sessionId: 'session-1', eventId: 'event-1', eventSeq: 7, outputHash: 'a'.repeat(64) };
const standard = { id: 'quality', revision: '1', content: '核查稿件是否满足当前目标。' };
const answers = { good: '结构清晰', bad: '引用不足', improvement: '补齐引用', unresolved: '来源可信度未知' };

describe('run assessment API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads an exact unpublished response target and saves a separate human review', async () => {
    const review = { id: 'review-1', spaceId: 'space-1', runId: 'run-1', assetVersionIds: [], responseTarget: target, standard, judge: { kind: 'human', id: 'human-1' }, evidence: [], evidencePointers: ['/script/body'], answers, createdAt: '2026-10-10T00:00:00Z' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ runId: 'run-1', caseId: 'case-1', versionId: 'version-1', standard, subjects: [{ kind: 'response', target, occurrenceLabel: '作者首稿' }], failures: [{ stepRunId: 'step-2', key: 'publish', error: 'Citation mismatch' }] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(review), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const subjects = await api.reviewSubjects('run-1');
    expect(subjects.subjects[0]).toMatchObject({ kind: 'response', target: { eventId: 'event-1', outputHash: 'a'.repeat(64) } });
    const saved = await api.saveRunReview('run-1', { id: 'review-1', runId: 'run-1', assetVersionIds: [], responseTarget: target, standard, judge: { kind: 'human', id: 'human-1' }, evidence: [], evidencePointers: ['/script/body'], answers }, 'csrf-token');
    expect(saved.responseTarget?.outputHash).toBe(target.outputHash);
    expect((fetcher.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/review-subjects');
    expect((fetcher.mock.calls[1] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/reviews');
    expect(JSON.parse((fetcher.mock.calls[1] as [string, RequestInit])[1].body as string)).toMatchObject({ responseTarget: target, judge: { kind: 'human', id: 'human-1' } });
  });

  it('saves a record-only disposition revision with its exact review and response evidence', async () => {
    const input = { runId: 'run-1', reviewIds: ['review-1'], action: 'revise' as const, reason: '引用缺失', unknowns: ['来源可信度'], evidenceRefs: [{ kind: 'response' as const, target }], expectedRevisionId: null, idempotencyKey: 'request-1' };
    const revision = { ...input, id: 'disposition-1', assetId: 'asset-1', revision: 1, payloadHash: 'hash-1', createdAt: '2026-10-10T00:00:00Z', previousRevisionId: null, author: { kind: 'human', id: 'human-1' }, recordedBy: 'human-1', confirmation: 'unconfirmed' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(revision), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const saved = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').saveRunDisposition('run-1', input, 'csrf-token');
    expect(saved).toMatchObject({ action: 'revise', confirmation: 'unconfirmed', reviewIds: ['review-1'], evidenceRefs: [{ kind: 'response', target }] });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/dispositions');
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ idempotencyKey: 'request-1', expectedRevisionId: null });
  });

  it('reopens exact saved records through run-scoped URLs', async () => {
    const review = { id: 'review-1', spaceId: 'space-1', runId: 'run-1', assetVersionIds: [], responseTarget: target, standard, judge: { kind: 'human', id: 'human-1' }, evidence: [], answers, createdAt: '2026-10-10T00:00:00Z' };
    const disposition = { id: 'disposition-1', assetId: 'asset-1', runId: 'run-1', revision: 1, payloadHash: 'hash-1', createdAt: '2026-10-10T00:00:00Z', previousRevisionId: null, author: { kind: 'human', id: 'human-1' }, recordedBy: 'human-1', confirmation: 'unconfirmed', reviewIds: ['review-1'], action: 'revise', reason: '引用缺失', unknowns: [], evidenceRefs: [{ kind: 'response', target }] };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(review), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(disposition), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    expect((await api.runReview('run-1', 'review-1')).responseTarget?.eventId).toBe('event-1');
    expect((await api.runDisposition('run-1', 'disposition-1')).reviewIds).toEqual(['review-1']);
    expect((fetcher.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/reviews/review-1');
    expect((fetcher.mock.calls[1] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/dispositions/disposition-1');
  });

  it('requires a matching trusted Agent observation before attributing a review', async () => {
    const agent = { id: 'codex-reviewer', sessionId: 'external-session-1' };
    const receipt = { id: 'receipt-1', assetId: 'observation-1', payloadHash: 'receipt-hash', createdAt: '2026-10-10T00:00:00Z', target, observer: { ...agent, servicePrincipalId: 'trusted-host-1' }, producerNativeSessionId: 'producer-session-1', delivery: 'saved-response-read' as const };
    expect(usableAgentObservation(null, target, agent, 'trusted-host-1')).toBe(false);
    expect(usableAgentObservation(receipt, target, agent, 'trusted-host-1')).toBe(true);
    expect(usableAgentObservation(receipt, { ...target, outputHash: 'b'.repeat(64) }, agent, 'trusted-host-1')).toBe(false);
    expect(usableAgentObservation({ ...receipt, observer: { ...receipt.observer, sessionId: target.sessionId } }, target, { ...agent, sessionId: target.sessionId }, 'trusted-host-1')).toBe(false);
    expect(usableAgentObservation({ ...receipt, observer: { ...receipt.observer, sessionId: receipt.producerNativeSessionId! } }, target, { ...agent, sessionId: receipt.producerNativeSessionId! }, 'trusted-host-1')).toBe(false);
    const observed = { receipt, response: { publication: 'unpublished', output: '{"script":"保存响应"}', coverage: 'full', reading: { title: '保存稿', sections: [{ title: '正文', text: '保存响应', view: 'body' }], readerStatus: 'registered', reason: null } } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(observed), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    expect((await api.observeSavedResponse('run-1', target, 'csrf-token')).receipt.id).toBe('receipt-1');
    expect((await api.reviewObservation('run-1', 'receipt-1')).observer.sessionId).toBe('external-session-1');
    expect((fetcher.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/review-observations');
    expect(JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ target });
    expect((fetcher.mock.calls[1] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/review-observations/receipt-1');
    const savedReview: RunReviewDto = { id: 'review-agent-1', spaceId: 'space-1', runId: 'run-1', assetVersionIds: [], responseTarget: target, observationReceiptId: receipt.id, standard, judge: { kind: 'agent', id: agent.id, sessionId: agent.sessionId }, evidence: [], answers, createdAt: '2026-10-10T00:00:00Z' };
    const savedDisposition: RunDispositionRevisionDto = { id: 'disposition-agent-1', assetId: 'asset-1', runId: 'run-1', revision: 2, payloadHash: 'hash-2', createdAt: '2026-10-10T01:00:00Z', previousRevisionId: 'disposition-1', recordedBy: 'trusted-host-1', author: { kind: 'agent', id: agent.id, sessionId: agent.sessionId, servicePrincipalId: 'trusted-host-1' }, confirmation: 'unconfirmed', reviewIds: [savedReview.id], action: 'defer', reason: '仍需核查', unknowns: ['来源'], evidenceRefs: [{ kind: 'response', target }], observationReceiptId: receipt.id, observationReceiptIds: [receipt.id] };
    expect(reviewJudgeLabel(savedReview)).toContain('受信 Agent codex-reviewer · 会话 external-session-1 · 观察收据 receipt-1');
    expect(dispositionAuthorLabel(savedDisposition)).toContain('受信 Agent codex-reviewer · 会话 external-session-1 · 服务主体 trusted-host-1');
  });

  it('sends the observed receipt and fixed Agent identity with review and record-only disposition', async () => {
    const review = { id: 'review-agent-1', spaceId: 'space-1', runId: 'run-1', assetVersionIds: [], responseTarget: target, observationReceiptId: 'receipt-1', standard, judge: { kind: 'agent' as const, id: 'codex-reviewer', sessionId: 'external-session-1' }, evidence: [], answers, createdAt: '2026-10-10T00:00:00Z' };
    const disposition = { id: 'disposition-agent-1', assetId: 'asset-1', runId: 'run-1', revision: 2, payloadHash: 'hash-2', createdAt: '2026-10-10T01:00:00Z', previousRevisionId: 'disposition-1', recordedBy: 'trusted-host-1', author: { kind: 'agent', id: 'codex-reviewer', sessionId: 'external-session-1', servicePrincipalId: 'trusted-host-1' }, confirmation: 'unconfirmed', reviewIds: [review.id], action: 'defer', reason: '仍需核查', unknowns: ['来源'], evidenceRefs: [{ kind: 'response', target }], observationReceiptId: 'receipt-1' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(review), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(disposition), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    await api.saveRunReview('run-1', { id: review.id, runId: 'run-1', assetVersionIds: [], responseTarget: target, observationReceiptId: 'receipt-1', standard, judge: review.judge, evidence: [], answers }, 'csrf-token');
    await api.saveRunDisposition('run-1', { runId: 'run-1', reviewIds: [review.id], action: 'defer', reason: '仍需核查', unknowns: ['来源'], evidenceRefs: [{ kind: 'response', target }], observationReceiptId: 'receipt-1', expectedRevisionId: 'disposition-1', idempotencyKey: 'key-2' }, 'csrf-token');
    expect(JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({ observationReceiptId: 'receipt-1', judge: { kind: 'agent', id: 'codex-reviewer', sessionId: 'external-session-1' } });
    expect(JSON.parse((fetcher.mock.calls[1] as [string, RequestInit])[1].body as string)).toMatchObject({ observationReceiptId: 'receipt-1', expectedRevisionId: 'disposition-1' });
  });

  it('delivers and reopens an exact published research asset for the trusted Agent', async () => {
    const agent = { id: 'codex-reviewer', sessionId: 'external-session-1' };
    const assetTarget = { runId: 'run-1', assetVersionId: 'research-1', payloadHash: 'c'.repeat(64) };
    const receipt = { id: 'asset-receipt-1', assetId: 'observation-asset-1', payloadHash: 'd'.repeat(64), createdAt: '2026-10-10T00:00:00Z', target: assetTarget, source: { kind: 'node' as const, runId: 'run-1', stepRunId: 'step-research', attemptId: 'attempt-research', nodeId: 'research', producer: 'agent' as const, sessionId: 'producer-session', contextId: 'context-1' }, observer: { ...agent, servicePrincipalId: 'trusted-host-1' }, producerNativeSessionIds: ['producer-session'], delivery: 'published-asset-read' as const };
    expect(usableAgentAssetObservation(null, assetTarget, agent, 'trusted-host-1')).toBe(false);
    expect(usableAgentAssetObservation(receipt, assetTarget, agent, 'trusted-host-1')).toBe(true);
    expect(usableAgentAssetObservation(receipt, { ...assetTarget, payloadHash: 'e'.repeat(64) }, agent, 'trusted-host-1')).toBe(false);
    expect(usableAgentAssetObservation(receipt, assetTarget, agent, 'other-host')).toBe(false);
    expect(usableAgentAssetObservation(receipt, assetTarget, { ...agent, sessionId: 'producer-session' }, 'trusted-host-1')).toBe(false);
    const observed = { receipt, asset: { target: assetTarget, publication: 'published', payload: '{"finding":"保存的研究"}', coverage: 'full', reading: { title: '研究依据', sections: [{ title: '发现', text: '保存的研究', view: 'body' }], readerStatus: 'registered', reason: null } } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(observed), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    expect((await api.observePublishedAsset('run-1', assetTarget, 'csrf-token')).asset.payload).toContain('保存的研究');
    expect((await api.reviewObservation('run-1', receipt.id)).delivery).toBe('published-asset-read');
    expect((fetcher.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/asset-observations');
    expect(JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ target: assetTarget });
  });

  it('accepts an observed historical artifact with explicit source identity',()=>{
    const agent={id:'reviewer',sessionId:'independent'};
    const assetTarget={runId:'run-1',assetVersionId:'version-1',payloadHash:'c'.repeat(64)};
    const receipt={id:'receipt',assetId:'receipt-asset',payloadHash:'d'.repeat(64),createdAt:'2026-10-10T00:00:00Z',
      target:assetTarget,source:{kind:'historical-artifact' as const,runId:'run-1',stepRunId:'step-1',attemptId:'attempt-1',
        artifactId:'original',sourceWorkspaceId:'legacy',originalSha256:'a'.repeat(64),originalUri:'artifact://original'},
      observer:{...agent,servicePrincipalId:'trusted'},producerNativeSessionIds:[],delivery:'published-asset-read' as const};
    expect(usableAgentAssetObservation(receipt,assetTarget,agent,'trusted')).toBe(true);
    expect(ExternalAgentAssetObservationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(usableAgentAssetObservation(receipt,{...assetTarget,runId:'other'},agent,'trusted')).toBe(false);
  });

  it('keeps the asset standard target-specific and allows a disposition to cite own reviews from two receipts', () => {
    const assetSubject = { kind: 'asset' as const, asset: { id: 'research-1' }, target: { runId: 'run-1', assetVersionId: 'research-1', payloadHash: 'c'.repeat(64) }, standard: { id: 'research-standard', revision: '1', content: '研究依据标准' } };
    expect(standardForSubject(assetSubject as Parameters<typeof standardForSubject>[0], standard)?.id).toBe('research-standard');
    expect(standardForSubject({ ...assetSubject, standard: null } as Parameters<typeof standardForSubject>[0], standard)).toBeNull();
    const agent = { id: 'codex-reviewer', sessionId: 'external-session-1' };
    const own = (id: string, receiptId: string, runId = 'run-1') => ({ id, runId, judge: { kind: 'agent', ...agent }, observationReceiptId: receiptId }) as RunReviewDto;
    const reviews: RunReviewDto[] = [own('research-review', 'asset-receipt-1'), own('author-review', 'response-receipt-1'), own('other-run', 'asset-receipt-1', 'run-2'), { ...own('foreign', 'asset-receipt-1'), judge: { kind: 'agent', id: 'other-agent', sessionId: 'other-session' } }];
    expect(agentDispositionReviewsMatch(reviews, ['research-review', 'author-review'], 'asset-receipt-1', agent, 'run-1')).toBe(true);
    expect(agentDispositionReviewsMatch(reviews, ['author-review'], 'asset-receipt-1', agent, 'run-1')).toBe(false);
    expect(agentDispositionReviewsMatch(reviews, ['research-review', 'foreign'], 'asset-receipt-1', agent, 'run-1')).toBe(false);
    expect(agentDispositionReviewsMatch(reviews, ['other-run'], 'asset-receipt-1', agent, 'run-1')).toBe(false);
  });

  it('saves an asset review with its own receipt and a mixed-basis record-only disposition', async () => {
    const researchStandard = { id: 'research-standard', revision: '1', content: '稿件依据是否充分。' };
    const review = { id: 'research-review', spaceId: 'space-1', runId: 'run-1', assetVersionIds: ['research-1'], observationReceiptId: 'asset-receipt-1', standard: researchStandard, judge: { kind: 'agent' as const, id: 'codex-reviewer', sessionId: 'external-session-1' }, evidence: ['research-1'], answers, createdAt: '2026-10-10T00:00:00Z' };
    const disposition = { id: 'mixed-disposition', assetId: 'disposition-asset', runId: 'run-1', revision: 2, payloadHash: 'hash-2', createdAt: '2026-10-10T01:00:00Z', previousRevisionId: 'disposition-1', recordedBy: 'trusted-host-1', author: { kind: 'agent', id: 'codex-reviewer', sessionId: 'external-session-1', servicePrincipalId: 'trusted-host-1' }, confirmation: 'unconfirmed', reviewIds: ['research-review', 'author-review'], action: 'defer', reason: '仍需核查', unknowns: ['研究来源'], evidenceRefs: [{ kind: 'asset', assetVersionId: 'research-1' }], observationReceiptId: 'asset-receipt-1', observationReceiptIds: ['asset-receipt-1', 'response-receipt-1'] };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(review), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(disposition), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    await api.saveRunReview('run-1', { id: review.id, runId: 'run-1', assetVersionIds: ['research-1'], observationReceiptId: 'asset-receipt-1', standard: researchStandard, judge: review.judge, evidence: ['research-1'], answers }, 'csrf-token');
    expect((await api.saveRunDisposition('run-1', { runId: 'run-1', reviewIds: disposition.reviewIds, action: 'defer', reason: '仍需核查', unknowns: ['研究来源'], evidenceRefs: [{ kind: 'asset', assetVersionId: 'research-1' }], observationReceiptId: 'asset-receipt-1', expectedRevisionId: 'disposition-1', idempotencyKey: 'key-mixed' }, 'csrf-token')).observationReceiptIds).toEqual(['asset-receipt-1', 'response-receipt-1']);
    expect(JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({ assetVersionIds: ['research-1'], observationReceiptId: 'asset-receipt-1', standard: researchStandard });
    expect(JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string)).not.toHaveProperty('responseTarget');
    expect(JSON.parse((fetcher.mock.calls[1] as [string, RequestInit])[1].body as string)).toMatchObject({ reviewIds: ['research-review', 'author-review'], observationReceiptId: 'asset-receipt-1' });
  });
});
