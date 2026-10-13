import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { WorkflowEntrypoint, WorkflowEntrypointDraft } from './types.js';
import type { WorkflowPresentationDraft } from './presentation.js';
import type { ProcessView } from './process-projection.js';
import type { RunGraphAssets } from './run-graph-assets.js';
import { projectExpectedAssets } from './expected-assets.js';
import { buildWorkflowGraphState, workflowGraphStateBridgeScript } from './graph-state.js';
import { workflowInitialFitScript } from './workflow-fit.js';

export interface WorkflowDiagramOptions {
  entry: WorkflowEntrypoint | WorkflowEntrypointDraft;
  presentation?: WorkflowPresentationDraft;
  selectedNodeId?: string;
  detailBase: string;
  view?: ProcessView;
  actualAssets?: RunGraphAssets;
}

const vendor = new URL('./third-party/archify/', import.meta.url);
const categories = new Set(['agent-sdk', 'codex', 'program', 'human', 'decision']);
type Category = 'agent-sdk' | 'codex' | 'program' | 'human' | 'decision' | 'group' | 'unknown-agent';

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function diagramLabel(value: string): string {
  const characters = Array.from(value);
  let units = 0, result = '';
  for (const character of characters) {
    const width = character.codePointAt(0)! > 127 ? 2 : 1;
    if (units + width > 18) return `${result}…`;
    result += character; units += width;
  }
  return result;
}

function nodeCategory(entry: WorkflowEntrypoint | WorkflowEntrypointDraft, node: NonNullable<WorkflowEntrypoint['process']>['nodes'][number]): Category {
  const definition = entry.nodeDefinitions?.[node.id];
  const family = definition?.executor?.family;
  if (family && categories.has(family)) return family as Category;
  if (node.kind === 'program' || node.kind === 'human' || node.kind === 'decision') return node.kind;
  if (node.kind === 'group') return 'group';
  const legacy = definition?.configuration?.executor;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy) &&
      ((legacy as Record<string, unknown>).adapter === 'SIWC Responses' ||
       (legacy as Record<string, unknown>).kind === 'siwc-responses')) return 'agent-sdk';
  return 'unknown-agent';
}

function columns(entry: WorkflowEntrypoint | WorkflowEntrypointDraft): Map<string, number> {
  const process = entry.process!;
  const depth = new Map(process.nodes.map(node => [node.id, 0]));
  // The published contract allows only explicit, bounded rework cycles.
  for (let pass = 0; pass < process.nodes.length; pass++) {
    let changed = false;
    for (const edge of process.edges) {
      if (edge.kind === 'rework') continue;
      const next = Math.min(5, (depth.get(edge.from) ?? 0) + 1);
      if (next > (depth.get(edge.to) ?? 0)) { depth.set(edge.to, next); changed = true; }
    }
    if (!changed) break;
  }
  return depth;
}

