import type { SpaceConsoleService } from './console.js';
import type { AssetVersion, Review, SpaceCase, SpaceOverview, SpaceRun } from './types.js';

export type ReadableAsset = AssetVersion & {state:string};
export interface BusinessRunResolution {
  state:string; startedAt?:string; progress?:string; reason?:string; primaryAssetVersionId?:string|null;
  supportingAssetVersionIds?:string[]; assessmentAssetVersionIds?:string[];
  process?:Array<{label:string;assetVersionId:string;assessmentAssetVersionIds:string[]}>;
  inputSummary?:string[]; methodLabel?:string; sessions?:Array<{sessionId:string;label:string}>;
  requiresAttention?:boolean;
}
export interface ResolvedAssetSource { ref:string; label:string; excerpt?:string; assetVersionId?:string; pointer?:string; resolved:boolean }
/** Trusted, deployed business code. Declarations do not supply executable resolvers. */
export interface BusinessPresentationAdapter {
  resolveRun(input:{data:SpaceOverview;run:SpaceRun}):Promise<BusinessRunResolution>;
  resolveSources?(input:{data:SpaceOverview;asset:AssetVersion}):Promise<ResolvedAssetSource[]>;
}
export interface WorkbenchRun {
  binding:SpaceRun; number:number; state:string; startedAt?:string; progress?:string; reason?:string;
  primary?:ReadableAsset; supporting:ReadableAsset[]; assessments:ReadableAsset[];
  process:Array<{label:string;asset:ReadableAsset;assessments:ReadableAsset[]}>;
  reviews:Review[]; inputSummary:string[]; methodLabel:string; sessions:Array<{sessionId:string;label:string}>;
  requiresAttention:boolean;
}
export interface WorkbenchCase { case:SpaceCase; runs:WorkbenchRun[]; acceptedAssets:ReadableAsset[] }
export interface SpaceWorkbench {data:SpaceOverview;cases:WorkbenchCase[]}

