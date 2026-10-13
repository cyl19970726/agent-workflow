import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpaceApi } from './api.js';
import { MethodDesign, MethodDesignBasis, canRegisterDesignDraft, designDraftFromRevision, previewAvailabilityLabel } from './method-design.js';
import { readSelection, writeSelection } from './selection.js';
import { knownNodeLabel } from './workbench.js';
import { MethodCandidate, candidateAssetSchema, candidateBudget, candidateReasoning, exactCandidateDiagramUrl, readableFrozenRule } from './method-candidate.js';
import type { MethodDesignDefinitionDto } from '@signal-room/workflow-space-api/contracts';

const design = { id: 'design-2', assetId: 'design-asset', revision: 2, payloadHash: 'design-hash', createdAt: '2026-10-09T00:00:00Z', previousRevisionId: 'design-1', changeReason: '补充交接', title: '首版设计', content: '# 执行目标\n先形成假设', sources: [{ kind: 'document' as const, ref: 'docs/method.md', title: '方法依据' }], authorship: { kind: 'agent' as const, name: 'Designer' }, recordedBy: 'operator', confirmation: 'unconfirmed' as const, workflowId: 'workflow-1', entrypoint: 'start', understanding: { revisionId: 'understanding-1', payloadHash: 'understanding-hash' } };

