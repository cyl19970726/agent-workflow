import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunDiagnosisRequestDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { EvidencePicker, candidateDraftProblem, diagnosisDraftStorageKey, diagnosisEvidenceChoices, editableLines, normalizedCandidate, normalizedDiagnosisIssues, primaryAgentDiagnosisReceipt, savedLines, selectableDiagnosisEvidence } from './run-diagnosis.js';

const issue: RunDiagnosisRequestDto['issues'][number] = {
  id: 'issue-1', title: '引文发布失败', expected: '草稿通过引用校验并发布', observed: '校验失败，草稿未发布',
  evidenceRefs: [{ kind: 'run', runId: 'run-1', stepRunId: 'publish-1' }], unknowns: ['来源是否变动', ''],
  hypotheses: [{ id: 'hypothesis-1', category: 'validation-recovery', explanation: '来源绑定可能不一致', supportRefs: [{ kind: 'run', runId: 'run-1', stepRunId: 'publish-1' }], counterRefs: [], unknowns: ['是否重试过', ''], discriminatingCheck: '复核保存引用与来源' }],
  decision: { route: 'defer', reason: '先核对保存来源', nextCheck: '', externalIssueRef: '', designSessionRef: '' },
};

describe('run diagnosis', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps selected evidence readable in the unsaved editor while the selection list is closed', () => {
    const ref = { kind: 'asset' as const, assetVersionId: 'research-1', payloadHash: 'a'.repeat(64) };
    const actions = { onAsset: vi.fn(), onResponse: vi.fn(), onReview: vi.fn(), onDisposition: vi.fn(), onRunStep: vi.fn(), onInputs: vi.fn(), onTrace: vi.fn() };
    const html = renderToStaticMarkup(createElement(EvidencePicker, { title: '支持依据', selected: [ref], choices: [], readingChoices: [{ ref, label: '已发布研究 · 目标用户证据' }], runId: 'run-1', actions, onChange: vi.fn() }));
    expect(html).toContain('已选证据 · 可先阅读原文再填写判断');
    expect(html).toContain('已发布研究 · 目标用户证据 · 阅读原证据');
    expect(html).toContain('准确身份');
    expect(html).not.toContain('sw-diagnosis-evidence-list');
  });

  it('preserves a typed trailing newline while editing, then removes blank list items and empty optional fields on save', () => {
    expect(editableLines('第一项\n')).toEqual(['第一项', '']);
    expect(editableLines('第一项\n').join('\n')).toBe('第一项\n');
    const normalized = normalizedDiagnosisIssues([issue])[0];
    expect(normalized.unknowns).toEqual(['来源是否变动']);
    expect(normalized.hypotheses[0].unknowns).toEqual(['是否重试过']);
    expect(normalized.decision).toEqual({ route: 'defer', reason: '先核对保存来源' });
    expect(savedLines([' 收益 ', '', '  '])).toEqual(['收益']);
    expect(normalizedCandidate({ predecessorVersionId: 'version-1', issueIds: ['issue-1'], hypothesisIds: ['hypothesis-1'], changes: [{ target: '引用交接', before: '原状', after: '调整', reason: '校验失败' }], expectedBenefits: [' 可核查 ', ''], risks: [' 引用仍不全 ', ''], validationPlan: '复核', falsificationConditions: [' 再次失败 ', ''], conditions: [' 来源可读 ', ''] })).toMatchObject({ expectedBenefits: ['可核查'], risks: ['引用仍不全'], falsificationConditions: ['再次失败'], conditions: ['来源可读'] });
  });

  it('isolates an unsaved draft by API root, authenticated scope and exact Run', () => {
    const key = diagnosisDraftStorageKey('/api/spaces/space-1', 'agent-1:scope-a', 'run-1');
    expect(key).not.toBe(diagnosisDraftStorageKey('/api/spaces/space-1', 'agent-2:scope-a', 'run-1'));
    expect(key).not.toBe(diagnosisDraftStorageKey('/api/spaces/space-1', 'agent-1:scope-a', 'run-2'));
  });

  it('offers only exact saved sources with frozen input and response identities', () => {
    const target = { runId: 'run-1', occurrenceId: 'occ-1', stepRunId: 'author-1', attemptId: 'attempt-1', sessionId: 'producer-session', eventId: 'event-1', eventSeq: 9, outputHash: 'a'.repeat(64) };
    const choices = diagnosisEvidenceChoices('run-1', { runId: 'run-1', caseId: 'case-1', versionId: 'version-1', inputManifestId: 'manifest-1', inputManifestHash: 'b'.repeat(64), slots: [] }, { runId: 'run-1', caseId: 'case-1', versionId: 'version-1', standard: null, subjects: [{ kind: 'response', target, occurrenceLabel: '未发布作者稿' }], failures: [] }, [], [], undefined);
    expect(choices).toContainEqual({ label: '冻结输入清单 manifest-1', ref: { kind: 'inputs', manifestId: 'manifest-1', payloadHash: 'b'.repeat(64) } });
    expect(choices.some(choice => choice.ref.kind === 'response' && choice.ref.target.outputHash === target.outputHash)).toBe(true);
    expect(choices.some(choice => choice.ref.kind === 'asset')).toBe(false);
    expect(selectableDiagnosisEvidence([...choices, { label: '另一评价', ref: { kind: 'review', reviewId: 'other-review' } }, { label: '本次评价', ref: { kind: 'review', reviewId: 'review-1' } }], ['review-1'], 'disposition-1').some(choice => choice.ref.kind === 'review' && choice.ref.reviewId === 'other-review')).toBe(false);
  });

  it('requires every candidate issue and explanation to remain supported and selects a receipt from chosen Agent reviews', () => {
    const candidate = { predecessorVersionId: 'version-1', issueIds: ['issue-1'], hypothesisIds: ['hypothesis-1'], changes: [{ target: '引用校验', before: '旧步骤', after: '新步骤', reason: '失败' }], expectedBenefits: ['可核查'], risks: ['可能遗漏'], validationPlan: '重新校验', falsificationConditions: ['仍失败'], conditions: [] };
    const changeMethod = { ...issue, decision: { route: 'change-method' as const, reason: '需改变校验交接' } };
    expect(candidateDraftProblem(candidate, [changeMethod])).toBeNull();
    expect(candidateDraftProblem({ ...candidate, issueIds: ['issue-1', 'deleted-issue'] }, [changeMethod])).toContain('每个问题');
    expect(candidateDraftProblem(candidate, [{ ...changeMethod, hypotheses: [{ ...changeMethod.hypotheses[0], supportRefs: [] }] }])).toContain('支持依据');
    expect(candidateDraftProblem({ ...candidate, changes: [{ ...candidate.changes[0], after: '旧步骤' }] }, [changeMethod])).toContain('不同');
    const reviews = [{ id: 'research-review', judge: { kind: 'agent', id: 'root-agent', sessionId: 'outer-1' }, observationReceiptId: 'research-receipt' }, { id: 'author-review', judge: { kind: 'agent', id: 'root-agent', sessionId: 'outer-1' }, observationReceiptId: 'author-receipt' }] as Parameters<typeof primaryAgentDiagnosisReceipt>[0];
    expect(primaryAgentDiagnosisReceipt(reviews, ['research-review'], { id: 'root-agent', sessionId: 'outer-1' })).toBe('research-receipt');
    expect(primaryAgentDiagnosisReceipt(reviews, ['author-review'], { id: 'root-agent', sessionId: 'outer-1' })).toBe('author-receipt');
    expect(primaryAgentDiagnosisReceipt(reviews, ['research-review'], { id: 'other', sessionId: 'outer-1' })).toBeUndefined();
  });

  it('reads current, history and exact revision, then saves one immutable revision with CAS and stable request key', async () => {
    const input: RunDiagnosisRequestDto = { runId: 'run-1', reviewIds: ['review-1'], dispositionRevisionId: 'disposition-1', dispositionPayloadHash: 'c'.repeat(64), issues: normalizedDiagnosisIssues([issue]), expectedRevisionId: null, idempotencyKey: 'request-1' };
    const revision = { ...input, id: 'diagnosis-1', assetId: 'asset-diagnosis-1', revision: 1, payloadHash: 'd'.repeat(64), createdAt: '2026-10-10T00:00:00Z', workflowVersionId: 'version-1', previousRevisionId: null, author: { kind: 'human', id: 'human-1' }, recordedBy: 'human-1', confirmation: 'unconfirmed' };
    const { expectedRevisionId: _expectedRevisionId, idempotencyKey: _idempotencyKey, ...saved } = revision;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('null', { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ items: [saved], nextCursor: null, snapshotAt: '2026-10-10T00:00:00Z' }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    expect(await api.runDiagnosis('run-1')).toBeNull();
    expect((await api.runDiagnoses('run-1')).items[0].id).toBe('diagnosis-1');
    expect((await api.runDiagnosisRevision('run-1', 'diagnosis-1')).previousRevisionId).toBeNull();
    expect((await api.saveRunDiagnosis('run-1', input, 'csrf-token')).confirmation).toBe('unconfirmed');
    expect((fetcher.mock.calls[0] as [string])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/diagnosis');
    expect((fetcher.mock.calls[2] as [string])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/runs/run-1/diagnoses/diagnosis-1');
    expect(JSON.parse((fetcher.mock.calls[3] as [string, RequestInit])[1].body as string)).toMatchObject({ expectedRevisionId: null, idempotencyKey: 'request-1', dispositionPayloadHash: 'c'.repeat(64) });
  });
});