function exactAsset(data:SpaceOverview,id:string,run?:SpaceRun):ReadableAsset {
  const asset=data.assets.find(value=>value.id===id && value.spaceId===data.space.id);
  if(!asset) throw new Error('Presentation relation is outside the authorized Space');
  if(run && (asset.source.kind!=='node'||asset.source.runId!==run.runId)) throw new Error('Presentation result is outside the exact run');
  return asset;
}
function assessment(data:SpaceOverview,id:string,target:ReadableAsset,run:SpaceRun):ReadableAsset {
  const value=exactAsset(data,id,run);
  if(!value.dependencies.includes(target.id)) throw new Error('Assessment does not depend on the exact assessed version');
  return value;
}
export function resolveWorkbenchRun(data:SpaceOverview,run:SpaceRun,number:number,resolved:BusinessRunResolution):WorkbenchRun {
  if(run.spaceId!==data.space.id || !data.runs.some(value=>value.runId===run.runId && value.caseId===run.caseId)) throw new Error('Run is outside the authorized Space');
  const primary=resolved.primaryAssetVersionId?exactAsset(data,resolved.primaryAssetVersionId,run):undefined;
  const runDependencies=new Set(data.assets.filter(asset=>asset.source.kind==='node'&&asset.source.runId===run.runId).flatMap(asset=>asset.dependencies));
  const supporting=(resolved.supportingAssetVersionIds??[]).map(id=>{
    const asset=exactAsset(data,id);
    if(!(asset.source.kind==='node'&&asset.source.runId===run.runId)&&!runDependencies.has(id))throw new Error('Supporting relation is outside this run and its frozen dependencies');
    return asset;
  });
  const assessments=(resolved.assessmentAssetVersionIds??[]).map(id=>{
    if(!primary) throw new Error('Assessment requires an exact primary result');
    return assessment(data,id,primary,run);
  });
  const process=(resolved.process??[]).map(item=>{
    const asset=exactAsset(data,item.assetVersionId,run);
    return {label:item.label,asset,assessments:item.assessmentAssetVersionIds.map(id=>assessment(data,id,asset,run))};
  });
  const reviews=primary?data.reviews.filter(review=>review.spaceId===data.space.id&&review.runId===run.runId&&review.assetVersionIds.includes(primary.id)):[];
  return {binding:run,number,state:resolved.state,startedAt:resolved.startedAt,progress:resolved.progress,reason:resolved.reason,primary,supporting,assessments,process,reviews,inputSummary:resolved.inputSummary??[],methodLabel:resolved.methodLabel??run.workflowVersionId,sessions:(resolved.sessions??[]).filter(session=>data.sessions.some(value=>value.id===session.sessionId)),requiresAttention:resolved.requiresAttention??['needs_review','failed','blocked'].includes(resolved.state)};
}
/** Reads are always made through the host's authenticated service; there is no browser-side graph search. */
export async function getSpaceWorkbench(service:SpaceConsoleService,spaceId:string,adapter?:BusinessPresentationAdapter):Promise<SpaceWorkbench> {
  const data=await service.overview(spaceId);
  const cases=await Promise.all(data.cases.map(async item=>{
    const bindings=data.runs.filter(run=>run.caseId===item.id);
    const runs=await Promise.all(bindings.map(async(run,index)=>resolveWorkbenchRun(data,run,index+1,
      adapter?await adapter.resolveRun({data,run}):{state:'recorded',progress:'此流程尚未配置结果角色；可阅读过程资产与执行证据。',
        process:data.assets.filter(asset=>asset.source.kind==='node'&&asset.source.runId===run.runId).map(asset=>({label:'过程产物',assetVersionId:asset.id,assessmentAssetVersionIds:[]}))})));
    runs.sort((left,right)=>left.startedAt&&right.startedAt?left.startedAt.localeCompare(right.startedAt):left.number-right.number);
    runs.forEach((run,index)=>{run.number=index+1;});
    // Adoption heads are append-only decisions. They are never inferred from an internal verdict.
    const heads=new Map<string,SpaceOverview['adoptions'][number]>();
    for(const adoption of [...data.adoptions].sort((a,b)=>a.createdAt.localeCompare(b.createdAt))) heads.set(adoption.slot,adoption);
    const acceptedAssets=[...heads.values()].filter(value=>value.target.kind==='asset').flatMap(value=>{
      const asset=exactAsset(data,value.target.id);
      const source=asset.source;
      return source.kind==='node'&&bindings.some(run=>run.runId===source.runId)?[asset]:[];
    });
    return {case:item,runs,acceptedAssets};
  }));
  return {data,cases};
}
/** Source IDs are checked against exact dependencies and the producing context's frozen inputs. */
export async function getAssetSources(service:Pick<SpaceConsoleService,'readContext'>,data:SpaceOverview,asset:AssetVersion,adapter?:BusinessPresentationAdapter):Promise<ResolvedAssetSource[]> {
  const sources=await adapter?.resolveSources?.({data,asset})??[];
  if(!sources.length)return [];
  const allowed=new Set([asset.id,...asset.dependencies]);
  if(asset.source.kind==='node') {
    const ids=[asset.source.contextId,asset.source.generatedByContextId].filter((value):value is string=>Boolean(value));
    for(const contextId of ids) {
      const context=await service.readContext(data.space.id,contextId);
      if(context.spaceId!==data.space.id||context.runId!==asset.source.runId) throw new Error('Source context is outside the exact run');
      for(const input of Object.values(context.inputs)) allowed.add(input.assetVersionId);
    }
  }
  for(const source of sources) {
    if(source.resolved&&!source.assetVersionId) throw new Error('Resolved source requires an exact parent asset');
    if(source.assetVersionId) {
      if(!allowed.has(source.assetVersionId)) throw new Error('Source relation is outside frozen dependencies');
      exactAsset(data,source.assetVersionId);
      if(source.pointer!==undefined) {
        if(!source.pointer.startsWith('/')||/~(?![01])/u.test(source.pointer)) throw new Error('Source fragment pointer is invalid');
        let fragment:unknown=exactAsset(data,source.assetVersionId).payload;
        for(const part of source.pointer.slice(1).split('/').map(value=>value.replace(/~1/g,'/').replace(/~0/g,'~'))) {
          if(!fragment||typeof fragment!=='object'||!Object.hasOwn(fragment,part))throw new Error('Source fragment does not exist in its immutable parent');
          fragment=(fragment as Record<string,unknown>)[part];
        }
      }
    }
  }
  return sources;
}
export interface AssetComparison {
  mode:'within-run'|'between-runs'; left:ReadableAsset;right:ReadableAsset;
  leftRun:SpaceRun;rightRun:SpaceRun;
  changedConditions:Record<string,{baseline:unknown;candidate:unknown}>;
  reviews:{baseline:Review[];candidate:Review[]};
}
export function compareWorkbenchAssets(data:SpaceOverview,leftId:string,rightId:string,mode?:AssetComparison['mode']):AssetComparison {
  const left=exactAsset(data,leftId),right=exactAsset(data,rightId);
  const runFor=(asset:ReadableAsset)=>asset.source.kind==='node'?data.runs.find(run=>run.runId===(asset.source as {runId:string}).runId):undefined;
  const leftRun=runFor(left),rightRun=runFor(right);
  if(!leftRun||!rightRun||leftRun.caseId!==rightRun.caseId) throw new Error('Comparison requires two exact results from the same case');
  const actualMode=leftRun.runId===rightRun.runId?'within-run':'between-runs';
  if(mode&&mode!==actualMode) throw new Error('Comparison mode does not match the selected runs');
  if(left.schema.namespace!==right.schema.namespace||left.schema.revision!==right.schema.revision||left.schema.hash!==right.schema.hash) throw new Error('Comparison requires matching complete schema references');
  const changedConditions:AssetComparison['changedConditions']={};
  if(actualMode==='between-runs') {
    const conditions:Record<string,[unknown,unknown]>={inputManifest:[leftRun.inputManifestId,rightRun.inputManifestId],method:[leftRun.workflowVersionId,rightRun.workflowVersionId],configuration:[leftRun.effectiveConfig,rightRun.effectiveConfig],configurationHash:[leftRun.configHash,rightRun.configHash]};
    for(const [key,[baseline,candidate]] of Object.entries(conditions)) if(JSON.stringify(baseline)!==JSON.stringify(candidate)) changedConditions[key]={baseline,candidate};
  }
  return {mode:actualMode,left,right,leftRun,rightRun,changedConditions,reviews:{baseline:data.reviews.filter(r=>r.runId===leftRun.runId&&r.assetVersionIds.includes(left.id)),candidate:data.reviews.filter(r=>r.runId===rightRun.runId&&r.assetVersionIds.includes(right.id))}};
}