describe('method design UI contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a draft tied to the exact understanding while attributing a new edit to the principal', () => {
    const draft = designDraftFromRevision(design, 'operator-2');
    expect(draft.understanding).toEqual({ revisionId: 'understanding-1', payloadHash: 'understanding-hash' });
    expect(draft.authorship).toEqual({ kind: 'human', name: 'operator-2' });
    const selected = readSelection(new URLSearchParams('view=workflow&tab=design&methodDesignRevision=design-1'));
    expect(readSelection(writeSelection(new URLSearchParams(), selected))).toMatchObject({ tab: 'design', methodDesignRevision: 'design-1' });
    expect(designDraftFromRevision(design, 'service-principal', { id: 'trusted-designer', sessionId: 'design-session' }).authorship).toEqual({ kind: 'agent', name: 'trusted-designer', sessionId: 'design-session' });
    const capability = { revisionId: 'capability-7', payloadHash: 'full-capability-hash' };
    expect(designDraftFromRevision({ ...design, capability }, 'operator-2').capability).toEqual(capability);
  });

  it('reads every frozen node and preserves long instructions, complete arrays and the exact diagram revision', () => {
    const instructions = '从原始证据开始。'.repeat(700);
    const nodeIds = ['frame', 'research', 'structure', 'draft', 'review'];
    const definition = {
      candidateId: 'candidate-7', workflowId: 'workflow-1', entrypoint: 'start', designRevisionId: 'design-7', designPayloadHash: 'design-hash',
      understandingRevisionId: 'understanding-4', understandingPayloadHash: 'understanding-hash', capabilityRevisionId: 'capability-7', capabilityPayloadHash: 'capability-hash',
      provider: { id: 'provider-1', contractRevision: 'contract-3', fingerprint: 'provider-fingerprint' },
      version: { hash: 'version-hash', config: { budget: { tokens: 123456 }, routes: Array.from({ length: 40 }, (_, i) => `route-${i}`) }, entrypoints: { start: { process: { nodes: nodeIds.map(id => ({ id, kind: 'agent' })), edges: [{ from: 'review', to: 'draft', maxTraversals: 3 }], results: [{ nodeId: 'review' }] }, nodeDefinitions: Object.fromEntries(nodeIds.map(id => [id, { purpose: `职责 ${id}`, instructions: `${id}: ${instructions}`, model: `model-${id}`, reasoningEffort: 'high', tools: ['read', 'inspect'], configuration: { contextPolicy: { source: 'frozen' } } }])) } } },
      schemas: [{ name: 'final', nested: { properties: { complete: { type: 'boolean' } } } }], presentation: { stages: nodeIds.map(id => ({ id })) },
      availability: { state: 'unavailable', reason: '尚未部署' }, expectedAssets: { assets: [], dependencies: [], gaps: [] }, diagramUrl: '/api/workflow-spaces/v1/spaces/space-1/method-design/diagram?revision=design-7&expectedCandidateId=candidate-7&embed=1',
    } as MethodDesignDefinitionDto;
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(MethodCandidate, { definition, apiRoot: '/api/workflow-spaces/v1/spaces/space-1' })));
    for (const id of nodeIds) expect(html).toContain(`${id}: ${instructions}`);
    expect(html).toContain('route-39');
    expect(html).toContain('123456');
    expect(html).toContain('provider-fingerprint');
    expect(html).toContain('complete');
    expect(html).toContain('method-design/diagram?revision=design-7&amp;expectedCandidateId=candidate-7&amp;embed=1');
    expect(html).toContain('暂不可执行');
  });

  it('opens the exact selected Agent, human gate and expected asset contracts from the same candidate URL', () => {
    const agent = { id: 'research', kind: 'agent', inputs: { material: { slot: 'material' } }, outputs: { research: { slot: 'research' } } };
    const human = { id: 'review', kind: 'human', inputs: { research: { slot: 'research' } } };
    const definition = {
      candidateId: 'candidate-9', workflowId: 'flow', entrypoint: 'main', designRevisionId: 'design-9', designPayloadHash: 'd', understandingRevisionId: 'u', understandingPayloadHash: 'u-hash', capabilityRevisionId: 'c', capabilityPayloadHash: 'c-hash', provider: { id: 'provider', contractRevision: '1', fingerprint: 'fp' },
      version: { config: { policy: { budget: { maxNodeCalls: 15 } } }, entrypoints: { main: { process: { nodes: [agent, human], edges: [{ id: 'to-review', from: 'research', to: 'review', kind: 'sequence' }], dataBindings: [] }, storageContract: { nodes: {} }, nodeDefinitions: { research: { purpose: '核清证据', instructions: '完整研究指令', model: 'test-model', tools: ['read_bound_asset'], toolDefinitions: [{ name: 'read_bound_asset', description: '读取准确材料', parameters: {type: 'object', properties: {ref: {type: 'string'}}} }], configuration: { stageDeclaration: { reasoningEffort: 'high', outputSchema: { type: 'object' }, permissionsRevision: 'read-only' }, contextPolicy: ['material'], toolContract: { response: {type: 'object', properties: {content: {type: 'string'}}}, permissions: {write: false} } } }, review: { purpose: '由人决定', executor: { family: 'human' } } } } } },
      schemas: [{ namespace: 'research', revision: '1', dialect: 'https://json-schema.org/draft/2020-12/schema', schema: { type: 'object', properties: { frozenEvidence: { type: 'string' } } } }], presentation: { stages: [{ id: 'research', label: '研究' }, { id: 'review', label: '人工复核' }] }, availability: { state: 'unavailable', reason: null }, diagramUrl: '/api/workflow-spaces/v1/spaces/space-1/method-design/diagram?revision=design-9&expectedCandidateId=candidate-9&embed=1',
      expectedAssets: { assets: [{ id: 'expected_output_7265736561726368_7265736561726368', label: '研究资产', source: { kind: 'node-output', nodeId: 'research', port: 'research' }, schema: { namespace: 'research', revision: '1', hash: 'h' }, producer: { nodeId: 'research', port: 'research' }, consumers: [{ nodeId: 'review', port: 'research', bindingId: 'review-research', selection: 'current-business-round' }], resultRoles: ['primary'], purpose: {resultRoles: ['primary'], consumerNodeIds: ['review']}, missing: [] }], dependencies: [], gaps: [] },
    } as MethodDesignDefinitionDto;
    const render = (selected: string) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/?candidateDesign=design-9&candidateVersion=candidate-9&candidateNode=${selected}`] }, createElement(MethodCandidate, { definition, apiRoot: '/api/workflow-spaces/v1/spaces/space-1' })));
    const agentHtml = render('research');
    expect(agentHtml).toContain('研究</h5>');
    expect(agentHtml).toContain('完整研究指令');
    expect(agentHtml).toContain('推理等级');
    expect(agentHtml).toContain('high');
    expect(agentHtml).toContain('maxNodeCalls');
    expect(agentHtml).toContain('读取准确材料');
    expect(agentHtml).toContain('成功返回字段与实际类型');
    expect(agentHtml).toContain('工具权限');
    const humanHtml = render('review');
    expect(humanHtml).toContain('人工复核</h5>');
    expect(humanHtml).toContain('人工判断与放行条件');
    expect(humanHtml).not.toContain('完整实际指令');
    const assetHtml = render('expected_output_7265736561726368_7265736561726368');
    expect(assetHtml).toContain('研究资产</h5>');
    expect(assetHtml).toContain('current-business-round');
    expect(assetHtml).toContain('research');
    expect(assetHtml).toContain('完整 JSON Schema 字段');
    expect(assetHtml).toContain('frozenEvidence');
    expect(assetHtml).toContain('准确引用 · namespace / revision / hash');
    expect(candidateAssetSchema(definition.expectedAssets.assets[0]!, []).reason).toContain('找不到');
    expect(candidateReasoning({ configuration: { stageDeclaration: { reasoningEffort: 'high' } } })).toBe('high');
    expect(candidateBudget({ config: { policy: { budget: { maxNodeCalls: 15 } } } })).toEqual({ maxNodeCalls: 15 });
    expect(exactCandidateDiagramUrl(definition, '/api/workflow-spaces/v1/spaces/space-1')).toBe(definition.diagramUrl);
    expect(exactCandidateDiagramUrl({ ...definition, diagramUrl: '/api/workflow-spaces/v1/spaces/space-1/method-design/diagram?revision=other' }, '/api/workflow-spaces/v1/spaces/space-1')).toBeNull();
    expect(exactCandidateDiagramUrl({ ...definition, diagramUrl: '/api/workflow-spaces/v1/spaces/space-1/method-design/diagram?revision=design-9&expectedCandidateId=other&embed=1' }, '/api/workflow-spaces/v1/spaces/space-1')).toBeNull();
    const changed = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/?candidateDesign=design-9&candidateVersion=old-candidate&candidateNode=research'] }, createElement(MethodCandidate, { definition, apiRoot: '/api/workflow-spaces/v1/spaces/space-1' })));
    expect(changed).toContain('候选已变化，需要重新核对');
    expect(changed).toContain('原选中对象 research 已保留');
    expect(changed).not.toContain('准确候选方法与预期产出图');
  });

  it('offers Agent registration only for a draft saved by the same trusted identity and session', () => {
    const agent = { id: 'designer', sessionId: 'session-1' };
    const own = { authorship: { kind: 'agent' as const, name: 'designer', sessionId: 'session-1' }, recordedBy: 'service-principal' };
    expect(canRegisterDesignDraft(own, 'service-principal', agent)).toBe(true);
    expect(canRegisterDesignDraft({ ...own, authorship: { ...own.authorship, name: 'other' } }, 'service-principal', agent)).toBe(false);
    expect(canRegisterDesignDraft({ ...own, authorship: { ...own.authorship, sessionId: 'session-2' } }, 'service-principal', agent)).toBe(false);
    expect(canRegisterDesignDraft({ ...own, authorship: { kind: 'human', name: 'designer' } }, 'service-principal', agent)).toBe(false);
    expect(canRegisterDesignDraft({ ...own, recordedBy: 'other-principal' }, 'service-principal', agent)).toBe(false);
    expect(canRegisterDesignDraft({ ...own, authorship: { kind: 'human', name: 'person' } }, 'person')).toBe(true);
  });

  it('reads frozen program decisions and human handoff as control records without inventing asset ports', () => {
    const routing = { input: ['published editor review.verdict', 'unrecognized frozen input'], decisionOrder: ['round index >= 1 => needs_review not-converged'], maxTotalReworkTraversals: 1, reworkBranchesShareLimit: true, decisionRecord: 'content-route-{round} with route, verdict, guardFailures, round' };
    const handoff = { input: ['current draft', 'current editor review'], runtimeBehavior: 'needs_review records a creator-facing handoff and stops this run', creatorAuthority: 'creator may decide acceptance, revision, or stopping outside this run', implementedCommands: [], automaticContinuation: false };
    const definition = { candidateId: 'candidate-1', workflowId: 'flow', entrypoint: 'content', designRevisionId: 'design-1', designPayloadHash: 'd', understandingRevisionId: 'u', understandingPayloadHash: 'uh', capabilityRevisionId: 'c', capabilityPayloadHash: 'ch', provider: { id: 'p', contractRevision: 'r', fingerprint: 'f' }, version: { config: { policy: { budget: { semantics: 'CONTENT rounds 0 and 1 inclusive; a technical retry does not consume a business round' } } }, entrypoints: { content: { process: { nodes: [{ id: 'route', kind: 'decision' }, { id: 'creatorDraftGate', kind: 'human' }], edges: [] }, nodeDefinitions: { route: { configuration: { programRouting: routing } }, creatorDraftGate: { configuration: { handoff } } } } } }, schemas: [], presentation: { stages: [{ id: 'route', label: '程序路由' }, { id: 'creatorDraftGate', label: '创作者交接' }] }, availability: { state: 'unavailable', reason: null }, expectedAssets: { assets: [], dependencies: [], gaps: [] } } as MethodDesignDefinitionDto;
    const read = (nodeId: string) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/?candidateDesign=design-1&candidateVersion=candidate-1&candidateNode=${nodeId}`] }, createElement(MethodCandidate, { definition, apiRoot: '/api/workflow-spaces/v1/spaces/s' })));
    const routeHtml = read('route');
    expect(routeHtml).toContain('控制判断所读信息（非业务资产端口）');
    expect(routeHtml).toContain('已发布编辑复核的结论');
    expect(routeHtml).toContain('unrecognized frozen input');
    expect(routeHtml).toContain('控制决策记录（非业务成果资产）');
    expect(routeHtml).toContain('所有返工分支共用最多一次返工');
    expect(routeHtml).toContain('技术重试不消耗业务轮次');
    expect(routeHtml).not.toContain('流程输入端口</strong><pre>未记录');
    const humanHtml = read('creatorDraftGate');
    expect(humanHtml).toContain('创作者在本次运行之外决定接受、修改或停止');
    expect(humanHtml).toContain('这里只记录 needs_review 交接并停止本次运行');
    expect(humanHtml).toContain('不会自动继续本次运行');
    expect(readableFrozenRule('unrecognized frozen input')).toBe('unrecognized frozen input');
  });

  it('links the frozen design to its same exact method version and labels known graph nodes', () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const client = new QueryClient();
    client.setQueryData(['space', 'scope-1', api.root, 'version-design', 'version-1'], {
      design,
      understanding: { ...design, id: 'understanding-1', assetId: 'understanding-asset', revision: 1, payloadHash: 'understanding-hash', title: '旧业务理解' },
    });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MethodDesignBasis, { api, scope: 'scope-1', versionId: 'version-1', onGoalRevision: vi.fn(), onDesignRevision: vi.fn(), onMethod: vi.fn() })));
    expect(html).toContain('查看本版方法与预期产出图');
    const basisSelection = readSelection(new URLSearchParams('view=workflow&tab=basis&version=version-1'));
    const methodSelection = readSelection(writeSelection(new URLSearchParams(), { ...basisSelection, tab: 'definition' }));
    expect(methodSelection).toMatchObject({ version: 'version-1', tab: 'definition' });
    expect(knownNodeLabel([{ id: 'research', label: '研究节点' }], 'research')).toBe('研究节点');
    expect(knownNodeLabel([], 'missing-node')).toBe('missing-node');
  });

  it('offers exact D6 asset and D7 Case reading only after their scoped records resolve', () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const client = new QueryClient();
    const sources = [
      { kind: 'asset' as const, ref: 'research-asset', title: 'D6 · 研究原文' },
      { kind: 'case' as const, ref: 'business-case', title: 'D7 · 业务案例' },
      { kind: 'asset' as const, ref: '../other-space', title: '不可定位的资产' },
    ];
    const revision = { ...design, id: 'design-5', revision: 5, sources };
    client.setQueryData(['space', 'scope-1', api.root, 'method-design', 'current'], revision);
    client.setQueryData(['space', 'scope-1', api.root, 'method-design', 'revision', 'design-5'], revision);
    const props = { api, scope: 'scope-1', principal: 'reader', workflowId: 'workflow-1', entrypoint: 'start', canWrite: false, canPublish: false, selectedRevisionId: 'design-5', onSelectRevision: vi.fn(), onGoalRevision: vi.fn(), onPublished: vi.fn(), onOpenSource: vi.fn() };
    const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MethodDesign, props)));
    expect(render()).toContain('正在核对本 Space 中的准确来源');
    client.setQueryData(['space', 'scope-1', api.root, 'source-asset', 'research-asset'], { asset: { id: 'research-asset' }, title: '研究正文' });
    client.setQueryData(['space', 'scope-1', api.root, 'source-case', 'business-case'], { id: 'business-case', title: '案例与运行' });
    const html = render();
    expect(html).toContain('阅读准确资产 · 研究正文');
    expect(html).toContain('阅读案例与全部运行 · 案例与运行');
    expect(html).toContain('此引用不是可定位的本 Space 对象 ID');
    expect(html).toContain('id="design-source-1"');
    expect(html).toContain('id="design-source-2"');
    client.setQueryData(['space', 'scope-1', api.root, 'source-asset', 'research-asset'], { asset: { id: 'wrong-space-asset' }, title: '错误对象' });
    const mismatched = render();
    expect(mismatched).not.toContain('阅读准确资产 · 错误对象');
    expect(mismatched).toContain('准确身份不匹配');
  });

  it('displays preview deployment states without treating publication as run authorization', () => {
    expect(previewAvailabilityLabel('available')).toContain('已匹配部署');
    expect(previewAvailabilityLabel('available')).toContain('仍需准备并核验本次 release');
    expect(previewAvailabilityLabel('unavailable')).toContain('不可执行');
    expect(previewAvailabilityLabel('unknown')).toContain('未知');
  });

  it('reads, previews, and explicitly publishes the exact candidate with CSRF', async () => {
    const preview = { versionId: 'version-1', workflowId: 'workflow-1', entrypoint: 'start', designRevisionId: 'design-2', designHash: 'design-hash', understandingRevisionId: 'understanding-1', understandingHash: 'understanding-hash', availability: 'unavailable' };
    const receipt = { versionId: 'version-1', designRevisionId: 'design-2', understandingRevisionId: 'understanding-1' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(design), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    expect((await api.methodDesign()).understanding.revisionId).toBe('understanding-1');
    expect((await api.methodDesignPreview('design-2')).versionId).toBe('version-1');
    expect((await api.publishMethodDesign('design-2', 'version-1', 'csrf-1')).versionId).toBe('version-1');
    expect((fetcher.mock.calls[1] as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/method-design/preview?revision=design-2');
    const [url, options] = fetcher.mock.calls[2] as [string, RequestInit];
    expect(url).toBe('/api/workflow-spaces/v1/spaces/space-1/method-design/publications');
    expect(options.headers).toMatchObject({ 'x-space-csrf': 'csrf-1' });
    expect(JSON.parse(String(options.body))).toEqual({ designRevisionId: 'design-2', expectedCandidateId: 'version-1' });
  });

  it('requests the complete candidate by the selected exact design revision', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidateId: 'candidate-7', workflowId: 'workflow-1', entrypoint: 'start', designRevisionId: 'design/7', designPayloadHash: 'design-hash', understandingRevisionId: 'understanding-4', understandingPayloadHash: 'understanding-hash', capabilityRevisionId: 'capability-7', capabilityPayloadHash: 'capability-hash', provider: { id: 'provider-1', contractRevision: '3', fingerprint: 'fingerprint' }, version: {}, schemas: [], presentation: null, availability: { state: 'unavailable', reason: '未部署' }, expectedAssets: { assets: [], dependencies: [], gaps: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const definition = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').methodDesignDefinition('design/7');
    expect(definition.candidateId).toBe('candidate-7');
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/method-design/definition?revision=design%2F7');
  });

  it('saves a new draft with exact scope, understanding reference, expected head and idempotency key', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(design), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    await api.saveMethodDesign({ workflowId: 'workflow-1', entrypoint: 'start', understanding: design.understanding, expectedRevisionId: 'design-1', idempotencyKey: 'stable-key', title: design.title, content: design.content, sources: design.sources, authorship: { kind: 'human', name: 'operator' }, changeReason: design.changeReason }, 'csrf-1');
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workflow-spaces/v1/spaces/space-1/method-design/revisions');
    expect(options.headers).toMatchObject({ 'x-space-csrf': 'csrf-1' });
    expect(JSON.parse(String(options.body))).toMatchObject({ understanding: { revisionId: 'understanding-1', payloadHash: 'understanding-hash' }, expectedRevisionId: 'design-1', idempotencyKey: 'stable-key' });
  });

  it('reads the frozen design and understanding for an exact method version', async () => {
    const understanding = { ...design, id: 'understanding-1', assetId: 'understanding-asset', revision: 1, payloadHash: 'understanding-hash', previousRevisionId: null };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ design, understanding }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const basis = await new SpaceApi('/api/workflow-spaces/v1', 'space-1').versionDesignBasis('version-1');
    expect(basis.design.id).toBe('design-2');
    expect(basis.understanding.id).toBe('understanding-1');
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/workflow-spaces/v1/spaces/space-1/versions/version-1/design');
  });
});
