import type { SpaceOverview, WorkflowEntrypoint, WorkflowEntrypointDraft, WorkflowVersion, WorkflowVersionDraft } from './types.js';
import type { WorkflowPresentationDraft } from './presentation.js';
import type { ProcessView } from './process-projection.js';
import type { NodeContext } from './types.js';
import { workflowDiagramFrame } from './diagram-host.js';

const e=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const id=(value:string)=>encodeURIComponent(value);
export const methodPath=(spaceId:string,versionId:string,entrypoint:string)=>`/spaces/${id(spaceId)}/workflows/${id(versionId)}/${id(entrypoint)}`;
const listPath=(spaceId:string)=>`/spaces/${id(spaceId)}/workflows`;
const kindLabel:Record<string,string>={agent:'Agent',program:'程序',decision:'判断',human:'人工关口',group:'分组'};
const edgeLabel:Record<string,string>={sequence:'随后',fork:'并行',join:'汇合',condition:'条件',rework:'返工'};
const routeNames:Record<string,string>={pass:'通过',passed:'通过',blocked:'阻塞',budget:'轮次用尽','route-budget':'轮次用尽',revise:'改稿','route-revise':'改稿',rewrite:'改稿',research:'补充研究','route-research':'补充研究',reframe:'重新定位','route-reframe':'重新定位','not-converged':'未收敛'};
const selectionLabel:Record<string,string>={'latest-successful-in-this-run':'本次运行最近成功产物','previous-business-round':'上一业务轮','frozen-input':'冻结输入','current-business-round':'本业务轮'};
const whenLabel:Record<string,string>={'initial-round':'首轮','later-rounds':'后续轮次'};
const shortId=(value:string)=>value.length>18?`${value.slice(0,7)}…${value.slice(-10)}`:value;
function displayLabel(nodeId:string,presentation?:WorkflowPresentationDraft):string {return presentation?.stages?.find(stage=>stage.id===nodeId)?.label??nodeId;}
function routeLabel(value:string):string {return routeNames[value]??edgeLabel[value]??value;}

export interface MethodRuntimeReading { view?: ProcessView; contexts?: NodeContext[] }

function graph(entry:WorkflowEntrypoint|WorkflowEntrypointDraft, base:string,presentation?:WorkflowPresentationDraft, options?:{versionId?:string;runId?:string;selectedNodeId?:string}):string {
  const process=entry.process;
  if(!process) return '<p class="card">此历史版本未保存流程声明。方法记录可阅读，完整路径未知。</p>';
  if(!process.nodes.length)return '<p>流程声明没有节点。</p>';
  const query=new URLSearchParams();
  if(options?.versionId)query.set('version',options.versionId);
  if(options?.runId)query.set('run',options.runId);
  if(options?.selectedNodeId)query.set('node',options.selectedNodeId);
  const href=(nodeId:string)=>{const q=new URLSearchParams();if(options?.runId)q.set('run',options.runId);q.set('node',nodeId);return `${base}?${q}#node-detail`;};
  return `<div class="method-canvas"><p class="muted">搜索、聚焦节点或查看上下游；点击节点在右侧阅读详情。箭头表示方法允许的路径，运行状态单独标注。</p>${workflowDiagramFrame(entry,`${base}/diagram?${query}`)}<details><summary>文字路径与节点选择（无脚本也可使用）</summary><ol>${process.nodes.map(node=>`<li><a href="${e(href(node.id))}">${e(displayLabel(node.id,presentation))}</a> <small>(${e(node.id)})</small> · ${e(kindLabel[node.kind]??node.kind)}；后续：${process.edges.filter(edge=>edge.from===node.id).map(edge=>`${e(displayLabel(edge.to,presentation))}（${e(edge.kind==='fork'||edge.kind==='join'?edgeLabel[edge.kind]:routeLabel(edge.route??edge.kind))}）`).join('、')||'结束'}</li>`).join('')}</ol></details></div>`;
}

