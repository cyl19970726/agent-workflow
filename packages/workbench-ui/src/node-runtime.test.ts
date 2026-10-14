import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { NodeDetailDto, OccurrenceDetailDto, OccurrenceDto, OccurrenceRuntimeDto } from '@signal-room/workflow-space-api/contracts';
import { SpaceApi } from './api.js';
import { agentAttemptContexts, NodeRuntime, pairSavedToolCalls } from './node-runtime.js';
import { automaticRuntimeAttempt, DefinitionNode, FrozenAgentDeclaration, ProgramContextRecords, durationLabel } from './workbench.js';
import { readSelection, selectNode, selectRun, writeSelection } from './selection.js';
import { toolFieldSummaries } from './tool-schema.js';

const event = (seq: number, type: OccurrenceRuntimeDto['events'][number]['type'], callId: string | null, extra: Partial<OccurrenceRuntimeDto['events'][number]> = {}): OccurrenceRuntimeDto['events'][number] => ({ id: `event-${seq}`, seq, attemptId: 'attempt-1', createdAt: '2026-10-10T00:00:00Z', type, turn: 1, callId, name: 'read_bound_asset', providerInstructions: null, providerModel: null, providerToolProfileHash: null, argumentsHash: null, outputHash: null, toolDefinitions: null, outcomeUnknown: null, bodyCoverage: 'full', ...extra });

