import type { WorkflowEvent, StepRecord, AttemptRecord } from '@signal-room/workflow';
import type { ProcessView, ProcessOccurrence } from './process-projection.js';
import type { RelationProjection } from './relation.js';
import type { NodeContext } from './types.js';
import type { WorkflowPresentation } from './presentation.js';
import type { SpaceWorkbench, WorkbenchCase, WorkbenchRun } from './workbench-model.js';
import { assetReading, assetHref, caseHref, escapeHtml as e, fragmentAnchor, stateLabel, type ReadingOptions } from './workbench-render.js';

export interface ProcessSelection {mode:'execution'|'method';round?:number;occurrenceId?:string;assetVersionId?:string}
export interface ProcessReadingInput {
  model:SpaceWorkbench;item:WorkbenchCase;run:WorkbenchRun;view:ProcessView;selection:ProcessSelection;
  presentation?:WorkflowPresentation;readings:Record<string,ReadingOptions>;
  contexts?:NodeContext[];steps?:StepRecord[];attempts?:AttemptRecord[];events?:WorkflowEvent[];actions?:string;
}
const relationNames:Record<string,string>={'revision-of':'修订自','assesses':'评价','uses-feedback':'依据反馈','cites':'引用','incorporates':'包含','depends-on':'生成依赖','consumed-by':'被节点使用','produced-by':'生产于','accepted-as':'明确接受为'};
const edgeNames:Record<string,string>={sequence:'随后',fork:'并行分支',join:'汇合后',condition:'条件出口',rework:'返工'};
const json=(value:unknown)=>`<pre>${e(JSON.stringify(value,null,2))}</pre>`;
const values=(occurrence:ProcessOccurrence)=>Object.values(occurrence.outputs).flat();