function schemaSummary(entry:WorkflowEntrypoint|WorkflowEntrypointDraft,nodeId:string,portName:string,direction:'inputs'|'outputs',presentation?:WorkflowPresentationDraft):string {
 const node=entry.process?.nodes.find(value=>value.id===nodeId);const port=node?.[direction]?.[portName];const binding=node?.storageNodeId?entry.storageContract.nodes[node.storageNodeId]:undefined;const slot=port?.slot;const schema=slot?binding?.[direction]?.[slot]?.schema:undefined;
 const view=schema?presentation?.assetViews.find(item=>item.schema.namespace===schema.namespace&&item.schema.revision===schema.revision&&item.schema.hash===schema.hash):undefined;
 const optional=direction==='inputs'&&slot?binding?.inputs[slot]?.optional:undefined;
 const quantity=port?.min!==undefined||port?.max!==undefined?` · 数量 ${e(port.min??0)}–${e(port.max??'不限')}`:'';
 return `${e(portName)}${slot&&slot!==portName?` <small>(${e(slot)})</small>`:''} · ${direction==='inputs'?(optional?'可选':'必需'):'产出'}${quantity}${schema?` · ${e(view?.label??schema.namespace)} <small>${e(schema.namespace)}@${e(schema.revision)}</small><details><summary>准确 schema</summary><code>${e(schema.hash)}</code></details>`:' · schema 未记录'}`;
}
function detail(entry:WorkflowEntrypoint|WorkflowEntrypointDraft,nodeId:string|undefined,presentation?:WorkflowPresentationDraft,runtime?:MethodRuntimeReading):string {
 const process=entry.process;if(!process)return'';
 const node=process.nodes.find(value=>value.id===nodeId)??process.nodes[0];if(!node)return'';
 const definition=entry.nodeDefinitions?.[node.id],stage=presentation?.stages?.find(item=>item.id===node.id);const ports=(direction:'inputs'|'outputs')=>Object.keys(node[direction]??{}).map(name=>`<li>${schemaSummary(entry,node.id,name,direction,presentation)}</li>`).join('')||'<li>未声明</li>';
 const bindings=(process.dataBindings??[]).filter(binding=>('node'in binding.from&&binding.from.node===node.id)||binding.to.node===node.id).map(binding=>{const runSchema='runInput'in binding.from?process.runInputs?.[binding.from.runInput]:undefined;return `<li>${'runInput'in binding.from?`运行输入 ${e(binding.from.runInput)}${runSchema?` <small>${e(runSchema.namespace)}@${e(runSchema.revision)}</small>`:''}`:`${e(displayLabel(binding.from.node,presentation))}.${e(binding.from.port)}`} → ${e(displayLabel(binding.to.node,presentation))}.${e(binding.to.port)} · ${e(selectionLabel[binding.selection]??binding.selection)}${binding.when?` · ${e(whenLabel[binding.when]??binding.when)}`:''}</li>`;}).join('');
 const declared=definition?.executor;
 const legacy=definition?.configuration?.executor as {adapter?:unknown}|undefined;
 const family=declared?.family??(legacy?.adapter==='SIWC Responses'?'agent-sdk':node.kind==='agent'?undefined:node.kind);
 const executorNames:Record<string,string>={'agent-sdk':'SDK Agent',codex:'Codex',program:'程序',decision:'条件判断',human:'人工参与',group:'分组'};
 const adapter=declared?.adapter??(legacy?.adapter==='SIWC Responses'?'SIWC Responses':undefined);
 const occurrences=runtime?.view?.occurrences.filter(value=>value.nodeId===node.id)??[];
 const contexts=(runtime?.contexts??[]).filter(context=>occurrences.some(value=>value.contextIds.includes(context.id)));
 const runtimeBody=runtime?.view?`<h3>所选运行中的记录</h3><p><code>${e(runtime.view.run.runId)}</code></p>${occurrences.length?occurrences.map(value=>`<article class="node-occurrence"><p>${value.round?`第 ${value.round} 轮 · `:''}${e(value.state)} · ${e(value.provenance==='observed'?'已记录':value.provenance==='derived'?'历史推导':'映射未知')}</p>${value.contextIds.map(contextId=>`<a href="/spaces/${id(runtime.view!.run.spaceId)}/contexts/${id(contextId)}">准确上下文</a>`).join(' · ')}${value.sessionIds.map(sessionId=>` · <a href="/spaces/${id(runtime.view!.run.spaceId)}/sessions/${id(sessionId)}">会话记录</a>`).join('')}<details><summary>实例、输入输出与技术尝试</summary><pre>${e(JSON.stringify(value,null,2))}</pre></details></article>`).join(''):'<p class="muted">没有此节点的已映射执行记录；不能据此判断从未执行。</p>'}${contexts.length?`<details><summary>实际记录的指令与配置（${contexts.length} 份）</summary>${contexts.map(context=>`<h4>${e(context.id)}</h4><pre>${e(context.instructions)}</pre><pre>${e(JSON.stringify(context.effectiveConfig,null,2))}</pre>`).join('')}</details>`:''}`:'';
 return `<section id="node-detail" class="card">
 <h2>${e(displayLabel(node.id,presentation))} · ${e(kindLabel[node.kind]??node.kind)}</h2>
 <p class="muted">节点 ID：<code>${e(node.id)}</code></p>
 <p class="executor-label">执行类型：${e(family?executorNames[family]??family:'未声明')}${adapter?` · ${e(adapter)}`:''}</p>
 <p>${e(definition?.purpose??stage?.description??'此版本未冻结节点用途说明。')}</p>
 <p><strong>模型：</strong>${e(definition?.model??'未记录')}</p>
 <p><strong>工具：</strong>${e(definition?.tools===undefined?'未记录':definition.tools.length?definition.tools.join('、'):'无声明工具')}</p>
 <details open><summary>完整 Prompt</summary><pre>${e(definition?.instructions??'此版本未保存节点指令。')}</pre></details>
 <details><summary>冻结的执行配置</summary><pre>${e(JSON.stringify(definition?.configuration??{},null,2))}</pre></details>
 <details><summary>输入、输出与资产绑定</summary><div class="two"><div><h3>输入资产</h3><ul>${ports('inputs')}</ul></div><div><h3>输出资产</h3><ul>${ports('outputs')}</ul></div></div>${bindings?`<h3>声明的数据流</h3><ul>${bindings}</ul>`:''}</details>
 ${runtimeBody}</section>`;
}

