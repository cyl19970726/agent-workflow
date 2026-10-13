import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';
import type { ExpectedAssetDto, MethodDesignDefinitionDto } from '@signal-room/workflow-space-api/contracts';
import { focusGraphNode, selectedGraphNode } from './bridge.js';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asText = (value: unknown): string => typeof value === 'string' ? value : '';
const fullJson = (value: unknown): string => JSON.stringify(value, null, 2) || '未记录';
const shown = (value: unknown): string => value === undefined || value === null ? '未记录' : typeof value === 'string' ? value : fullJson(value);

function Field({ label, value, important = false }: { label: string; value: unknown; important?: boolean }) {
  return <div className={`sw-candidate-field${important ? ' important' : ''}`}><strong>{label}</strong><pre>{shown(value)}</pre></div>;
}
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="sw-candidate-detail-section"><h6>{title}</h6>{children}</section>;
}
function Raw({ title, value }: { title: string; value: unknown }) {
  return <details className="sw-candidate-json"><summary>{title}</summary><pre>{fullJson(value)}</pre></details>;
}
const ruleLabels: Record<string, string> = {
  input: '判断输入', beforeRoute: '路由前校验', decisionOrder: '按顺序执行的分支判断',
  maxTotalReworkTraversals: '所有返工分支共用上限', reworkBranchesShareLimit: '返工上限是否共用',
  decisionRecord: '保存的决策记录', runtimeBehavior: '运行行为', creatorAuthority: '创作者权限',
  implementedCommands: '已实现操作', automaticContinuation: '是否自动续行',
};
const frozenRuleText: Record<string, string> = {
  'published editor review.verdict': '已发布编辑复核的结论（verdict）',
  'published editor review.route': '已发布编辑复核的路由（route）',
  'contentAcceptanceFailures guardFailures': '内容验收失败项（guardFailures）',
  'business round index': '当前业务轮次编号',
  'frozen maxRevisions=1': '冻结的最多一次返工上限',
  'current draft': '当前草稿',
  'current editor review': '当前编辑复核',
  'latest research': '最近一次研究',
  'Reject structurally invalid review or reviewRouteFailures before review publication': '编辑复核结构不合法或路由校验失败时，先拒绝发布该复核。',
  'pass verdict and pass route with zero guardFailures => needs_review awaiting-human-review': '结论与路由均通过且无验收失败：记录待人工审阅，停止本次运行。',
  'strict routing: pass verdict with guardFailures => needs_review not-converged': '即使结论为通过，只要仍有验收失败：记录未收敛并停止。',
  'blocked verdict or blocked route => needs_review blocked': '结论或路由被阻止：记录阻止状态并停止。',
  'round index >= 1 => needs_review not-converged': '已到第 1 轮或更后：记录未收敛并停止。',
  'otherwise route rewrite to author; research or reframe to researcher': '其余情况：重写交作者；补研究或重定方向交研究者。',
  'content-route-{round} with route, verdict, guardFailures, round': '保存 content-route-{round} 控制决策记录，含 route、verdict、guardFailures、round。',
  'needs_review records a creator-facing handoff and stops this run': '记录面向创作者的 needs_review 交接，并停止本次运行。',
  'creator may decide acceptance, revision, or stopping outside this run': '创作者在本次运行之外决定接受、修改或停止。',
  'CONTENT rounds 0 and 1 inclusive; a technical retry does not consume a business round': '业务轮次包含第 0 轮和第 1 轮；技术重试不消耗业务轮次。',
};
export const readableFrozenRule = (value: unknown): unknown => typeof value === 'string' ? frozenRuleText[value] ?? value : Array.isArray(value) ? value.map(readableFrozenRule) : value;
function RuleFields({ value }: { value: Data }) {
  return <>{Object.entries(value).flatMap(([key, item]) => {
    const nested = object(item);
    return Object.keys(nested).length && (key === 'programRouting' || key === 'handoff')
      ? Object.entries(nested).map(([part, detail]) => <Field key={`${key}.${part}`} label={ruleLabels[part] || part} value={key === 'handoff' && part === 'implementedCommands' && Array.isArray(detail) && detail.length === 0 && nested.runtimeBehavior === 'needs_review records a creator-facing handoff and stops this run' ? '未声明已实现的人工操作命令；这里只记录 needs_review 交接并停止本次运行。' : key === 'handoff' && part === 'automaticContinuation' && detail === false ? '不会自动继续本次运行。' : readableFrozenRule(detail)} />)
      : [<Field key={key} label={ruleLabels[key] || key} value={readableFrozenRule(item)} />];
  })}</>;
}

