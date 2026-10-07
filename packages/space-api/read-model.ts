import type {AssetVersion, ProcessView, SpaceOverview, WorkflowVersion} from '@signal-room/workflow-spaces';
import type {AssetSummaryDto, CaseSummaryDto, NodeSummaryDto, OccurrenceDto, RunSummaryDto, VersionSummaryDto, AvailabilityDto} from './contracts.js';

export type FullAsset = SpaceOverview['assets'][number];
const visibleKeys=new Set(['stageDeclaration','reasoningEffort','permissionsRevision','timeoutMs','webSearchMode','whenWebResearchTrue','maxRevisions','model','temperature','maxOutputTokens','webResearch','retryCount','executionMode']);
const cleanValue=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(cleanValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>visibleKeys.has(key)).map(([key,item])=>[key,cleanValue(item)]));
  return value;
};
export const cleanConfig=(value:unknown):Record<string,unknown>=>{
  const result=cleanValue(value);
  return result&&typeof result==='object'&&!Array.isArray(result)?result as Record<string,unknown>:{};
};
export const belongs=(data:Pick<SpaceOverview,'runs'>,runId:string)=>data.runs.find(run=>run.runId===runId);
export function nodeDto(entry:WorkflowVersion['entrypoints'][string],node:NonNullable<WorkflowVersion['entrypoints'][string]['process']>['nodes'][number],label=node.id):NodeSummaryDto{
  const definition=entry.nodeDefinitions?.[node.id];
  const slots=(ports:typeof node.inputs|typeof node.outputs,direction:'inputs'|'outputs')=>Object.entries(ports??{}).map(([name,port])=>{
    const storage=entry.storageContract.nodes[node.storageNodeId??''];
    const binding=storage?.[direction]?.[port.slot];
    const input=direction==='inputs'?storage?.inputs[port.slot]:undefined;
    const output=direction==='outputs'?storage?.outputs[port.slot]:undefined;
    const sources=direction==='inputs'?(entry.process?.dataBindings??[]).filter(item=>item.to.node===node.id&&item.to.port===name).map(item=>('runInput'in item.from?{kind:'run-input' as const,source:item.from.runInput,port:null,selection:item.selection,when:item.when??null}:{kind:'node' as const,source:item.from.node,port:item.from.port,selection:item.selection,when:item.when??null})):[];
    return {slot:port.slot,label:name,schema:binding?.schema??{namespace:'unknown',revision:'unknown',hash:''},optional:direction==='inputs'?(input?input.optional===true:null):(port.min===undefined?null:port.min===0),states:input?.states??(output?[output.initialState]:[]),projection:input?.projection?{version:input.projection.version,fields:input.projection.fields}:null,requiredInputs:output?.requiredInputs??[],sources};
  });
  return {id:node.id,label,kind:node.kind,definitionRecorded:!!definition,purpose:definition?.purpose??null,executor:definition?.executor?{family:definition.executor.family,adapter:definition.executor.adapter??null}:null,model:definition?.model??null,tools:definition?.tools??null,inputs:slots(node.inputs,'inputs'),outputs:slots(node.outputs,'outputs')};
}
export function assetDto(data:Pick<SpaceOverview,'runs'>,asset:AssetVersion&{state?:string},title?:string,occurrence?:ProcessView['occurrences'][number]):AssetSummaryDto{
  const run=asset.source.kind==='node'?belongs(data,asset.source.runId):undefined;
  const value=asset.payload as Record<string,unknown>|null;
  const inferred=typeof value?.title==='string'?value.title:undefined;
  return {id:asset.id,title:title??inferred??asset.schema.namespace,kind:asset.schema.namespace,state:asset.state??asset.initialState,createdAt:asset.createdAt,schema:asset.schema,sourceKind:asset.source.kind,runId:run?.runId??null,caseId:run?.caseId??null,versionId:run?.workflowVersionId??null,nodeId:occurrence?.nodeId??(asset.source.kind==='node'?asset.source.nodeId:null),occurrenceId:occurrence?.id??null,round:occurrence?.round??null};
}
export function caseDto(data:SpaceOverview,item:SpaceOverview['cases'][number]):CaseSummaryDto{
  const runs=data.runs.filter(value=>value.caseId===item.id);
  const ids=new Set(runs.map(value=>value.runId));
  return {id:item.id,title:item.title,objective:item.objective,constraints:item.constraints,runCount:runs.length,assetCount:data.assets.filter(value=>value.source.kind==='node'&&ids.has(value.source.runId)).length};
}
export function runDto(data:Pick<SpaceOverview,'assets'>,item:SpaceOverview['runs'][number],task?:{status:string;error?:string;createdAt?:string},resolved?:{state?:string;startedAt?:string;reason?:string;progress?:string;primaryAssetVersionId?:string|null}):RunSummaryDto{
  const assets=data.assets.filter(value=>value.source.kind==='node'&&value.source.runId===item.runId);
  const startedAt=resolved?.startedAt??task?.createdAt??null;
  const date=startedAt?startedAt.slice(0,16).replace('T',' '):'时间未记录';
  return {id:item.runId,label:`${date} · ${item.runId.slice(0,8)}`,versionId:item.workflowVersionId,caseId:item.caseId,entrypoint:item.entrypoint,state:resolved?.state??task?.status??'recorded',taskState:task?.status??null,reason:resolved?.reason??task?.error??null,progress:resolved?.progress??null,startedAt,assetCount:assets.length,draftCount:assets.filter(value=>/draft/i.test(value.schema.namespace)).length,primaryAssetId:resolved?.primaryAssetVersionId??null};
}
export function occurrenceDto(data:Pick<SpaceOverview,'assets'|'runs'>,value:ProcessView['occurrences'][number],label=value.nodeId??value.id,titleFor?:(asset:FullAsset)=>string|undefined):OccurrenceDto{
  const byId=(id:string)=>data.assets.find(item=>item.id===id);
  const steps=value.technicalSteps??[];
  const agentSteps=steps.filter(step=>step.kind==='agent');
  const attempts=value.attemptRecords??[];
  const agentAttemptCount=steps.length===0||agentSteps.some(step=>!attempts.some(attempt=>attempt.stepRunId===step.id))?null:new Set(attempts.filter(attempt=>agentSteps.some(step=>step.id===attempt.stepRunId)).map(attempt=>attempt.id)).size;
  const technicalSteps=steps.map(step=>({id:step.id,key:step.key,kind:step.kind,state:step.state,error:step.error??null}));
  return {id:value.id,nodeId:value.nodeId??null,label:value.round===undefined?label:`第 ${value.round} 轮 · ${label}`,round:value.round??null,branch:value.branch??null,route:value.route??null,provenance:value.provenance??'unknown',state:value.state,inputs:value.inputBindings.map(item=>byId(item.assetVersionId)).filter((item):item is FullAsset=>!!item).map(item=>assetDto(data,item,titleFor?.(item))),outputs:value.outputBindings.map(item=>byId(item.assetVersionId)).filter((item):item is FullAsset=>!!item).map(item=>assetDto(data,item,titleFor?.(item),value)),contextIds:value.contextIds,sessionIds:value.sessionIds,attemptCount:value.attemptIds.length,agentAttemptCount,technicalStepCount:technicalSteps.length,technicalSteps,failureDetails:technicalSteps.filter(step=>step.state==='failed')};
}
function displayTime(value:string,timeZone:string):string{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,calendar:'gregory',numberingSystem:'latn',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(value));
  const part=(kind:string)=>parts.find(item=>item.type===kind)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${timeZone}`;
}
export function versionDto(data:Pick<SpaceOverview,'runs'>,version:WorkflowVersion,entrypoint:string,availability:AvailabilityDto,planIds:string[]=[],stats?:{runCount:number;caseCount:number},presentationLabel?:string|null,displayTimeZone='UTC'):VersionSummaryDto{
  const entry=version.entrypoints[entrypoint];
  const runs=data.runs.filter(run=>run.workflowVersionId===version.id&&run.entrypoint===entrypoint);
  const savedLabel=presentationLabel?.trim();
  const time=displayTime(version.createdAt,displayTimeZone);
  return {id:version.id,label:savedLabel?`${savedLabel} · ${time}`:`${version.revision} · ${time} · ${version.id.slice(-8)}`,labelSource:savedLabel?'saved-presentation':'derived',revision:version.revision,createdAt:version.createdAt,changeReason:version.changeReason,predecessorId:version.predecessorId??null,entrypoint,definitionAvailability:entry?.process?'recorded':'missing',availability,runCount:stats?.runCount??runs.length,caseCount:stats?.caseCount??new Set(runs.map(run=>run.caseId)).size,planIds};
}