function changesBody(current:WorkflowEntrypoint,previous:WorkflowEntrypoint|undefined):string {
 if(!previous)return '<p class="muted">没有可读取的前驱入口定义；无法计算结构差异。</p>';
 const rows:Array<[string,string[]]>=[];
 const difference=(label:string,before:Record<string,unknown>,after:Record<string,unknown>)=>{
  const ids=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();
  const changes=ids.flatMap(id=>!Object.hasOwn(before,id)?[`新增 ${id}`]:!Object.hasOwn(after,id)?[`移除 ${id}`]:JSON.stringify(before[id])!==JSON.stringify(after[id])?[`修改 ${id}`]:[]);
  if(changes.length)rows.push([label,changes]);
 };
 const indexed=(items:Array<{id:string}>|undefined)=>Object.fromEntries((items??[]).map(item=>[item.id,item]));
 difference('流程节点',indexed(previous.process?.nodes),indexed(current.process?.nodes));
 difference('控制边',indexed(previous.process?.edges),indexed(current.process?.edges));
 difference('节点定义',previous.nodeDefinitions??{},current.nodeDefinitions??{});
 if(previous.storageContract.hash!==current.storageContract.hash)rows.push(['存储合同',['准确合同 hash 已改变']]);
 if(!previous.process||!current.process)rows.push(['完整性',['至少一个版本未保存流程声明，不能比较完整路径']]);
 return rows.length?`<ul>${rows.map(([label,values])=>`<li><strong>${e(label)}</strong>：${values.map(e).join('、')}</li>`).join('')}</ul>`:'<p>已保存的流程节点、控制边、节点定义和存储合同未发现差异。</p>';
}

export function methodListBody(data:SpaceOverview,methods?:{workflowId:string;entrypoint:string}):string {
 const pairs=data.workflows.flatMap(version=>Object.entries(version.entrypoints).map(([entrypoint,entry])=>({version,entrypoint,workflowId:entry.workflowId})));
 const grouped=[...new Set(pairs.map(pair=>pair.workflowId))];
 return `<p class="eyebrow">方法工作台</p><h1>工作流</h1><p class="lead">选择工作流和准确版本，阅读完整方法及其运行记录。</p>${methods?`<p><a class="badge" href="/workbench/workflows/preview">查看待发布方法预览</a></p>`:''}${grouped.map(workflowId=>`<section class="card"><h2>${e(workflowId)}</h2>${pairs.filter(pair=>pair.workflowId===workflowId).map(pair=>`<p><a href="${methodPath(data.space.id,pair.version.id,pair.entrypoint)}">${e(pair.version.revision)} · ${e(shortId(pair.version.id))} · ${e(pair.entrypoint)}</a> <small>${e(pair.version.id)}</small></p>`).join('')}</section>`).join('')||'<p class="card">尚无已发布版本。可从待发布方法预览认识当前候选流程。</p>'}`;
}