const categoryCss = `
/* Workflow Space categories extend Archify's infrastructure palette. */
svg .c-agent-sdk{fill:#102e5c;stroke:#6aaaff}svg .t-agent-sdk{fill:#90c5ff}
svg .c-codex{fill:#30204d;stroke:#ba8cff}svg .t-codex{fill:#d1a7ff}
svg .c-program{fill:#273039;stroke:#9ba9b8}svg .t-program{fill:#b8c3ce}
svg .c-human{fill:#103f44;stroke:#56d0ca}svg .t-human{fill:#78dfd8}
svg .c-decision{fill:#503216;stroke:#efad58}svg .t-decision{fill:#ffd08a}
svg .c-unknown-agent{fill:#313646;stroke:#9aa6c6}svg .t-unknown-agent{fill:#bac5e0}
svg .c-group{fill:#252a35;stroke:#9099a9}svg .t-group{fill:#b3bbc8}
svg [data-workflow-status="none"] > rect:not(.c-mask){stroke-dasharray:4 3;opacity:.74}
svg [data-workflow-status="succeeded"] > rect:not(.c-mask){stroke:#65d6a0}
svg [data-workflow-status="failed"] > rect:not(.c-mask),svg [data-workflow-status="blocked"] > rect:not(.c-mask){stroke:#ff7373;stroke-width:2.5}
svg [data-workflow-status="running"] > rect:not(.c-mask),svg [data-workflow-status="needs_review"] > rect:not(.c-mask){stroke:#f5c566;stroke-width:2.5}
svg [data-workflow-status="mixed"] > rect:not(.c-mask){stroke:#c2a7e8;stroke-dasharray:3 2}
svg [data-workflow-route="selected"]{stroke:#f5c566;stroke-dasharray:5 4;stroke-width:2.2}
svg [data-workflow-route="traversed"]{stroke:#65d6a0;stroke-width:2.2}
svg [data-workflow-route="traversed"][data-workflow-route-evidence="derived"]{stroke:#9ba9b8;stroke-dasharray:2 3}
svg [data-workflow-selected] > rect:not(.c-mask){stroke-width:3}
svg [data-node-id] .t-primary{fill:#f0f5ff}svg [data-node-id] .t-muted{fill:#bfcde2}
svg [data-expected-asset] > rect:not(.c-mask){fill:#173b38;stroke:#66cbb5;stroke-dasharray:5 3}
svg [data-expected-asset] .t-primary{fill:#d5fff5}
svg [data-expected-asset] .t-muted{fill:#9addcf}
svg [data-actual-asset] > rect:not(.c-mask){fill:#173b38;stroke:#5edbb0;stroke-width:2}
svg [data-actual-asset] .t-primary{fill:#dcfff3}svg [data-actual-asset] .t-muted{fill:#a9e7d3}
svg .workflow-data-edge{fill:none;stroke:#9bd7c7;stroke-width:1.35;stroke-dasharray:5 4;opacity:.24;pointer-events:none}
svg .workflow-data-edge[data-edge-kind="produces"]{stroke:#4fd1b7;stroke-width:1.8;stroke-dasharray:none;opacity:.7}
svg[data-focus-active] .workflow-data-edge:not([data-data-active]){opacity:.04}
svg .workflow-data-edge[data-data-active]{stroke-width:2.35;opacity:.96}
svg [data-handoff-related] > rect:not(.c-mask){stroke:#a9f1de;stroke-width:2.6}
svg[data-focus-active] [data-node-id][data-handoff-related]{opacity:1}
html[data-theme="light"] .workflow-legend{color:#455a73}html[data-theme="light"] .workflow-legend strong{color:#263e5d}
.workflow-legend{display:flex;flex-wrap:wrap;gap:8px 16px;padding:10px 14px;margin:0 0 12px;border:1px solid #52607955;border-radius:9px;font:12px system-ui;color:#bbc8dd}
.workflow-legend strong{color:#e3eaf5;margin-right:5px}.workflow-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
`;