/** All links come from the exact candidate response; this check keeps the iframe on its scoped diagram endpoint. */
export function exactCandidateDiagramUrl(definition: MethodDesignDefinitionDto, apiRoot: string): string | null {
  if (!definition.diagramUrl || !definition.diagramUrl.startsWith('/') || definition.diagramUrl.startsWith('//')) return null;
  try {
    const url = new URL(definition.diagramUrl, 'https://candidate.invalid');
    return url.pathname === `${apiRoot}/method-design/diagram` && url.searchParams.get('revision') === definition.designRevisionId && url.searchParams.get('expectedCandidateId') === definition.candidateId && url.searchParams.get('embed') === '1' ? definition.diagramUrl : null;
  } catch { return null; }
}

export function candidateReasoning(definition: Data): unknown {
  const configuration = object(definition.configuration);
  return object(configuration.stageDeclaration).reasoningEffort ?? definition.reasoningEffort;
}
export function candidateBudget(version: Data): unknown {
  const config = object(version.config);
  return object(config.policy).budget ?? config.budget;
}

export function candidateAssetSchema(asset: ExpectedAssetDto, schemas: Array<Record<string, unknown>>): { definition: Data | null; reason: string | null } {
  if (!asset.schema) return { definition: null, reason: '这项预期资产没有记录准确 schema 引用。' };
  const matches = schemas.filter(item => item.namespace === asset.schema?.namespace && item.revision === asset.schema?.revision);
  if (matches.length !== 1) return { definition: null, reason: matches.length ? '候选 schema 列表中有多个相同 namespace／revision，无法确定准确字段定义。' : '候选 schema 列表中找不到这项资产引用的 namespace／revision。' };
  return { definition: matches[0]!, reason: null };
}

function AssetDetail({ asset, schemas, select }: { asset: ExpectedAssetDto; schemas: Array<Record<string, unknown>>; select: (id: string) => void }) {
  const matchedSchema = candidateAssetSchema(asset, schemas);
  return <div className="sw-candidate-detail-content">
    <p className="sw-candidate-detail-kind">预期资产合同 · {asset.source.kind === 'run-input' ? '运行输入类型' : '节点产出类型'}</p>
    <h5>{asset.label}</h5><p className="sw-muted">这是候选方法声明的资产类型，不代表已产生真实资产。</p>
    <DetailSection title="来源与生产者"><Field label="准确来源" value={asset.source} />{asset.producer && <button className="sw-link" onClick={() => select(asset.producer!.nodeId)}>查看生产环节 · {asset.producer.nodeId}.{asset.producer.port}</button>}</DetailSection>
    <DetailSection title="Schema 与结果用途"><Field label="准确引用 · namespace / revision / hash" value={asset.schema} />{matchedSchema.definition ? <><Field label="完整 JSON Schema 字段" value={matchedSchema.definition.schema} important /><Field label="Schema 方言与登记信息" value={{ namespace: matchedSchema.definition.namespace, revision: matchedSchema.definition.revision, dialect: matchedSchema.definition.dialect }} /></> : <p role="alert">{matchedSchema.reason}</p>}<Field label="结果角色" value={asset.resultRoles} /></DetailSection>
    <DetailSection title="下游消费者与选择规则">{asset.consumers.length ? asset.consumers.map((consumer, index) => <div className="sw-candidate-contract" key={`${consumer.nodeId}:${consumer.port}:${index}`}><button className="sw-link" onClick={() => select(consumer.nodeId)}>{consumer.nodeId}.{consumer.port}</button><span>选择：{consumer.selection}{consumer.when ? ` · ${consumer.when}` : ''}</span></div>) : <p className="sw-muted">未声明下游消费者。</p>}</DetailSection>
    {asset.missing.length > 0 && <Field label="合同缺口" value={asset.missing} />}
    <Raw title="完整资产合同 JSON" value={asset} />{matchedSchema.definition && <Raw title="同一候选的完整 Schema 登记 JSON" value={matchedSchema.definition} />}
  </div>;
}