export function methodVersionBody(data:SpaceOverview,version:WorkflowVersion,entrypoint:string,selection:string|undefined,availability:{available:boolean;reason?:string}|undefined,presentation?:WorkflowPresentationDraft,runtime?:MethodRuntimeReading):string {
 const entry=version.entrypoints[entrypoint],base=methodPath(data.space.id,version.id,entrypoint);if(!entry)return'';
 const displayEntry=entry.process?entry:runtime?.view?.contract?{...entry,process:runtime.view.contract}:entry;
 const executionNote=runtime?.view?`<p class="notice">${runtime.view.contractSource==='retrospective'?'历史兼容图：根据准确执行记录和后来登记的解释合同推导，未改写原方法或运行指纹。':'节点状态来自所选运行的已映射记录。'} 覆盖度：${e(runtime.view.coverage)}；${runtime.view.unmappedStepIds.length} 个技术步骤未映射，节点成功不代表所有技术尝试都成功。<a href="/spaces/${id(data.space.id)}/cases/${id(runtime.view.run.caseId)}?run=${id(runtime.view.run.runId)}&amp;tab=process">查看逐轮执行与未映射证据</a></p>`:'';
 const same=data.workflows.filter(value=>value.entrypoints[entrypoint]?.workflowId===entry.workflowId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
 const adoptionHeads=new Map<string,string>();for(const adoption of [...data.adoptions].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)))if(adoption.target.kind==='workflow')adoptionHeads.set(adoption.slot,adoption.target.id);
 const adopted=[...adoptionHeads].filter(([,target])=>same.some(item=>item.id===target)).map(([slot,target])=>`${slot}：${same.find(item=>item.id===target)!.revision} (${shortId(target)})`).join('、')||'未指定';
 const runs=data.runs.filter(run=>run.workflowVersionId===version.id&&run.entrypoint===entrypoint),reviews=data.reviews.filter(review=>runs.some(run=>run.runId===review.runId));
 const predecessor=version.predecessorId?data.workflows.find(value=>value.id===version.predecessorId)?.entrypoints[entrypoint]:undefined;
 const runSelector=runs.length?`<form method="get" action="${e(base)}" class="method-run-selector"><label>运行状态<select name="run"><option value="">只看方法定义</option>${runs.map(run=>`<option value="${e(run.runId)}"${runtime?.view?.run.runId===run.runId?' selected':''}>${e(data.cases.find(item=>item.id===run.caseId)?.title??run.caseId)} · ${e(shortId(run.runId))}</option>`).join('')}</select></label>${selection?`<input type="hidden" name="node" value="${e(selection)}">`:''}<button type="submit">查看</button></form>`:'';
 const tabs=`<nav class="tabs"><a href="#method-graph">流程与节点</a><a href="#method-runs">选题与运行</a><a href="#method-evaluations">验证与评价</a><a href="#method-changes">版本变化</a></nav>`;
 return `<p class="crumbs"><a href="${listPath(data.space.id)}">工作流</a> / ${e(entry.workflowId)} / ${e(version.revision)} (${e(shortId(version.id))})</p><h1>${e(presentation?.label??entry.workflowId)} · ${e(version.revision)}</h1><p class="lead">${e(presentation?.purpose??data.space.purpose)}</p><p class="method-status">正在查看：${e(version.revision)} (${e(shortId(version.id))}) · 当前采用：${e(adopted)} · 最新发布：${e(same[0]?.revision??version.revision)} (${e(shortId(same[0]?.id??version.id))}) · 可执行：${availability?availability.available?'已确认':'不可用':'未核验'}${availability?.reason?`（${e(availability.reason)}）`:''}</p><p><small>准确身份：Space ${e(data.space.id)} · ${e(version.id)} · ${e(entrypoint)}</small></p>${availability?.available?`<p><a class="badge" href="/workbench/workflows/${id(version.id)}/${id(entrypoint)}/run">用此版本运行</a></p>`:''}${tabs}<section id="method-graph"><h2>完整方法图</h2>${runSelector}${executionNote}<div class="method-workspace">${graph(displayEntry,base,presentation,{runId:runtime?.view?.run.runId,selectedNodeId:selection})}${detail(displayEntry,selection,presentation,runtime)}</div></section><section id="method-runs"><h2>选题与运行 · ${runs.length}</h2>${runs.map(run=>`<p class="card"><a href="/spaces/${id(data.space.id)}/cases/${id(run.caseId)}?run=${id(run.runId)}">${e(data.cases.find(item=>item.id===run.caseId)?.title??run.caseId)} · ${e(run.runId)}</a></p>`).join('')||'<p>此准确版本与入口尚无运行。</p>'}</section><section id="method-evaluations"><h2>已有评价 · ${reviews.length}</h2><p>仅列出绑定此版本和入口的已有运行评价；尚无验证计划记录。</p>${reviews.map(review=>`<details class="card"><summary>${e(review.id)} · ${e(review.judge.kind)} · ${e(review.runId)}</summary><p>${e(review.answers.good)}</p><p>${e(review.answers.bad)}</p><p>${e(review.answers.improvement)}</p><p>${e(review.answers.unresolved)}</p></details>`).join('')||'<p>暂无评价。</p>'}</section><section id="method-changes"><h2>版本变化</h2><p>${e(version.changeReason)}</p><p>前驱版本：${version.predecessorId&&data.workflows.some(value=>value.id===version.predecessorId&&value.entrypoints[entrypoint])?`<a href="${methodPath(data.space.id,version.predecessorId,entrypoint)}">${e(version.predecessorId)}</a>`:e(version.predecessorId??'未记录')}</p>${changesBody(entry,predecessor)}<p>其他版本：${same.map(value=>`<a href="${methodPath(data.space.id,value.id,entrypoint)}">${e(value.revision)} (${e(shortId(value.id))})</a>`).join(' · ')}</p></section>`;
}