describe('node configuration and exact runtime reading', () => {
  it('does not turn a frozen name-only tool into a complete definition', () => {
    const agent: NodeDetailDto = { id: 'author', versionId: 'version-1', label: '作者', kind: 'agent', definitionRecorded: true, purpose: '写稿', executor: { family: 'agent-sdk', adapter: 'responses' }, model: 'model-1', tools: ['read_bound_asset'], inputs: [], outputs: [], instructions: '冻结 Prompt', configuration: {}, agentDeclarationCoverage: 'full', agentDeclaration: { reasoningEffort: 'high', timeoutMs: 900000, maxTurns: null, maxToolCalls: null, outputFormat: null, outputSchema: null, skills: null, tools: [{ name: 'read_bound_asset', description: null, parameters: null, required: null, outputSchema: null, coverage: 'name-only' }], permissions: { revision: 'read-only-v1', sandboxMode: null, approvalPolicy: null, webSearchMode: null, conditionalWebSearchMode: null, conditionalPermissionsRevision: null, additionalDirectoryCount: null } } };
    const html = renderToStaticMarkup(createElement(FrozenAgentDeclaration, { detail: agent }));
    expect(html).toContain('本版只保存工具名称');
    expect(html).toContain('read_bound_asset');
    expect(html).toContain('read-only-v1');
    expect(html).toContain('15 分钟（900000 毫秒）');
    expect(html).not.toContain('已保存提供定义');
    const agentPage = renderToStaticMarkup(createElement(DefinitionNode, { node: agent, tab: 'config', detail: { data: agent, error: null, refetch: vi.fn() } }));
    expect(agentPage).toContain('agent-sdk · responses');
    expect(agentPage).not.toContain('阅读本版保存的配置');
    const program = { ...agent, kind: 'program', agentDeclaration: null, agentDeclarationCoverage: null } as NodeDetailDto;
    const programHtml = renderToStaticMarkup(createElement(DefinitionNode, { node: program, tab: 'config', detail: { data: program, error: null, refetch: vi.fn() } }));
    expect(programHtml).toContain('不是 Agent');
    expect(programHtml).not.toContain('模型与运行上限');
  });

  it('separates saved reasoning configuration from a missing Agent declaration and bounds static tools', () => {
    const detail = { id: 'builder', versionId: 'main', label: 'Builder', kind: 'agent', definitionRecorded: true,
      purpose: 'Construct analysis', executor: { family: 'agent-sdk', adapter: 'responses' }, model: 'model-1',
      tools: ['read_evidence'], inputs: [], outputs: [], instructions: 'During candidate stage use stage_builder_lens.',
      configuration: { reasoningEffort: 'medium' }, agentDeclarationCoverage: 'full',
      agentDeclaration: { reasoningEffort: null, timeoutMs: null, maxTurns: null, maxToolCalls: null, outputFormat: null,
        outputSchema: null, skills: null, tools: [{ name: 'read_evidence', description: null, parameters: null,
          required: null, outputSchema: null, coverage: 'name-only' }], permissions: null } } as NodeDetailDto;
    const html = renderToStaticMarkup(createElement(DefinitionNode, { node: detail, tab: 'config', detail: { data: detail, error: null, refetch: vi.fn() } }));
    expect(html).toContain('<dt>Agent 声明中的推理等级</dt><dd>未记录</dd>');
    expect(html).toContain('<dt>保存配置中的推理等级</dt><dd>medium</dd>');
    expect(html).toContain('冻结声明投影完整读取（未截断）');
    expect(html).toContain('静态名单不是完整执行工具集');
    expect(html).toContain('其参数 Schema 未保存在此声明中');
    expect(html).toContain('read_evidence');
    expect(html).toContain('stage_builder_lens');
    expect(html).not.toContain('<strong>stage_builder_lens</strong>');
  });

  it('summarizes a recorded tool slot while retaining its raw Schema separately', () => {
    expect(toolFieldSummaries({ type: 'object', properties: { slot: { type: 'string', enum: ['materials', 'research', 'draft'] } }, required: ['slot'] })).toEqual([{ name: 'slot', type: '字符串', required: true, choices: ['materials', 'research', 'draft'], moreChoices: false }]);
    expect(toolFieldSummaries({ type: 'object', properties: null })).toEqual([]);
    expect(durationLabel(900000)).toBe('15 分钟（900000 毫秒）');
  });

  it('pairs calls and outcomes across page boundaries by exact call ID', () => {
    const call = event(2, 'siwc.tool_call', 'call-1', { arguments: { slot: 'materials' } });
    const result = event(102, 'siwc.tool_result', 'call-1', { output: { title: '材料' } });
    const failed = event(103, 'siwc.tool_failed', 'call-2', { outcomeUnknown: true });
    expect(pairSavedToolCalls([result, call])).toMatchObject([{ callId: 'call-1', call, outcome: result }]);
    expect(pairSavedToolCalls([failed])[0]).toMatchObject({ callId: 'call-2', outcome: failed });
    expect(pairSavedToolCalls([event(1, 'siwc.started', null)])).toEqual([]);
  });

  it('separates frozen, context, and provider instructions; offered tools do not imply calls', () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const client = new QueryClient();
    const page: OccurrenceRuntimeDto = { runId: 'run-1', occurrenceId: 'occ-1', versionId: 'version-1', stepRunId: 'step-1', attemptId: 'attempt-1', contextId: 'context-1', sessionId: 'session-1', frozenPrompt: '冻结文本', frozenPromptCoverage: 'full', contextInstructions: '上下文文本', contextInstructionsCoverage: 'full', effectiveConfig: { model: 'model-1' }, events: [event(1, 'siwc.started', null, { providerInstructions: '供应商指令', providerModel: 'model-1', toolDefinitions: [{ name: 'read_bound_asset', description: '读取绑定资产', parameters: { type: 'object', required: ['slot'] }, outputSchema: null, outputSchemaCoverage: 'not-recorded' }] })], calls: [], nextCursor: 1, hasMore: false, scanComplete: true, observedCallCount: 0, bodyCoverage: 'full', evidenceScope: 'saved-runner-events-only', snapshotAt: '2026-10-10T00:00:00Z', sanitized: true };
    client.setQueryData(['space', 'scope-1', api.root, 'occurrence-runtime', 'run-1', 'occ-1', 'attempt-1'], { pages: [page], pageParams: [0] });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(NodeRuntime, { api, scope: 'scope-1', runId: 'run-1', occurrenceId: 'occ-1', contexts: [{ id: 'context-1', nodeId: 'author', stepRunId: 'step-1', attemptId: 'attempt-1', producer: 'agent', instructions: '上下文文本', model: 'model-1', reasoningEffort: 'high', effectiveConfig: {}, sessionId: 'session-1' }], selectedAttempt: 'attempt-1', onSelectAttempt: vi.fn() })));
    expect(html).toContain('冻结文本');
    expect(html).toContain('上下文文本');
    expect(html).toContain('供应商指令');
    expect(html).toContain('read_bound_asset');
    expect(html).toContain('可辨认的调用 0 次');
    expect(html).toContain('提供工具不等于实际调用');
  });

  it('retains the same exact attempt through URL reload and clears it on another run or node', () => {
    const selected = readSelection(new URLSearchParams('view=business&tab=process&run=run-1&node=author&occurrence=occ-1&runtimeAttempt=attempt-1'));
    expect(readSelection(writeSelection(new URLSearchParams(), selected)).runtimeAttempt).toBe('attempt-1');
    expect(selectNode(selected, 'research').runtimeAttempt).toBeUndefined();
    expect(selectRun(selected, { id: 'run-2', versionId: 'version-1', caseId: 'case-1' }).runtimeAttempt).toBeUndefined();
  });

  it('selects the sole saved context after opening the ordinary instructions tab and reloads the same pane', () => {
    const before = readSelection(new URLSearchParams('view=business&tab=process&version=v1&run=run-1&node=author'));
    const occurrence = { id: 'occ-2' } as OccurrenceDto;
    const detail = { id: 'occ-2', contexts: [{ id: 'context-2', attemptId: 'attempt-2', producer: 'agent' }] } as OccurrenceDetailDto;
    expect(automaticRuntimeAttempt('overview', before, occurrence, detail)).toBeUndefined();
    const patch = automaticRuntimeAttempt('instructions', before, occurrence, detail);
    expect(patch).toEqual({ occurrence: 'occ-2', runtimeAttempt: 'attempt-2', nodePane: 'instructions' });
    const reloaded = readSelection(writeSelection(new URLSearchParams(), { ...before, ...patch }));
    expect(reloaded).toMatchObject({ node: 'author', occurrence: 'occ-2', runtimeAttempt: 'attempt-2', nodePane: 'instructions' });
    expect(automaticRuntimeAttempt('instructions', before, occurrence, { ...detail, contexts: [...detail.contexts, { ...detail.contexts[0]!, id: 'context-3' }] })).toBeUndefined();
    expect(automaticRuntimeAttempt('instructions', before, { ...occurrence, id: 'another-occurrence' }, detail)).toBeUndefined();
  });
  it('ignores program publish contexts and does not choose among multiple real Agent attempts', () => {
    const selection = readSelection(new URLSearchParams('view=business&tab=process&run=run-1&node=research'));
    const occurrence = { id: 'occ-research' } as OccurrenceDto;
    const agent = { id: 'agent-context', nodeId: 'research', stepRunId: 'agent-step', attemptId: 'agent-attempt', producer: 'agent' as const, instructions: 'Agent context', model: 'model-1', reasoningEffort: 'high', effectiveConfig: {}, sessionId: 'agent-session' };
    const program = { ...agent, id: 'publish-context', stepRunId: 'publish-step', attemptId: 'publish-attempt', producer: 'program' as const, instructions: 'Publish only', model: null, reasoningEffort: null, sessionId: 'publish-session' };
    const detail = { id: occurrence.id, contexts: [program, agent] } as OccurrenceDetailDto;
    const programHtml = renderToStaticMarkup(createElement(ProgramContextRecords, { contexts: detail.contexts }));
    expect(programHtml).toContain('程序步骤 publish-step');
    expect(programHtml).not.toContain('Agent context');
    expect(agentAttemptContexts(detail.contexts).map(context => context.attemptId)).toEqual(['agent-attempt']);
    expect(automaticRuntimeAttempt('instructions', selection, occurrence, detail)).toEqual({ occurrence: occurrence.id, runtimeAttempt: 'agent-attempt', nodePane: 'instructions' });
    expect(automaticRuntimeAttempt('instructions', { ...selection, runtimeAttempt: 'publish-attempt' }, occurrence, detail)).toEqual({ occurrence: occurrence.id, runtimeAttempt: 'agent-attempt', nodePane: 'instructions' });
    const client = new QueryClient();
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(NodeRuntime, { api, scope: 'scope-1', runId: 'run-1', occurrenceId: occurrence.id, contexts: detail.contexts, selectedAttempt: 'publish-attempt', onSelectAttempt: vi.fn() })));
    expect(html).toContain('agent-attempt');
    expect(html).not.toContain('<option value="publish-attempt"');
    expect(html).toContain('URL 指定的尝试不属于此轮保存的 Agent 上下文');
    const anotherAgent = { ...agent, id: 'agent-context-2', attemptId: 'agent-attempt-2' };
    const multiple = { ...detail, contexts: [program, agent, anotherAgent] };
    expect(automaticRuntimeAttempt('instructions', selection, occurrence, multiple)).toBeUndefined();
    expect(automaticRuntimeAttempt('instructions', { ...selection, runtimeAttempt: 'publish-attempt' }, occurrence, multiple)).toEqual({ occurrence: occurrence.id, runtimeAttempt: undefined, nodePane: 'instructions' });
    const multipleHtml = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(NodeRuntime, { api, scope: 'scope-1', runId: 'run-1', occurrenceId: occurrence.id, contexts: multiple.contexts, onSelectAttempt: vi.fn() })));
    expect(multipleHtml).toContain('请明确选择');
    expect(multipleHtml).toContain('<option value="" disabled="" selected=""');
  });
  it('keeps an Agent attempt readable when no started event was saved', () => {
    const api = new SpaceApi('/api/workflow-spaces/v1', 'space-1');
    const client = new QueryClient();
    const page: OccurrenceRuntimeDto = { runId: 'run-1', occurrenceId: 'occ-1', versionId: 'v1', stepRunId: 'agent-step', attemptId: 'agent-attempt', contextId: 'agent-context', sessionId: 'agent-session', frozenPrompt: null, frozenPromptCoverage: 'unrecorded', contextInstructions: 'saved context', contextInstructionsCoverage: 'full', effectiveConfig: {}, events: [], calls: [], nextCursor: 0, hasMore: false, scanComplete: true, observedCallCount: 0, bodyCoverage: 'full', evidenceScope: 'saved-runner-events-only', snapshotAt: '2026-10-10T00:00:00Z', sanitized: true };
    client.setQueryData(['space', 'scope-1', api.root, 'occurrence-runtime', 'run-1', 'occ-1', 'agent-attempt'], { pages: [page], pageParams: [0] });
    const contexts: OccurrenceDetailDto['contexts'] = [{ id: 'agent-context', nodeId: 'author', stepRunId: 'agent-step', attemptId: 'agent-attempt', producer: 'agent', instructions: 'saved context', model: null, reasoningEffort: null, effectiveConfig: {}, sessionId: 'agent-session' }];
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(NodeRuntime, { api, scope: 'scope-1', runId: 'run-1', occurrenceId: 'occ-1', contexts, selectedAttempt: 'agent-attempt', onSelectAttempt: vi.fn() })));
    expect(html).toContain('agent-attempt');
    expect(html).toContain('没有 siwc.started 记录');
    expect(html).toContain('不能推断模型没有收到指令');
  });
});
