import { describe,it,expect } from 'vitest';
import { resolveWorkbenchRun,compareWorkbenchAssets,getSpaceWorkbench,getAssetSources } from './workbench-model.js';
import type { SpaceOverview,AssetVersion,SpaceRun } from './types.js';
import type { SpaceConsoleService } from './console.js';
const schema={namespace:'quotes/proposal',revision:'1',hash:'a'.repeat(64)};
const run=(runId:string):SpaceRun=>({runId,spaceId:'space',caseId:'case',workflowVersionId:'method-'+runId,entrypoint:'quote',inputManifestId:'input-'+runId,effectiveConfig:{model:runId},configHash:runId});
const asset=(id:string,runId='r1',dependencies:string[]=[])=>({id,spaceId:'space',assetId:id,version:1,schema,payload:{title:'Quote'},payloadHash:'b'.repeat(64),source:{kind:'node' as const,runId,stepRunId:'s',attemptId:'a',nodeId:'writer',producer:'agent' as const,sessionId:'session',contextId:'ctx'},dependencies,attachments:[],initialState:'candidate',state:'candidate',createdAt:id});
function fixture():SpaceOverview {return {space:{id:'space',purpose:'Prepare quotations',owner:'owner',status:'active',createdAt:''},workflows:[],cases:[{id:'case',spaceId:'space',title:'Kitchen quotation',objective:'Give an accurate estimate',constraints:[]}],runs:[run('r1'),run('r2')],assets:[asset('first'),asset('final'),asset('review','r1',['final']),asset('other','r2')],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]};}
const service=(data:SpaceOverview)=>({overview:async()=>data,readContext:async()=>({spaceId:'space',runId:'r1',inputs:{}})} as unknown as SpaceConsoleService);
describe('authorized business read model',()=>{
 it('uses the exact supplied final and review while keeping repeated asset version 1 separate',()=>{
  const data=fixture(),result=resolveWorkbenchRun(data,data.runs[0]!,1,{state:'needs_review',primaryAssetVersionId:'first',process:[{label:'First proposal',assetVersionId:'first',assessmentAssetVersionIds:[]},{label:'Revised proposal',assetVersionId:'final',assessmentAssetVersionIds:['review']}]});
  expect(result.primary?.id).toBe('first');expect(result.process.map(p=>p.asset.version)).toEqual([1,1]);expect(result.reviews).toEqual([]);
 });
 it('rejects unauthorized result, cross-run roles, and reviews of another draft',()=>{
  const data=fixture();
  expect(()=>resolveWorkbenchRun(data,data.runs[0]!,1,{state:'done',primaryAssetVersionId:'secret'})).toThrow('authorized');
  expect(()=>resolveWorkbenchRun(data,data.runs[0]!,1,{state:'done',primaryAssetVersionId:'other'})).toThrow('exact run');
  expect(()=>resolveWorkbenchRun(data,data.runs[0]!,1,{state:'done',primaryAssetVersionId:'first',assessmentAssetVersionIds:['review']})).toThrow('exact assessed');
 });
 it('does not turn run success, internal reviews or newest asset into acceptance or final',async()=>{
  const data=fixture(),model=await getSpaceWorkbench(service(data),'space');
  expect(model.cases[0]?.acceptedAssets).toEqual([]);expect(model.cases[0]?.runs.every(r=>!r.primary)).toBe(true);
 });
 it('distinguishes within-run revisions and cross-run conditions and enforces comparison scope',()=>{
  const data=fixture();
  expect(compareWorkbenchAssets(data,'first','final').mode).toBe('within-run');
  const comparison=compareWorkbenchAssets(data,'final','other');
  expect(comparison.mode).toBe('between-runs');expect(comparison.changedConditions.method).toEqual({baseline:'method-r1',candidate:'method-r2'});
  expect(()=>compareWorkbenchAssets(data,'final','other','within-run')).toThrow('mode');
  data.assets[3]!.schema={...schema,hash:'c'.repeat(64)};expect(()=>compareWorkbenchAssets(data,'final','other')).toThrow('complete schema');
 });
 it('rejects source links outside frozen dependencies even if another authorized asset exists',async()=>{
  const data=fixture();
  await expect(getAssetSources(service(data),data,data.assets[0]!,{resolveRun:async()=>({state:'done'}),resolveSources:async()=>[{ref:'material-1',label:'Wrong current source',assetVersionId:'other',resolved:true}]})).rejects.toThrow('frozen dependencies');
 });
 it('validates a source pointer inside its exact immutable parent, including array positions',async()=>{
  const data=fixture();data.assets[0]!.payload={notes:[{id:'one',text:'Exact historical note'}]};
  const source=(pointer:string)=>({resolveRun:async()=>({state:'done'}),resolveSources:async()=>[{ref:'one',label:'A note',assetVersionId:'first',pointer,resolved:true}]});
  expect((await getAssetSources(service(data),data,data.assets[0]!,source('/notes/0')))[0]?.pointer).toBe('/notes/0');
  await expect(getAssetSources(service(data),data,data.assets[0]!,source('/notes/1'))).rejects.toThrow('immutable parent');
  await expect(getAssetSources(service(data),data,data.assets[0]!,source('/notes/~3'))).rejects.toThrow('pointer is invalid');
 });
 it('does not make every unaccepted run actionable',()=>{
  const data=fixture();
  expect(resolveWorkbenchRun(data,data.runs[0]!,1,{state:'recorded'}).requiresAttention).toBe(false);
  expect(resolveWorkbenchRun(data,data.runs[0]!,1,{state:'needs_review'}).requiresAttention).toBe(true);
  expect(resolveWorkbenchRun(data,data.runs[0]!,1,{state:'running'}).requiresAttention).toBe(false);
 });
});