export function methodPreviewBody(data:SpaceOverview,candidate:{version:WorkflowVersionDraft;entrypoint:string;presentation?:WorkflowPresentationDraft},tokenFields:string,selection?:string|null):string {
 const version=candidate.version,entry=version.entrypoints[candidate.entrypoint];if(!entry)return'<h1>候选入口不存在</h1>';
 const compatible=data.workflows.filter(item=>item.id!==version.id&&item.entrypoints[candidate.entrypoint]?.workflowId===entry.workflowId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
 const predecessorField=compatible.length?`<label>前驱版本<select name="predecessorId" required><option value="">请选择父版本</option>${compatible.map(item=>`<option value="${e(item.id)}"${item.id===version.predecessorId?' selected':''}>${e(item.revision)} · ${e(shortId(item.id))}</option>`).join('')}</select></label>`:'<p>首个版本，无父版本。</p>';
 return `<p><a href="${listPath(data.space.id)}">工作流与已发布版本</a></p><p class="eyebrow">待发布草稿 · 仅读取候选定义</p><h1>${e(candidate.presentation?.label??entry.workflowId)} · ${e(version.revision)}</h1><p class="lead">${e(candidate.presentation?.purpose??data.space.purpose)}</p><p>准确候选 ID：<code>${e(version.id)}</code> · 入口：<code>${e(candidate.entrypoint)}</code></p><h2>完整方法图</h2><div class="method-workspace">${graph(entry,'/workbench/workflows/preview',candidate.presentation,{versionId:version.id,selectedNodeId:selection??undefined})}${detail(entry,selection??undefined,candidate.presentation)}</div><section class="card"><h2>发布此候选</h2><p>发布只保存不可变方法版本，不启动运行，也不改变当前采用版本。</p><form method="post" action="/workbench/workflows/publish">${tokenFields}<input type="hidden" name="expectedVersionId" value="${e(version.id)}">${predecessorField}<label>修改原因<textarea name="changeReason" required maxlength="40000">${e(version.changeReason)}</textarea></label><button type="submit">明确发布方法版本</button></form></section>`;
}