/** Read-only interaction shell consumes the same authorized process query as programs and tools. */
export function processReadingBody(input:ProcessReadingInput):string {
  const {model,item,run,view,presentation,readings}=input,{data}=model;
  const label=(nodeId?:string)=>presentation?.stages?.find(stage=>stage.id===nodeId)?.label??nodeId??'未映射步骤';
  const asset=(id:string)=>data.assets.find(value=>value.id===id);
  const producing=(id:string)=>view.occurrences.find(occurrence=>values(occurrence).includes(id));
  const availableRounds=[...new Set(view.occurrences.flatMap(occurrence=>occurrence.round?[occurrence.round]:[]))].sort((a,b)=>a-b);
  const chosenAssetId=input.selection.assetVersionId??(!input.selection.occurrenceId?run.primary?.id:undefined);
  const selectedProducer=chosenAssetId?producing(chosenAssetId):undefined;
  const selectedOccurrence=input.selection.occurrenceId?view.occurrences.find(value=>value.id===input.selection.occurrenceId):selectedProducer;
  const selectedRound=input.selection.round??selectedOccurrence?.round??availableRounds.at(-1);
  const inRound=view.occurrences.filter(occurrence=>occurrence.round===selectedRound&&occurrence.nodeId);
  const chosenAsset=chosenAssetId?asset(chosenAssetId):undefined;
  const finalSelection=chosenAsset??(selectedOccurrence?values(selectedOccurrence).map(asset).find(Boolean):undefined);
  const href=(next:{mode?:ProcessSelection['mode'];round?:number;occurrenceId?:string;assetVersionId?:string})=>{
    const query=new URLSearchParams({run:run.binding.runId,tab:'process',mode:next.mode??input.selection.mode});
    const round=next.round??selectedRound;if(round)query.set('round',String(round));
    const occurrenceId=next.occurrenceId??input.selection.occurrenceId;if(occurrenceId)query.set('node',occurrenceId);
    const assetId=next.assetVersionId??finalSelection?.id;if(assetId)query.set('asset',assetId);
    return `${caseHref(data.space.id,item.case.id)}?${e(query.toString())}`;
  };
  const assetLink=(versionId:string,meaning?:string)=>{
    const value=asset(versionId);if(!value)return `<span class="muted">准确版本未找到：${e(versionId)}</span>`;
    const source=producing(versionId),reading=assetReading(value,readings[versionId]??{});
    return `<a href="${href({assetVersionId:versionId,occurrenceId:source?.id??'',round:source?.round})}">${e(meaning??reading.label)}${source?.round?` · 第 ${source.round} 轮 ${e(label(source.nodeId))}`:''}</a><p>${e(reading.title)}</p>`;
  };
  const methodHref=`/spaces/${encodeURIComponent(data.space.id)}/workflows/${encodeURIComponent(run.binding.workflowVersionId)}/${encodeURIComponent(run.binding.entrypoint)}?run=${encodeURIComponent(run.binding.runId)}`;
  const top=`<p class="crumbs"><a href="/spaces/${encodeURIComponent(data.space.id)}">${e(data.space.purpose)}</a> / ${e(item.case.title)}</p><h1>${e(item.case.title)}</h1><div class="process-status"><span>第 ${run.number} 次运行</span><span>${e(run.progress??stateLabel(run.state))}</span><span>${item.acceptedAssets.length?'已记录用户接受':'用户尚未接受'}</span></div><details><summary>业务目标与输入条件</summary><p>${e(item.case.objective)}</p>${run.inputSummary.map(value=>`<p>${e(value)}</p>`).join('')}</details>
    <nav class="tabs" aria-label="流程模式"><a href="${methodHref}">完整方法版本</a><a href="${href({mode:'execution'})}"${input.selection.mode==='execution'?' aria-current="page"':''}>本次执行</a><a href="${href({mode:'method'})}"${input.selection.mode==='method'?' aria-current="page"':''}>本次方法说明</a><a href="${caseHref(data.space.id,item.case.id)}?run=${encodeURIComponent(run.binding.runId)}&amp;tab=result">查看结果</a><a href="${caseHref(data.space.id,item.case.id)}?run=${encodeURIComponent(run.binding.runId)}&amp;tab=compare">比较产物</a></nav>
    ${view.contractSource==='retrospective'?'<p class="notice">历史兼容流程：根据准确执行记录和后来登记的解释合同推导。此运行没有当时的 processHash；旧方法与运行指纹未改写。</p>':view.contractSource==='method'?'<p class="muted">使用本次运行冻结的方法流程合同。</p>':'<p class="notice">此运行没有可用流程合同；未映射记录保留，不能推断完整路径。</p>'}`;
  const method=view.contract?`<section class="card"><h2>方法可能怎样走</h2><p class="muted">这是允许的路径；没有观测的分支不代表已执行。</p><ol class="method-list">${view.contract.nodes.map(node=>`<li><strong>${e(label(node.id))}</strong> · ${e(({agent:'Agent',program:'程序',decision:'判断',human:'人工关口',group:'阶段'} as Record<string,string>)[node.kind])}${presentation?.stages?.find(stage=>stage.id===node.id)?.description?`<p>${e(presentation.stages.find(stage=>stage.id===node.id)!.description)}</p>`:''}<ul>${view.contract!.edges.filter(edge=>edge.from===node.id).map(edge=>`<li>${e(edgeNames[edge.kind])} → ${e(label(edge.to))}${edge.route?` · ${e(edge.route)}`:''}${edge.kind==='rework'?` · 最多 ${edge.maxTraversals} 次返工（实际预算还受冻结输入限制）`:''}</li>`).join('')}</ul></li>`).join('')}</ol><h3>结果角色</h3><ul>${view.contract.results.map(result=>`<li>${e(result.role)}：${e(label(result.nodeId))} / ${e(result.outputPort)}${result.many?' · 多份结果':''}</li>`).join('')}</ul></section>`:'<p class="empty">未知的方法流程</p>';
  const rounds=`<nav class="tabs" aria-label="业务轮次">${availableRounds.map(round=>`<a href="${href({round,occurrenceId:'',assetVersionId:view.occurrences.filter(value=>value.round===round).flatMap(values).find(id=>asset(id)?.schema.hash===run.primary?.schema.hash)??''})}"${selectedRound===round?' aria-current="page"':''}>第 ${round} 轮</a>`).join('')||'<span>未记录业务轮次</span>'}</nav>`;
  const groups=[...new Set(inRound.map(occurrence=>occurrence.nodeId!))];
  const parallelGroups=[...new Set(view.contract?.edges.filter(edge=>edge.kind==='fork').map(edge=>`${edge.from}:${edge.route}`)??[])];
  const parallel=parallelGroups.map(group=>{
    const nodes=view.contract!.edges.filter(edge=>edge.kind==='fork'&&`${edge.from}:${edge.route}`===group).map(edge=>edge.to);
    return nodes.every(node=>inRound.some(occurrence=>occurrence.nodeId===node&&occurrence.branch))?`<p class="parallel-summary"><strong>${nodes.map(node=>e(label(node))).join(' ∥ ')}</strong> · 已记录并行分支；随后汇合</p>`:'';
  }).join('');
  const nodes=`<section class="process-nodes"><h2>本轮节点与产物</h2>${parallel}${groups.map(nodeId=>{
    const occurrences=inRound.filter(value=>value.nodeId===nodeId),outputIds=[...new Set(occurrences.flatMap(values))];
    const failed=occurrences.flatMap(value=>value.technicalSteps).filter(value=>value.state==='failed');
    return `<article class="card"><h3><a href="${href({occurrenceId:occurrences.find(value=>values(value).length)?.id??occurrences[0]!.id,assetVersionId:outputIds[0]??''})}">${e(label(nodeId))}</a></h3><p class="process-status">节点状态：${[...new Set(occurrences.map(value=>stateLabel(value.state)))].map(e).join(' / ')}</p>${outputIds.map(id=>assetLink(id)).join('')||'<p class="muted">此节点未产生保存的产物</p>'}${failed.length?`<p class="notice">保留 ${failed.length} 个失败技术步骤；属于本轮，不增加业务轮次。</p>`:''}<small>${occurrences.some(value=>value.provenance==='derived')?'根据准确记录推导':'已记录实例映射'}</small></article>`;
  }).join('')||'<p class="empty">这一轮没有已映射节点</p>'}</section>`;
  const selected=finalSelection?assetReading(finalSelection,{...readings[finalSelection.id],runContext:{runId:run.binding.runId,caseId:item.case.id,backAssetVersionId:finalSelection.id,backRound:selectedRound}}):undefined;
  const selectionFacts=selectedOccurrence??(finalSelection?producing(finalSelection.id):undefined);
  const relations=finalSelection?view.relations.filter(relation=>relation.from.assetVersionId===finalSelection.id||relation.to.assetVersionId===finalSelection.id):[];
  const relationCard=(relation:RelationProjection)=>{
    if(relation.relatedEntity) {
      const entity=relation.relatedEntity;
      const entityHref=entity.kind==='context'?`/spaces/${encodeURIComponent(data.space.id)}/contexts/${encodeURIComponent(entity.id)}`:undefined;
      return `<article class="card"><h3>${e(relationNames[relation.typeId]??relation.typeId)}</h3>${entityHref?`<a href="${entityHref}">准确节点上下文</a>`:`<p>${e(entity.kind)} · ${e(entity.id)}</p>`}${entity.slot?`<p>槽位 ${e(entity.slot)}</p>`:''}<details><summary>已有事实依据</summary>${json(relation)}</details></article>`;
    }
    const outgoing=relation.from.assetVersionId===finalSelection?.id,target=outgoing?relation.to:relation.from;
    const value=asset(target.assetVersionId),other=producing(target.assetVersionId);
    const inverse:Record<string,string>={'revision-of':'后续修订','assesses':'对应意见','uses-feedback':'反馈用于','cites':'被引用','depends-on':'后续依赖'};
    const meaning=outgoing?relationNames[relation.typeId]??relation.typeId:inverse[relation.typeId]??`被 ${relationNames[relation.typeId]??relation.typeId}`;
    const backQuery=`&amp;backAsset=${encodeURIComponent(finalSelection?.id??'')}${selectedRound?`&amp;backRound=${selectedRound}`:''}`;
    const fragmentLink=value&&target.pointer?`${assetHref(data.space.id,value.id)}?run=${encodeURIComponent(run.binding.runId)}&amp;pointer=${encodeURIComponent(target.pointer)}${backQuery}#${fragmentAnchor(target.pointer)}`:undefined;
    return `<article class="card"><h3>${e(meaning)}${other?.round?` · 第 ${other.round} 轮 ${e(label(other.nodeId))}`:''}</h3>${value?fragmentLink?`<a href="${fragmentLink}">打开准确片段</a><p>${e(assetReading(value,readings[value.id]??{}).title)}</p>`:assetLink(value.id):`<p>${e(target.assetVersionId)}</p>`}<small>${relation.provenance==='retrospective'?'历史可验证推导':relation.provenance==='recorded'?'发布时记录':'已有事实投影'}</small><details><summary>关系依据</summary>${json(relation)}</details></article>`;
  };
  const evidenceOccurrences=selectionFacts?view.occurrences.filter(value=>value.nodeId===selectionFacts.nodeId&&value.round===selectionFacts.round):[];
  const selectedSteps=new Set(evidenceOccurrences.flatMap(value=>value.stepRunIds));
  const contexts=(input.contexts??[]).filter(context=>selectedSteps.has(context.stepRunId));
  const failures=(input.events??[]).filter(event=>/fail|recover|retry|resum/i.test(event.type)&&(event.stepRunId?selectedSteps.has(event.stepRunId):true));
  const evidence=`<details><summary>原始执行证据与失败恢复</summary><p>业务轮次与技术尝试分别记录；原始失败保留。</p>${contexts.map(context=>`<p>${e(context.producer==='agent'?'Agent 执行':'资产发布')} · <a href="/spaces/${encodeURIComponent(data.space.id)}/contexts/${encodeURIComponent(context.id)}">准确上下文</a> · <a href="/spaces/${encodeURIComponent(data.space.id)}/sessions/${encodeURIComponent(context.sessionId)}">会话记录</a></p>`).join('')}${json({occurrences:evidenceOccurrences,steps:(input.steps??[]).filter(step=>selectedSteps.has(step.id)),attempts:(input.attempts??[]).filter(attempt=>selectedSteps.has(attempt.stepRunId)),failures})}</details>`;
  const routes=view.routes.filter(route=>route.round===selectedRound);
  const routeSummary=routes.length?`<section class="card"><h3>本轮路由与返工原因</h3>${routes.map(route=>`<p><strong>${route.selectionOnly?'判断选择（不代表已执行）':'记录或推导的路径'}</strong> · ${e(view.contract?.edges.find(edge=>edge.id===route.edgeId)?.route??route.edgeId)}<br>${e(route.reason??'未记录原因')}</p>`).join('')}</section>`:'';
  const reading=`<section class="process-document">${routeSummary}<p class="eyebrow">所选资产${selectionFacts?.round?` · 第 ${selectionFacts.round} 轮 ${e(label(selectionFacts.nodeId))}`:''}</p>${selected?`<h2>${e(selected.title)}</h2>${selected.body}<p><a href="${assetHref(data.space.id,finalSelection!.id)}?run=${encodeURIComponent(run.binding.runId)}&amp;backAsset=${encodeURIComponent(finalSelection!.id)}${selectedRound?`&amp;backRound=${selectedRound}`:''}">完整版本、来源与用途</a></p>`:'<p class="empty">选择节点或资产阅读</p>'}${evidence}</section>`;
  const frozenInputs=selectionFacts?`<h3>本节点消费的输入</h3>${Object.entries(selectionFacts.inputs).map(([slot,id])=>`<p>${e(slot)}</p>${assetLink(id)}`).join('')}`:'生产节点未知';
  const order=['revision-of','uses-feedback','assesses'];
  const coreRelations=relations.filter(relation=>!relation.relatedEntity&&order.includes(relation.typeId)).sort((a,b)=>order.indexOf(a.typeId)-order.indexOf(b.typeId));
  const dependencies=relations.filter(relation=>!relation.relatedEntity&&relation.typeId!=='cites'&&!order.includes(relation.typeId));
  const citations=relations.filter(relation=>relation.typeId==='cites'),primitive=relations.filter(relation=>relation.relatedEntity);
  const neighborhood=`<aside class="process-relations"><h2>关系与意见</h2>${coreRelations.map(relationCard).join('')||'<p class="muted">没有已知的语义关系，不按时间猜测。</p>'}${dependencies.length?`<details><summary>准确资产依赖（${dependencies.length} 条）</summary>${dependencies.map(relationCard).join('')}</details>`:''}${citations.length?`<details><summary>准确引用片段（${citations.length} 条）</summary>${citations.map(relationCard).join('')}</details>`:''}${finalSelection?`<details><summary>准确生产与消费</summary>${frozenInputs}${primitive.map(relationCard).join('')}</details>`:''}<p class="muted">作者自述的回应保留在正文；本页不自动宣布问题已解决。</p></aside>`;
  return `${top}${input.selection.mode==='method'?method:''}${rounds}<div class="process-layout">${nodes}${reading}${neighborhood}</div><details><summary>未映射步骤与合同身份</summary><p>${view.unmappedStepIds.length} 个技术步骤未映射。没有观测不等于没有执行。</p>${json({contractSource:view.contractSource,processRevision:view.contract?.revision,processHash:view.contract?.hash,resolverVersion:view.resolverVersion,unmappedStepIds:view.unmappedStepIds,coverage:view.coverage})}</details>${input.actions??''}`;
}