export async function renderWorkflowDiagram({entry, presentation, selectedNodeId, detailBase: _detailBase, view, actualAssets}: WorkflowDiagramOptions): Promise<string> {
  if (!entry.process?.nodes.length) throw new Error('Workflow diagram requires a process contract');
  const process = entry.process;
  const state = view ? buildWorkflowGraphState({...view,contract:view.contract??process}) : null;
  const nodeStates = new Map(state?.nodes.map(node=>[node.id,node]) ?? []);
  // Definition mode uses contracts only. A run diagram remains a picture of
  // observed node execution; it never creates actual assets from expectations.
  const expected = view ? null : projectExpectedAssets(entry, presentation);
  const assetIds = new Set([...(expected?.assets.map(asset => asset.id) ?? []),...(view ? actualAssets?.assets.map(asset=>asset.id)??[] : [])]);
  if (process.nodes.some(node => assetIds.has(node.id))) throw new Error('Asset ID conflicts with a process node ID');
  const ids = new Set([...process.nodes.map(node => node.id), ...assetIds]);
  // Archify requires an alphabetic initial character, while saved asset UUIDs
  // commonly start with a digit. Alias only inside the compiler, then restore
  // exact version IDs in the SVG and its selection bridge.
  const compilerIds=new Map<string,string>();
  const usedCompilerIds=new Set(ids);
  for(const id of assetIds)if(!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)){
    let alias=`asset_${Buffer.from(id,'utf8').toString('hex')}`;
    while(usedCompilerIds.has(alias))alias=`asset_${alias}`;
    compilerIds.set(id,alias);usedCompilerIds.add(alias);
  }
  if (selectedNodeId && !ids.has(selectedNodeId)) throw new Error('Selected node is not in process contract');
  const stageLabels = new Map(presentation?.stages?.map(stage => [stage.id, stage.label]) ?? []);
  const col = columns(entry);
  const methodColumn = (nodeId: string): number => col.get(nodeId) ?? 0;
  const byColumn = new Map<number,string[]>();
  for (const node of process.nodes) {const column=methodColumn(node.id);byColumn.set(column,[...(byColumn.get(column) ?? []),node.id]);}
  const assetColumns = new Map<string,string[]>();
  const assetColumnById = new Map<string, number>();
  const assetLane = (asset: NonNullable<typeof expected>['assets'][number]): string => asset.source.kind === 'run-input' ? 'run-inputs' : 'expected-outputs';
  const columnKey = (lane: string, column: number): string => `${lane}:${column}`;
  const placeAsset = (asset: NonNullable<typeof expected>['assets'][number], column: number): void => {
    assetColumnById.set(asset.id, column);
    const key=columnKey(assetLane(asset),column);
    assetColumns.set(key, [...(assetColumns.get(key) ?? []), asset.id]);
  };
  // The most widely consumed frozen inputs lead the input lane. This uses
  // declared bindings only; it does not infer a temporal order from slot names.
  (expected?.assets.filter(asset => asset.source.kind === 'run-input') ?? [])
    .sort((left,right)=>right.consumers.length-left.consumers.length)
    .forEach((asset,index) => placeAsset(asset,Math.min(5,Math.floor(index/2))));
  for (const asset of expected?.assets ?? []) {
    if (asset.source.kind === 'node-output') placeAsset(asset, methodColumn(asset.source.nodeId));
  }
  const actualById=new Map((view?actualAssets?.assets??[]:[]).map(asset=>[asset.id,asset]));
  for(const [index,asset] of [...actualById.values()].filter(asset=>asset.kind==='frozen-input').entries()){
    const key=columnKey('actual-inputs',Math.min(5,index));
    assetColumns.set(key,[...(assetColumns.get(key)??[]),asset.id]);assetColumnById.set(asset.id,Math.min(5,index));
  }
  for(const asset of actualById.values())if(asset.kind==='published-output'){
    const column=methodColumn(asset.producerNodeId??'');const key=columnKey('actual-outputs',column);
    assetColumns.set(key,[...(assetColumns.get(key)??[]),asset.id]);assetColumnById.set(asset.id,column);
  }
  const assetColumn = (asset: NonNullable<typeof expected>['assets'][number]): number => assetColumnById.get(asset.id)!;
  const dataEdges = [
    ...(expected?.assets.flatMap(asset => asset.producer ? [{
      id:`expected_producer_${asset.id}`,from:asset.producer.nodeId,to:asset.id,assetId:asset.id,kind:'produces' as const,
    }] : []) ?? []),
    ...(expected?.dependencies.map(dependency => ({
      id:`expected_dependency_${Buffer.from(dependency.id, 'utf8').toString('hex')}`,
      from:dependency.assetId,to:dependency.to.nodeId,assetId:dependency.assetId,kind:'consumes' as const,
    })) ?? []),
    ...(view?actualAssets?.relations.map((relation,index)=>({
      id:`actual_${relation.kind}_${index}`,from:relation.kind==='produces'?relation.nodeId:relation.assetId,
      to:relation.kind==='produces'?relation.assetId:relation.nodeId,assetId:relation.assetId,kind:relation.kind,
    }))??[]:[]),
  ];
  const routeLabels:Record<string,string>={pass:'通过',blocked:'阻塞','not-converged':'未收敛',reframe:'重新定位',research:'补充研究',rewrite:'重新写稿'};
  const edgeLabel=(edge:typeof process.edges[number])=>edge.kind==='fork'?'并行审阅':edge.kind==='join'?'汇合':edge.route?routeLabels[edge.route]??edge.route:edge.kind==='rework'?'返工':edge.kind==='condition'?'条件':'';
  const workflow = {
    schema_version: 2, diagram_type: 'workflow',
    meta: {locale:'zh-CN',title: presentation?.label || entry.workflowId, subtitle: presentation?.purpose || '', output: 'workflow.html', animation: 'none', visual_preset: 'signal-flow', legend: {mode:'hidden'}},
    lanes: [...(expected?.assets.some(asset=>asset.source.kind==='run-input') ? [{id:'run-inputs',label:'运行输入 · 冻结类型'}] : []),
      ...(actualById.size&&[...actualById.values()].some(asset=>asset.kind==='frozen-input')?[{id:'actual-inputs',label:'本次运行 · 冻结输入'}]:[]),
      {id:'workflow',label:'完整流程'},
      ...(expected?.assets.some(asset=>asset.source.kind==='node-output') ? [{id:'expected-outputs',label:'预期输出 · 方法合同'}] : []),
      ...(actualById.size&&[...actualById.values()].some(asset=>asset.kind==='published-output')?[{id:'actual-outputs',label:'本次运行 · 已发布资产'}]:[])],
    nodes: [...process.nodes.map(node => ({
      id:node.id,lane:'workflow',col:methodColumn(node.id),type:nodeCategory(entry,node),
      label:diagramLabel(stageLabels.get(node.id) ?? node.id),sublabel:({'agent-sdk':'SDK Agent',codex:'Codex',program:'程序',human:'人工参与',decision:'条件判断',group:'分组','unknown-agent':'Agent · 执行器未声明'} as const)[nodeCategory(entry,node)],
      tag:nodeStates.get(node.id)?.label ?? (view?'无执行证据':'方法定义'),width:164,height:94,
      yOffset:((byColumn.get(methodColumn(node.id))?.indexOf(node.id) ?? 0) - ((byColumn.get(methodColumn(node.id))?.length ?? 1)-1)/2)*128,
    })), ...(expected?.assets.map(asset => ({
      id:asset.id,lane:assetLane(asset),col:assetColumn(asset),type:'external',
      label:diagramLabel(asset.label),sublabel:asset.source.kind === 'run-input' ? '运行输入类型' : '预期输出类型',
      tag:asset.resultRoles.length ? `结果 · ${asset.resultRoles.join('、')}` : '方法合同',
      width:176,height:76,
      yOffset:((assetColumns.get(columnKey(assetLane(asset),assetColumn(asset)))?.indexOf(asset.id) ?? 0) -
        ((assetColumns.get(columnKey(assetLane(asset),assetColumn(asset)))?.length ?? 1)-1)/2)*94,
    })) ?? []),...([...actualById.values()].map(asset=>{
      const lane=asset.kind==='frozen-input'?'actual-inputs':'actual-outputs';
      const column=assetColumnById.get(asset.id)??0;
      const label=presentation?.assetViews.find(item=>item.schema.namespace===asset.schema.namespace&&item.schema.revision===asset.schema.revision&&item.schema.hash===asset.schema.hash)?.label??asset.slots[0]??asset.schema.namespace;
      return {id:compilerIds.get(asset.id)??asset.id,lane,col:column,type:'external',label:diagramLabel(label),
        sublabel:asset.kind==='frozen-input'?'冻结输入资产':'已发布资产',tag:asset.slots.join('、')||'已发布',width:176,height:76,
        yOffset:((assetColumns.get(columnKey(lane,column))?.indexOf(asset.id)??0)-((assetColumns.get(columnKey(lane,column))?.length??1)-1)/2)*94};
    }))],
    edges: process.edges.map(edge => ({id:edge.id,from:edge.from,to:edge.to,
      ...(edgeLabel(edge)?{label:edgeLabel(edge)}:{}),
      variant:edge.kind === 'rework' ? 'dashed' : 'default',
      role:edge.kind === 'rework' ? 'return' : edge.kind === 'condition' || edge.kind === 'fork' ? 'branch' : 'main',
    })),
  };
  const compilerPath = fileURLToPath(new URL('renderers/workflow/workflow-compiler.mjs', vendor));
  const {compileWorkflow} = await import(compilerPath);
  const compiled = compileWorkflow({workflow});
  if (!compiled.ok) throw new Error(`Archify workflow compilation failed: ${compiled.error || JSON.stringify(compiled.diagnostics)}`);
  let svg = (compiled.svg as string).replace('<svg ', '<svg data-animation="none" ');
  for(const [id,alias] of compilerIds){
    svg=svg.replaceAll(`data-node-id="${alias}"`,`data-node-id="${escapeHtml(id)}"`)
      .replaceAll(`id="node-${alias}"`,`id="node-${escapeHtml(id)}"`);
  }
  // Archify lays out the method and asset nodes. Data handoffs are a separate
  // semantic layer: its control-route solver cannot route dense CONTENT bindings.
  const exactByCompiler=new Map([...compilerIds].map(([id,alias])=>[alias,id]));
  const positions = new Map((compiled.receipt.nodes as Array<{id:string;x:number;y:number;width:number;height:number}>).map(node => [exactByCompiler.get(node.id)??node.id, node]));
  const dataPaths = dataEdges.flatMap(edge => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    if (!from || !to) return [];
    const x1 = from.x + from.width / 2, x2 = to.x + to.width / 2;
    const downward = to.y + to.height / 2 > from.y + from.height / 2;
    const y1 = downward ? from.y + from.height : from.y;
    const y2 = downward ? to.y : to.y + to.height;
    const mid = (y1 + y2) / 2;
    const nodeId=edge.kind==='produces'?edge.from:edge.to;
    return [`<path class="workflow-data-edge${expected?' expected-data-edge':' actual-data-edge'}" data-edge-id="${escapeHtml(edge.id)}" data-graph-asset-id="${escapeHtml(edge.assetId)}"${expected?` data-expected-asset-id="${escapeHtml(edge.assetId)}"`:''} data-handoff-node-id="${escapeHtml(nodeId)}" data-edge-kind="${edge.kind}" d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" marker-end="url(#arrowhead-dashed)"${edge.assetId === selectedNodeId || nodeId === selectedNodeId ? ' data-data-active=""' : ''}/>`];
  }).join('');
  if (dataPaths) svg = svg.replace('<!-- Nodes -->', `<g class="workflow-data-edges ${expected?'expected-data-edges':'actual-data-edges'}" aria-label="${expected?'预期资产':'真实资产'}生产与消费关系">${dataPaths}</g>\n<!-- Nodes -->`);
  // Archify escapes IDs and labels in SVG attributes. Only attach bounded, server-computed metadata.
  svg = svg.replace(/<g ([^>]*data-node-id="([^"]+)"[^>]*)>/g, (match, attrs: string, encodedId: string) => {
    if (assetIds.has(encodedId)) {
      const actual=actualById.get(encodedId);
      const expectedAsset=expected?.assets.find(item=>item.id===encodedId);
      const kind=actual?(actual.kind==='frozen-input'?'冻结输入':'已发布资产'):(expectedAsset?.source.kind==='run-input'?'运行输入':'预期输出');
      const label=actual?(presentation?.assetViews.find(item=>item.schema.namespace===actual.schema.namespace&&item.schema.revision===actual.schema.revision&&item.schema.hash===actual.schema.hash)?.label??actual.slots[0]??actual.schema.namespace):expectedAsset!.label;
      const accessible=attrs.replace(/aria-label="[^"]*"/,`aria-label="${kind}：${escapeHtml(label)}；点击阅读${actual?'真实资产':'资产合同'}"`);
      return `<g ${accessible} ${actual?'data-actual-asset':'data-expected-asset'}=""${encodedId === escapeHtml(selectedNodeId ?? '') ? ' data-workflow-selected=""' : ''}>`;
    }
    const node = process.nodes.find(item => escapeHtml(item.id) === encodedId);
    if (!node) return match;
    const status = ` data-workflow-status="${escapeHtml(nodeStates.get(node.id)?.state ?? (view?'none':'method'))}"`;
    return `<g ${attrs}${status}${node.id === selectedNodeId ? ' data-workflow-selected=""' : ''}>`;
  });
  const {applyTemplate} = await import(fileURLToPath(new URL('renderers/shared/utils.mjs', vendor)));
  const template = await readFile(new URL('assets/template.html', vendor), 'utf8');
  const html = applyTemplate(template, {title:workflow.meta.title,subtitle:workflow.meta.subtitle,svg,cards:'',locale:'zh-CN',visualPreset:'signal-flow'});
  const selectorScript = `<script>\n(function(){
  var ids = new Set(${safeScriptJson([...ids])});
  var assetIds = new Set(${safeScriptJson([...assetIds])});
  var selected = ${safeScriptJson(selectedNodeId ?? null)};
  var svg=document.querySelector('.diagram-container svg');
  function highlightData(id){
    if(!svg)return;
    var relatedAssets=new Set(),relatedNodes=new Set();
    svg.querySelectorAll('.workflow-data-edge').forEach(function(edge){
      var assetId=edge.getAttribute('data-graph-asset-id');
      var nodeId=edge.getAttribute('data-handoff-node-id');
      var active=assetIds.has(id)?assetId===id:nodeId===id;
      if(active){edge.setAttribute('data-data-active','');relatedAssets.add(assetId);relatedNodes.add(nodeId);}
      else edge.removeAttribute('data-data-active');
    });
    svg.querySelectorAll('[data-node-id]').forEach(function(node){
      var nodeId=node.getAttribute('data-node-id');
      if(relatedAssets.has(nodeId)||relatedNodes.has(nodeId))node.setAttribute('data-handoff-related','');
      else node.removeAttribute('data-handoff-related');
    });
  }
  function selectedNode(event){
    var node = event.target && event.target.closest && event.target.closest('[data-node-id]');
    if(!node) return;
    var id = node.getAttribute('data-node-id');
    if(!ids.has(id)) return;
    highlightData(id);
    window.setTimeout(function(){ window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*'); },0);
  }
  document.addEventListener('click',selectedNode,true);
  if(svg){new MutationObserver(function(){var id=svg.getAttribute('data-focus-active');highlightData(id);if(ids.has(id))window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*');}).observe(svg,{attributes:true,attributeFilter:['data-focus-active']});}
  document.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){selectedNode(event);}});
  if(selected){window.addEventListener('load',function(){
    if(window.Archify && Archify.focus && typeof Archify.focus.set==='function') Archify.focus.set(selected,{toggle:false});
  });}
})();\n</script>`;
  const legend = `<div class="workflow-legend" aria-label="节点类型与执行状态"><span><strong>节点</strong></span><span><i style="background:#6aaaff"></i>SDK / 适配器</span><span><i style="background:#ba8cff"></i>Codex</span><span><i style="background:#9ba9b8"></i>程序</span><span><i style="background:#efad58"></i>判断</span><span><i style="background:#56d0ca"></i>人工</span><span><i style="background:#9aa6c6"></i>未知 Agent</span>${expected ? '<span><i style="background:#4fd1b7"></i>资产合同：实线生产 · 虚线消费，选中聚焦相关交接</span>' : ''}${view&&actualById.size?'<span><i style="background:#5edbb0"></i>真实资产：实线已生产 · 虚线已消费；未发布响应在执行记录中</span>':''}<span><strong>边框</strong>绿色 成功 · 红色 失败/阻塞 · 黄色 运行/待审 · 虚线 无执行证据</span></div>`;
  const gapDetails = expected?.gaps.length ? `<details class="workflow-legend"><summary>方法合同缺少 ${expected.gaps.length} 项资产交接信息</summary><ul>${expected.gaps.map(gap => `<li>${escapeHtml(gap.message)}</li>`).join('')}</ul></details>` :
    view&&actualAssets?.gaps.length?`<details class="workflow-legend"><summary>运行图缺少 ${actualAssets.gaps.length} 项准确资产信息</summary><ul>${actualAssets.gaps.map(message=>`<li>${escapeHtml(message)}</li>`).join('')}</ul></details>`:'';
  const runtimeLegend = state ? '<div class="workflow-legend">节点显示各自最近轮次；多分支状态分别保留。连线：绿色 有遍历证据 · 黄色虚线 仅已选择 · 灰色虚线 回溯证据。</div>' : '';
  const stateScript = state ? `<script>${workflowGraphStateBridgeScript(state)}</script>` : '';
  const fitScript = `<script>${workflowInitialFitScript()}</script>`;
  return html.replace('</head>', `<style>${categoryCss}</style>\n</head>`).replace('<div class="diagram-container"', `${legend}${gapDetails}${runtimeLegend}\n<div class="diagram-container"`).replace('</body>', `${selectorScript}${stateScript}${fitScript}\n</body>`);
}

export function diagramFrameMarkup({src,title='Workflow diagram'}:{src:string;title?:string}):string {
  if (!src.startsWith('/') || src.startsWith('//')) throw new Error('Diagram frame source must be a local path');
  return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" sandbox="allow-scripts allow-downloads" loading="lazy"></iframe>`;
}
