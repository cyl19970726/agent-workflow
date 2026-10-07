import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { WorkflowEntrypoint, WorkflowEntrypointDraft } from './types.js';
import type { WorkflowPresentationDraft } from './presentation.js';
import type { ProcessView } from './process-projection.js';
import { buildWorkflowGraphState, workflowGraphStateBridgeScript } from './graph-state.js';
import { workflowInitialFitScript } from './workflow-fit.js';

export interface WorkflowDiagramOptions {
  entry: WorkflowEntrypoint | WorkflowEntrypointDraft;
  presentation?: WorkflowPresentationDraft;
  selectedNodeId?: string;
  detailBase: string;
  view?: ProcessView;
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
html[data-theme="light"] .workflow-legend{color:#455a73}html[data-theme="light"] .workflow-legend strong{color:#263e5d}
.workflow-legend{display:flex;flex-wrap:wrap;gap:8px 16px;padding:10px 14px;margin:0 0 12px;border:1px solid #52607955;border-radius:9px;font:12px system-ui;color:#bbc8dd}
.workflow-legend strong{color:#e3eaf5;margin-right:5px}.workflow-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
`;

export async function renderWorkflowDiagram({entry, presentation, selectedNodeId, detailBase: _detailBase, view}: WorkflowDiagramOptions): Promise<string> {
  if (!entry.process?.nodes.length) throw new Error('Workflow diagram requires a process contract');
  const process = entry.process;
  const state = view ? buildWorkflowGraphState({...view,contract:view.contract??process}) : null;
  const nodeStates = new Map(state?.nodes.map(node=>[node.id,node]) ?? []);
  const ids = new Set(process.nodes.map(node => node.id));
  if (selectedNodeId && !ids.has(selectedNodeId)) throw new Error('Selected node is not in process contract');
  const stageLabels = new Map(presentation?.stages?.map(stage => [stage.id, stage.label]) ?? []);
  const col = columns(entry);
  const byColumn = new Map<number,string[]>();
  for (const node of process.nodes) {const column=col.get(node.id) ?? 0;byColumn.set(column,[...(byColumn.get(column) ?? []),node.id]);}
  const routeLabels:Record<string,string>={pass:'通过',blocked:'阻塞','not-converged':'未收敛',reframe:'重新定位',research:'补充研究',rewrite:'重新写稿'};
  const edgeLabel=(edge:typeof process.edges[number])=>edge.kind==='fork'?'并行审阅':edge.kind==='join'?'汇合':edge.route?routeLabels[edge.route]??edge.route:edge.kind==='rework'?'返工':edge.kind==='condition'?'条件':'';
  const workflow = {
    schema_version: 2, diagram_type: 'workflow',
    meta: {locale:'zh-CN',title: presentation?.label || entry.workflowId, subtitle: presentation?.purpose || '', output: 'workflow.html', animation: 'none', visual_preset: 'signal-flow', legend: {mode:'hidden'}},
    lanes: [{id:'workflow',label:'完整流程'}],
    nodes: process.nodes.map(node => ({
      id:node.id,lane:'workflow',col:col.get(node.id) ?? 0,type:nodeCategory(entry,node),
      label:stageLabels.get(node.id) ?? node.id,sublabel:({'agent-sdk':'SDK Agent',codex:'Codex',program:'程序',human:'人工参与',decision:'条件判断',group:'分组','unknown-agent':'Agent · 执行器未声明'} as const)[nodeCategory(entry,node)],
      tag:nodeStates.get(node.id)?.label ?? (view?'无执行证据':'方法定义'),width:164,height:94,
      yOffset:((byColumn.get(col.get(node.id) ?? 0)?.indexOf(node.id) ?? 0) - ((byColumn.get(col.get(node.id) ?? 0)?.length ?? 1)-1)/2)*128,
    })),
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
  // Archify escapes IDs and labels in SVG attributes. Only attach bounded, server-computed metadata.
  svg = svg.replace(/<g ([^>]*data-node-id="([^"]+)"[^>]*)>/g, (match, attrs: string, encodedId: string) => {
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
  var selected = ${safeScriptJson(selectedNodeId ?? null)};
  function selectedNode(event){
    var node = event.target && event.target.closest && event.target.closest('[data-node-id]');
    if(!node) return;
    var id = node.getAttribute('data-node-id');
    if(!ids.has(id)) return;
    window.setTimeout(function(){ window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*'); },0);
  }
  document.addEventListener('click',selectedNode,true);
  var svg=document.querySelector('.diagram-container svg');
  if(svg){new MutationObserver(function(){var id=svg.getAttribute('data-focus-active');if(ids.has(id))window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*');}).observe(svg,{attributes:true,attributeFilter:['data-focus-active']});}
  document.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){selectedNode(event);}});
  if(selected){window.addEventListener('load',function(){
    if(window.Archify && Archify.focus && typeof Archify.focus.set==='function') Archify.focus.set(selected,{toggle:false});
  });}
})();\n</script>`;
  const legend = `<div class="workflow-legend" aria-label="节点类型与执行状态"><span><strong>节点</strong></span><span><i style="background:#6aaaff"></i>SDK / 适配器</span><span><i style="background:#ba8cff"></i>Codex</span><span><i style="background:#9ba9b8"></i>程序</span><span><i style="background:#efad58"></i>判断</span><span><i style="background:#56d0ca"></i>人工</span><span><i style="background:#9aa6c6"></i>未知 Agent</span><span><strong>边框</strong>绿色 成功 · 红色 失败/阻塞 · 黄色 运行/待审 · 虚线 无执行证据</span></div>`;
  const runtimeLegend = state ? '<div class="workflow-legend">节点显示各自最近轮次；多分支状态分别保留。连线：绿色 有遍历证据 · 黄色虚线 仅已选择 · 灰色虚线 回溯证据。</div>' : '';
  const stateScript = state ? `<script>${workflowGraphStateBridgeScript(state)}</script>` : '';
  const fitScript = `<script>${workflowInitialFitScript()}</script>`;
  return html.replace('</head>', `<style>${categoryCss}</style>\n</head>`).replace('<div class="diagram-container"', `${legend}${runtimeLegend}\n<div class="diagram-container"`).replace('</body>', `${selectorScript}${stateScript}${fitScript}\n</body>`);
}

export function diagramFrameMarkup({src,title='Workflow diagram'}:{src:string;title?:string}):string {
  if (!src.startsWith('/') || src.startsWith('//')) throw new Error('Diagram frame source must be a local path');
  return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" sandbox="allow-scripts allow-downloads" loading="lazy"></iframe>`;
}
