import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OccurrenceDto, ProcessDto, RunDetailDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { selectedGraphNode } from './bridge.js';
import { CaseContext, CaseRunOutcome, FailedResponseEntry, RunScopeBanner, caseForSelection, graphEntityKind, publishedDefinitionParams } from './workbench.js';
import { readSelection } from './selection.js';

const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
const scope = 'subject:reader';
const run = { id: 'run-1', caseId: 'case-1', versionId: 'version-1' } as RunDetailDto;
const failed = {
  id: 'occ-author', nodeId: 'author', label: '作者 · 首轮', state: 'failed', outputs: [], failureDetails: [],
  terminalFailure: { state: 'failed', provenance: 'derived', failedAncestorStepId: 'publish-1', failedAncestorStepKey: 'publish', error: 'citation rejected' },
} as unknown as OccurrenceDto;
const research = { id: 'occ-research', nodeId: 'researcher', label: '研究', state: 'completed', terminalFailure: null,
  failureDetails: [], outputs: [{ id: 'asset-research', title: '真实研究资产', sourceKind: 'transform' }],
} as unknown as OccurrenceDto;

function render(client: QueryClient, node: ReturnType<typeof createElement>) {
  return renderToString(createElement(QueryClientProvider, { client }, node));
}

describe('Case first reading', () => {
  it('reads a selected saved Case before a run or preparation exists', () => {
    const objective = '根据准确原始材料回答原始五问，形成完整中文稿；先验证同能力研究节点，再在预算内运行同一Case。';
    const saved = { id: 'case-1', title: '模拟内容业务', objective, constraints: ['只使用已核查事实'], runCount: 0, assetCount: 0 };
    const exact = caseForSelection('case-1', undefined, [saved]);
    expect(exact).toEqual(saved);
    expect(caseForSelection('other', undefined, [saved])).toBeUndefined();
    const html = render(new QueryClient(), createElement(CaseContext, { api, scope, caseData: exact, error: null, retry: () => {}, onAsset: () => {} }));
    expect(html).toContain('模拟内容业务');
    expect(html).toContain(`<summary>阅读完整目标与约束</summary><p>${objective}</p>`);
    expect(html).toContain('只使用已核查事实');
    expect(html).toContain('冻结输入状态见下方');
  });

  it('opens a registered method without carrying candidate-preview identity into the ordinary reader', () => {
    const current = new URLSearchParams('view=business&tab=process&case=case-1&candidateDesign=design-1&candidateReader=1&candidateVersion=version-1&candidateNode=researcher');
    const next = publishedDefinitionParams(current, readSelection(current), 'version-1');
    expect(readSelection(next)).toMatchObject({ view: 'workflow', tab: 'definition', version: 'version-1' });
    for (const key of ['candidateDesign', 'candidateReader', 'candidateVersion', 'candidateNode']) expect(next.has(key)).toBe(false);
  });
  it('accepts only the exact graph asset versions and routes them to the existing actual-asset reader', () => {
    const frame = { postMessage: () => {} } as unknown as Window;
    const known = new Set(['researcher', 'asset-input-v1', 'asset-research-v1']);
    const choose = (id: string) => selectedGraphNode({ source: frame, data: { type: 'workflow-node-select', nodeId: id } } as MessageEvent, frame, known);
    expect(choose('asset-research-v1')).toBe('asset-research-v1');
    expect(graphEntityKind('process', choose('asset-research-v1')!, [], ['asset-input-v1', 'asset-research-v1'])).toBe('actual-asset');
    expect(graphEntityKind('process', choose('researcher')!, [], ['asset-input-v1', 'asset-research-v1'])).toBe('node');
    expect(choose('expected:output:author:draft')).toBeNull();
    expect(choose('unpublished-response-event')).toBeNull();
    expect(graphEntityKind('definition', 'expected:output:author:draft', ['expected:output:author:draft'], [])).toBe('expected-asset');
  });
  it('makes the exact frozen inputs readable even without an ordinary preparation record', () => {
    const client = new QueryClient();
    client.setQueryData(['space', scope, api.root, 'run-inputs', run.id], {
      runId: run.id, caseId: run.caseId, versionId: run.versionId, inputManifestId: 'manifest-1', inputManifestHash: 'hash-1',
      slots: [{ slot: 'opportunity', asset: { id: 'asset-opportunity', title: '原始机会', sourceKind: 'import' }, payloadHash: 'payload-1' }],
    });
    const detailedRun = { ...run, caseTitle: '真实案例', label: '首轮运行', state: 'failed', taskState: 'completed', assetCount: 0, inputAssets: [] } as RunDetailDto;
    const html = render(client, createElement(CaseContext, { api, scope, caseData: { title: '真实案例', objective: '解释机制', constraints: [] } as never, run: detailedRun, error: null, retry: () => {}, onAsset: () => {} }));
    expect(html).toContain('解释机制');
    expect(html).toContain('本次冻结输入');
    expect(html).toContain('opportunity');
    expect(html).toContain('原始机会');
    expect(html).toContain('普通业务准备记录不改变这些已保存输入');
  });

  it('shows a completed trial as a trial in the selected Case and beside its graph', () => {
    const trial = { ...run, caseTitle: '真实案例', label: '研究节点试做', executionMode: 'research-trial', state: 'completed', taskState: 'completed', assetCount: 1, inputAssets: [] } as RunDetailDto;
    const caseHtml = render(new QueryClient(), createElement(CaseContext, { api, scope, caseData: { title: '真实案例', objective: '完整案例目标', constraints: [] } as never, run: trial, error: null, retry: () => {}, onAsset: () => {} }));
    expect(caseHtml).toContain('研究节点试做（非完整运行）');
    expect(caseHtml).toContain('已完成');
    const graphHtml = render(new QueryClient(), createElement(RunScopeBanner, { run: trial }));
    expect(graphHtml).toContain('图展示完整方法结构');
    expect(graphHtml).toContain('不代表整个案例完成');
    expect(graphHtml).not.toContain('完整案例运行');
  });

  it('labels explicit full-Case mode and leaves legacy or unknown graph scope unclaimed', () => {
    const base = { ...run, caseTitle: '真实案例', label: '本次运行', state: 'completed', taskState: 'completed', assetCount: 0, inputAssets: [] } as RunDetailDto;
    const full = render(new QueryClient(), createElement(RunScopeBanner, { run: { ...base, executionMode: 'case' } }));
    expect(full).toContain('完整案例运行');
    const legacy = render(new QueryClient(), createElement(RunScopeBanner, { run: base }));
    expect(legacy).toContain('运行范围未记录');
    expect(legacy).toContain('不能推断已完成整个案例');
    const unknown = render(new QueryClient(), createElement(RunScopeBanner, { run: { ...base, executionMode: 'future-mode' } }));
    expect(unknown).toContain('运行范围未知（future-mode）');
    expect(unknown).not.toContain('完整案例运行');
  });

  it('puts only published output in the outcome and links the saved unpublished author response to records', () => {
    const client = new QueryClient();
    client.setQueryData(['space', scope, api.root, 'unpublished-responses', run.id, failed.id], {
      runId: run.id, occurrenceId: failed.id,
      responses: [{ stepRunId: 'author-step', attemptId: 'author-attempt', sessionId: 'author-session', eventId: 'event-1', eventSeq: 3, publication: 'unpublished', output: '{"draft":"private body"}', coverage: 'full', reading: { title: '未发布稿件', sections: [], readerStatus: 'registered', reason: null } }],
    });
    const process = { occurrences: [research, failed] } as unknown as ProcessDto;
    const html = render(client, createElement(CaseRunOutcome, { api, scope, run, process, error: null, retry: () => {}, onAsset: () => {}, onRecords: () => {} }));
    expect(html.replaceAll('<!-- -->', '')).toContain('已发布成果 · 1 项');
    expect(html).toContain('真实研究资产');
    expect(html).toContain('引用校验失败');
    expect(html.replaceAll('<!-- -->', '')).toContain('阅读已保存未发布响应 · 1 条');
    expect(html).not.toContain('private body');
    expect(html).not.toContain('未发布稿件</strong>');
  });

  it('does not offer the unpublished response link before a saved response is verified', () => {
    const client = new QueryClient();
    client.setQueryData(['space', scope, api.root, 'unpublished-responses', run.id, failed.id], { runId: run.id, occurrenceId: failed.id, responses: [] });
    const html = render(client, createElement(FailedResponseEntry, { api, scope, runId: run.id, occurrence: failed, onOpen: () => {} }));
    expect(html).not.toContain('阅读已保存未发布响应');
    expect(html).toContain('未发现可读的未发布响应');
  });
});