function NodeDetail({ id, node, definition, entry, process, presentation, budget, select }: { id: string; node: Data; definition: Data; entry: Data; process: Data; presentation: Data; budget: unknown; select: (id: string) => void }) {
  const stage = array(presentation.stages).map(object).find(value => value.id === id) || {};
  const configuration = object(definition.configuration);
  const stageDeclaration = object(configuration.stageDeclaration);
  const executor = object(definition.executor);
  const storage = object(object(entry.storageContract).nodes);
  const storageNode = object(storage[asText(node.storageNodeId)]);
  const dataBindings = array(process.dataBindings).map(object);
  const incoming = dataBindings.filter(binding => object(binding.to).node === id);
  const outgoing = dataBindings.filter(binding => object(binding.from).node === id);
  const edges = array(process.edges).map(object);
  const before = edges.filter(edge => edge.to === id);
  const after = edges.filter(edge => edge.from === id);
  const agent = node.kind === 'agent' || executor.family === 'agent-sdk' || executor.family === 'codex';
  const kind = node.kind === 'human' || executor.family === 'human' ? '人工关口' : node.kind === 'decision' || executor.family === 'decision' ? '程序判断' : node.kind === 'group' ? '结束／分组' : agent ? 'Agent' : '程序环节';
  const tools = array(definition.toolDefinitions).map(object);
  const toolContract = object(configuration.toolContract);
  const response = object(toolContract.response);
  const routing = object(configuration.programRouting);
  const handoff = object(configuration.handoff);
  const control = Object.keys(routing).length ? routing : Object.keys(handoff).length ? handoff : null;
  return <div className="sw-candidate-detail-content">
    <p className="sw-candidate-detail-kind">{kind} · {id}</p><h5>{asText(stage.label) || asText(definition.purpose) || id}</h5>
    <p className="sw-candidate-purpose">{asText(stage.description) || asText(definition.purpose) || '该候选未单列职责说明。'}</p>
    <DetailSection title="职责与执行类型"><Field label="专业职责" value={stage.description ?? definition.purpose} /><Field label="候选用途说明" value={definition.purpose} /><Field label="执行器" value={definition.executor ?? node.kind} /></DetailSection>
    {agent && <>
      <DetailSection title="完整实际指令"><Field label="本候选的完整 Prompt" value={definition.instructions} important /></DetailSection>
      <DetailSection title="模型与推理"><div className="sw-candidate-pair"><Field label="模型" value={definition.model} /><Field label="推理等级" value={candidateReasoning(definition)} /></div><Field label="输出格式" value={stageDeclaration.outputSchema ?? definition.outputSchema} /></DetailSection>
      <DetailSection title="可见上下文与隔离"><Field label="允许的上下文" value={configuration.contextPolicy} />{configuration.deniedContext !== undefined || configuration.contextExclusions !== undefined || configuration.forbiddenContext !== undefined ? <Field label="排除／隔离条件" value={configuration.deniedContext ?? configuration.contextExclusions ?? configuration.forbiddenContext} /> : <p className="sw-muted">候选仅声明以上允许上下文，未单列排除清单。</p>}<Field label="来源解析规则" value={configuration.sourceResolver} /></DetailSection>
      <DetailSection title="工具与权限"><Field label="工具允许列表" value={definition.tools ?? object(configuration.executor).tools} /><Field label="工具策略" value={configuration.toolPolicy} />{tools.length ? tools.map((tool, index) => <div className="sw-candidate-contract" key={`${tool.name}:${index}`}><h6>{asText(tool.name) || `工具 ${index + 1}`}</h6><Field label="说明" value={tool.description} /><Field label="必填输入与完整 JSON Schema" value={tool.parameters ?? tool.inputSchema} /><Field label="成功返回字段与实际类型" value={tool.outputSchema ?? tool.returns} /><Field label="成功响应语义" value={response.success} /><Field label="拒绝或隔离响应" value={response.denial ?? response.quarantine} /><Field label="执行错误" value={response.executionError} /><Field label="工具权限" value={toolContract.permissions ?? tool.permissions ?? tool.policy} /></div>) : <p className="sw-muted">此环节未声明可用工具。</p>}<Field label="执行权限" value={{ permissionsRevision: stageDeclaration.permissionsRevision, threadOptions: stageDeclaration.threadOptions, executor: configuration.executor }} /></DetailSection>
    </>}
    {!agent && <DetailSection title={kind === '人工关口' ? '人工判断与放行条件' : '程序规则与分支条件'}><RuleFields value={configuration} />{asText(definition.instructions) && <Field label="规则说明" value={definition.instructions} />}<Field label="入口条件" value={before} /><Field label="去向与返工上限" value={after} /></DetailSection>}
    <DetailSection title="输入与上游">{control && control.input !== undefined ? <Field label="控制判断所读信息（非业务资产端口）" value={readableFrozenRule(control.input)} /> : null}{node.inputs !== undefined && <Field label="流程输入端口" value={node.inputs} />}{storageNode.inputs !== undefined && <Field label="保存输入合同" value={storageNode.inputs} />}{incoming.length > 0 && <Field label="准确数据来源与选择规则" value={incoming} />}{before.map(edge => <button key={asText(edge.id)} className="sw-link" onClick={() => select(asText(edge.from))}>上游：{asText(edge.from)} · {asText(edge.kind)}</button>)}</DetailSection>
    <DetailSection title="输出、预期资产与下游">{routing.decisionRecord !== undefined && <Field label="控制决策记录（非业务成果资产）" value={readableFrozenRule(routing.decisionRecord)} />}{handoff.runtimeBehavior !== undefined && <Field label="交接与本次运行停止" value={readableFrozenRule(handoff.runtimeBehavior)} />}{node.outputs !== undefined && <Field label="流程输出端口" value={node.outputs} />}{storageNode.outputs !== undefined && <Field label="保存输出合同" value={storageNode.outputs} />}{outgoing.length > 0 && <Field label="输出到下游" value={outgoing} />}{after.map(edge => <button key={asText(edge.id)} className="sw-link" onClick={() => select(asText(edge.to))}>下游：{asText(edge.to)} · {asText(edge.kind)}{edge.maxTraversals === undefined ? '' : ` · 最多 ${edge.maxTraversals} 次`}</button>)}</DetailSection>
    <DetailSection title="预算与停止"><Field label="候选预算声明" value={budget} />{routing.maxTotalReworkTraversals === 1 && routing.reworkBranchesShareLimit === true && <p>所有返工分支共用最多一次返工；这不是每条分支各一次。</p>}{object(budget).semantics !== undefined && <Field label="业务轮次与技术重试" value={readableFrozenRule(object(budget).semantics)} />}<Field label="本环节修复与限制" value={configuration.repairPolicy ?? configuration.budgetPolicy} /></DetailSection>
    <Raw title="此环节完整候选定义 JSON" value={{ processNode: node, nodeDefinition: definition, storageNode, stage }} />
  </div>;
}

