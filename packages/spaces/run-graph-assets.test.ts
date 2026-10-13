import {describe,expect,it} from 'vitest';
import {projectRunGraphAssets} from './run-graph-assets.js';
import type {ProcessView} from './process-projection.js';
import type {AssetVersion,InputManifest} from './types.js';

const schema={namespace:'test/research',revision:'1',hash:'a'.repeat(64)};
const run={spaceId:'space',runId:'run',caseId:'case',workflowVersionId:'version',entrypoint:'content',inputManifestId:'manifest'} as ProcessView['run'];
const manifest={id:'manifest',spaceId:'space',caseId:'case',assets:{opportunity:'input-1',materials:'input-2'},hash:'b'.repeat(64)} as InputManifest;
const asset=(id:string,source:AssetVersion['source']):AssetVersion=>({id,spaceId:'space',assetId:id,version:1,schema,payload:{},payloadHash:'c'.repeat(64),source,dependencies:[],attachments:[],initialState:'draft',createdAt:'now'});
const imported=(id:string)=>asset(id,{kind:'import',actorId:'human',description:'saved'});
const published=asset('research-asset',{kind:'node',runId:'run',stepRunId:'research-step',attemptId:'research-attempt',nodeId:'researcher',producer:'agent',sessionId:'research-session',contextId:'research-context'});
const view={run,contract:{revision:'1',hash:'d'.repeat(64),nodes:[{id:'researcher',kind:'agent',storageNodeId:'researcher'},{id:'author',kind:'agent',storageNodeId:'author'}],edges:[],results:[]},
  occurrences:[{id:'research-step',nodeId:'researcher',stepRunIds:['research-step'],contextIds:['research-context'],inputBindings:[{contextId:'research-context',slot:'opportunity',assetVersionId:'input-1'},{contextId:'research-context',slot:'materials',assetVersionId:'input-2'}],outputBindings:[{contextId:'research-context',slot:'research',assetVersionId:'research-asset'}]},
    {id:'author-step',nodeId:'author',stepRunIds:['author-step'],contextIds:['author-context'],inputBindings:[{contextId:'author-context',slot:'research',assetVersionId:'research-asset'}],outputBindings:[]}],routes:[],relations:[],unmappedStepIds:[],coverage:'observed',contractSource:'method'} as unknown as ProcessView;

describe('exact run graph assets',()=>{
  it('connects frozen inputs to the published research asset and its actual author consumption',()=>{
    const graph=projectRunGraphAssets(view,manifest,[imported('input-1'),imported('input-2'),published]);
    expect(graph.assets.map(item=>[item.id,item.kind])).toEqual([['input-1','frozen-input'],['input-2','frozen-input'],['research-asset','published-output']]);
    expect(graph.relations).toEqual([
      {assetId:'research-asset',nodeId:'researcher',kind:'produces',occurrenceIds:['research-step']},
      {assetId:'input-1',nodeId:'researcher',kind:'consumes',occurrenceIds:['research-step']},
      {assetId:'input-2',nodeId:'researcher',kind:'consumes',occurrenceIds:['research-step']},
      {assetId:'research-asset',nodeId:'author',kind:'consumes',occurrenceIds:['author-step']},
    ]);
    expect(graph.assets).toHaveLength(3); // The unpublished author response is not an AssetVersion.
  });
  it('rejects mismatched manifest and does not infer outputs from foreign or unbound versions',()=>{
    expect(()=>projectRunGraphAssets(view,{...manifest,caseId:'other'},[published])).toThrow('does not match');
    const foreign=asset('foreign',{...published.source,runId:'other'} as AssetVersion['source']);
    const wrongView=structuredClone(view);
    wrongView.occurrences[0]!.outputBindings.push({contextId:'research-context',slot:'research',assetVersionId:'foreign'});
    wrongView.occurrences[0]!.outputBindings.push({contextId:'unbound-context',slot:'research',assetVersionId:'unbound'});
    const unbound=asset('unbound',{...published.source,contextId:'unbound-context'} as AssetVersion['source']);
    const graph=projectRunGraphAssets(wrongView,manifest,[imported('input-1'),imported('input-2'),foreign,unbound]);
    expect(graph.assets.map(item=>item.id)).toEqual(['input-1','input-2']);
    expect(graph.relations.some(item=>item.kind==='produces')).toBe(false);
  });
  it('shows an exact retrospective artifact on its mapped original step without claiming an output slot',()=>{
    const historical=asset('historical-asset',{kind:'historical-artifact',runId:'run',stepRunId:'research-step',
      attemptId:'research-attempt',artifactId:'original-artifact',sourceWorkspaceId:'legacy',
      originalSha256:'a'.repeat(64),originalUri:'artifact://original'});
    const graph=projectRunGraphAssets(view,manifest,[historical]);
    expect(graph.assets.find(item=>item.id===historical.id)).toMatchObject({kind:'published-output',producerNodeId:'researcher',slots:[]});
    expect(graph.relations).toContainEqual({assetId:historical.id,nodeId:'researcher',kind:'produces',occurrenceIds:['research-step']});
    const foreign=asset('foreign-history',{...historical.source,runId:'other'});
    expect(projectRunGraphAssets(view,manifest,[foreign]).assets.some(item=>item.id===foreign.id)).toBe(false);
  });
});