/** One large, stable graph and one exact detail pane. URL selection survives refresh and browser Back. */
export function MethodCandidate({ definition, apiRoot, registeredVersionId, onOpenRegistered }: { definition: MethodDesignDefinitionDto; apiRoot: string; registeredVersionId?: string; onOpenRegistered?: () => void }) {
  const [params, setParams] = useSearchParams();
  const frame = useRef<HTMLIFrameElement>(null);
  const version = object(definition.version);
  const entry = object(object(version.entrypoints)[definition.entrypoint]);
  const process = object(entry.process);
  const nodeDefinitions = object(entry.nodeDefinitions);
  const nodes = array(process.nodes).map(object);
  const nodeIds = nodes.map(node => asText(node.id)).filter(Boolean);
  const assets = definition.expectedAssets.assets;
  const allowedIds = useMemo(() => new Set([...nodeIds, ...assets.map(asset => asset.id)]), [definition]);
  const requestedCandidate = params.get('candidateVersion');
  const changedCandidate = params.get('candidateDesign') === definition.designRevisionId && !!requestedCandidate && requestedCandidate !== definition.candidateId;
  const selected = params.get('candidateDesign') === definition.designRevisionId && !changedCandidate ? params.get('candidateNode') || null : null;
  const current = selected && allowedIds.has(selected) ? selected : null;
  const selectedNode = nodes.find(node => node.id === current);
  const selectedAsset = assets.find(asset => asset.id === current);
  const presentation = object(definition.presentation);
  const stages = array(presentation.stages).map(object);
  const diagram = exactCandidateDiagramUrl(definition, apiRoot);
  const choose = (id: string | null) => {
    if (id && !allowedIds.has(id)) return;
    if (id === current) return;
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('view', 'workflow'); next.set('tab', 'definition');
      next.set('methodDesignRevision', definition.designRevisionId);
      next.set('candidateDesign', definition.designRevisionId);
      next.set('candidateVersion', definition.candidateId);
      if (id) next.set('candidateNode', id); else next.delete('candidateNode');
      return next;
    });
  };
  useEffect(() => { focusGraphNode(frame.current?.contentWindow || null, current ?? undefined, allowedIds); }, [current, allowedIds]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const id = selectedGraphNode(event, frame.current?.contentWindow || null, allowedIds);
      if (id) choose(id);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [allowedIds, current, definition.designRevisionId, definition.candidateId, setParams]);

  return <section className="sw-candidate" aria-label="准确方法候选定义">
    {changedCandidate && <div className="sw-notice" role="alert"><strong>候选已变化，需要重新核对</strong><p>地址中选择的是候选 {requestedCandidate}，当前实现编译出的候选为 {definition.candidateId}。原选中对象 {params.get('candidateNode') || '无'} 已保留在地址中；确认后才切换图与详情。</p><button onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set('candidateVersion', definition.candidateId); return next; })}>核对并阅读当前候选</button></div>}
    {!changedCandidate && selected && !allowedIds.has(selected) && <div className="sw-notice" role="alert">当前候选没有原选中对象 {selected}；地址中的选择已保留。请从图或索引重新选择。</div>}
    <div className="sw-candidate-heading"><h4>{asText(presentation.label) || '完整候选方法'}</h4><p>设计修订 {definition.designRevisionId} · 候选 {definition.candidateId}。这是基于固定设计与当前实现编译的候选；图与右侧详情来自同一次准确读取。实现变化后需重新预览并核对候选 ID；登记后的准确版本才冻结。登记不表示已经运行、验证或采用。</p>{registeredVersionId && <p>同 ID 准确版本 {registeredVersionId} 已登记。此处是当前实现重新编译的候选预览；请阅读保存的准确版本方法与产出。{onOpenRegistered && <button className="sw-link" onClick={onOpenRegistered}>阅读已登记版本</button>}</p>}</div>
    <div className="sw-candidate-identity"><span>工作流 {definition.workflowId}</span><span>入口 {definition.entrypoint}</span><span>执行条件：{definition.availability.state === 'available' ? '已匹配部署，运行仍需 release 核验' : definition.availability.state === 'unavailable' ? '暂不可执行' : '未知，需核验部署'}{definition.availability.reason ? ` · ${definition.availability.reason}` : ''}</span></div>
    {!changedCandidate && <div className="sw-candidate-workspace">
      <div className="sw-candidate-graph-pane"><div className="sw-candidate-graph-head"><strong>完整方法图</strong><span>点击环节或资产查看准确合同；图上的位置与缩放保持不变。</span></div>{diagram ? <iframe ref={frame} title="准确候选方法与预期产出图" src={diagram} sandbox="allow-scripts allow-downloads" onLoad={() => focusGraphNode(frame.current?.contentWindow || null, current ?? undefined, allowedIds)} /> : <p role="alert">同一设计修订的过程图地址不可用。</p>}</div>
      <aside className="sw-candidate-detail" aria-label="候选节点与资产详情"><div className="sw-candidate-detail-head"><strong>准确合同</strong>{current && <button onClick={() => choose(null)}>收起详情</button>}</div>{selectedAsset ? <AssetDetail asset={selectedAsset} schemas={definition.schemas} select={choose} /> : selectedNode ? <NodeDetail id={asText(selectedNode.id)} node={selectedNode} definition={object(nodeDefinitions[asText(selectedNode.id)])} entry={entry} process={process} presentation={presentation} budget={candidateBudget(version)} select={choose} /> : <div className="sw-candidate-detail-content"><p>从图中选择一个环节或预期资产；这里会显示其实际指令、条件、输入输出与上下游。</p><div className="sw-candidate-node-index">{nodes.map(node => { const id = asText(node.id); const stage = stages.find(item => item.id === id); return <button key={id} onClick={() => choose(id)}>{asText(stage?.label) || id}<small>{id}</small></button>; })}{assets.map(asset => <button key={asset.id} onClick={() => choose(asset.id)}>{asset.label}<small>预期资产</small></button>)}</div></div>}</aside>
    </div>}
    <div className="sw-candidate-panels"><DetailSection title="程序路径与返工"><Field label="控制路由" value={process.edges} /><Field label="完成结果" value={process.results} /></DetailSection><DetailSection title="全局预算与策略"><Field label="预算声明" value={candidateBudget(version)} /><Field label="运行策略" value={object(object(version.config).policy)} /></DetailSection><DetailSection title="冻结依据"><Field label="设计 / 理解 / 能力修订及 hash" value={{ design: [definition.designRevisionId, definition.designPayloadHash], understanding: [definition.understandingRevisionId, definition.understandingPayloadHash], capability: [definition.capabilityRevisionId, definition.capabilityPayloadHash] }} /><Field label="Provider 契约与指纹" value={definition.provider} /></DetailSection></div>
    {definition.expectedAssets.gaps.length ? <Field label="资产合同缺口" value={definition.expectedAssets.gaps} /> : null}
    <Raw title="完整候选版本 JSON" value={definition.version} /><Raw title="完整候选 schema JSON" value={definition.schemas} /><Raw title="完整候选展示定义 JSON" value={definition.presentation} /><Raw title="完整候选响应 JSON" value={definition} />
  </section>;
}
