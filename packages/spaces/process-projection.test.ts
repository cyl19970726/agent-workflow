import {describe,expect,it} from 'vitest';
import type {StepRecord} from '@signal-room/workflow';
import type {ProcessContract} from './process-contract.js';
import {projectProcess,type HistoricalProcessResolution} from './process-projection.js';
import type {NodeContext,ProcessDecisionObservation,SpaceRun} from './types.js';

const run={runId:'run'} as SpaceRun;
const contract={nodes:[{id:'author',kind:'agent',storageNodeId:'writer',outputs:{draft:{slot:'draft'}}},{id:'route',kind:'decision'},{id:'stop',kind:'human'}],
  edges:[{id:'rewrite',from:'route',to:'author',kind:'rework',route:'rewrite',maxTraversals:2},
    {id:'route-budget',from:'route',to:'stop',kind:'condition',route:'not-converged'}],
  results:[{role:'final-draft',nodeId:'author',outputPort:'draft'}],revision:'1',hash:'contract'} as ProcessContract;
const step=(id:string,state:StepRecord['state'],kind:StepRecord['kind']='agent'):StepRecord=>({
  id,runId:'run',key:id,kind,workflowId:'flow',workflowRevision:'1',inputFingerprint:'',configFingerprint:'',state,validation:'valid',
  ...(state==='failed'?{error:`${id} failed`}:{})});
const context=(id:string):NodeContext=>({id:`context-${id}`,stepRunId:id,nodeId:'writer',sessionId:`session-${id}`,
  process:{nodeId:'author',round:3},inputs:{},
  ...(id.startsWith('publish-')?{generatedByContextId:`context-write-${id.slice('publish-'.length)}`}:{})} as NodeContext);
const project=(steps:StepRecord[],outputIds:string[]=[],processContract=contract)=>projectProcess({run,contract:processContract,contractSource:'method',steps,attempts:[],
  contexts:steps.map(item=>context(item.id)),outputs:outputIds.map(id=>({contextId:`context-${id}`,slot:'draft',versionId:'draft-3'})),
  assets:[],relations:[]});

describe('process projection',()=>{
  it('keeps recovered output successful and failed attempts visible regardless of step order',()=>{
    const steps=[step('write-failed','failed'),step('write-recovered','succeeded'),
      step('publish-recovered','succeeded','publish'),step('publish-failed','failed','publish')];
    for(const ordered of [steps,[...steps].reverse(),[steps[2]!,steps[0]!,steps[3]!,steps[1]!]]) {
      const view=project(ordered,['publish-recovered']);
      expect(view.occurrences).toHaveLength(1);
      expect(view.occurrences[0]?.state).toBe('succeeded');
      expect(view.occurrences[0]?.outputs.draft).toEqual(['draft-3']);
      expect(view.occurrences[0]?.technicalSteps.filter(item=>item.state==='failed')).toHaveLength(2);
    }
  });

  it('does not treat one successful technical step as proof of business completion',()=>{
    expect(project([step('write','succeeded'),step('publish','failed','publish')]).occurrences[0]?.state).toBe('failed');
    expect(project([step('write','failed'),step('retry','running')]).occurrences[0]?.state).toBe('running');
    expect(project([step('write','waiting')]).occurrences[0]?.state).toBe('waiting');
    expect(project([step('write','failed')]).occurrences[0]?.state).toBe('failed');
    expect(project([step('write','succeeded')]).occurrences[0]?.state).toBe('needs_review');
  });

  it('requires every declared output and a succeeded producing context before recovering',()=>{
    const twoOutputs={...contract,nodes:contract.nodes.map(node=>node.id==='author'?{
      ...node,outputs:{draft:{slot:'draft',min:1},summary:{slot:'summary',min:1}}
    }:node)} as ProcessContract;
    const steps=[step('write','succeeded'),step('publish-draft','succeeded','publish'),step('publish-summary','failed','publish')];
    const base={run,contract:twoOutputs,contractSource:'method' as const,steps,attempts:[],contexts:steps.map(item=>context(item.id)),assets:[],relations:[]};
    expect(projectProcess({...base,outputs:[{contextId:'context-publish-draft',slot:'draft',versionId:'draft-3'}]}).occurrences[0]?.state).toBe('failed');
    expect(projectProcess({...base,outputs:[{contextId:'context-publish-draft',slot:'draft',versionId:'draft-3'},
      {contextId:'context-publish-summary',slot:'summary',versionId:'summary-3'}]}).occurrences[0]?.state).toBe('failed');
    const recovered=[...steps,step('summary-retry','succeeded','publish')];
    expect(projectProcess({...base,steps:recovered,contexts:recovered.map(item=>context(item.id)),outputs:[
      {contextId:'context-publish-draft',slot:'draft',versionId:'draft-3'},
      {contextId:'context-summary-retry',slot:'summary',versionId:'summary-3'}]}).occurrences[0]?.state).toBe('succeeded');
  });

  it('preserves blocked validation after partial success and does not guess unknown output requirements',()=>{
    const blocked=[step('publish-draft','succeeded','publish'),step('validate','blocked','validation')];
    expect(project(blocked,['publish-draft']).occurrences[0]?.state).toBe('blocked');
    const unknown={...contract,results:[],nodes:contract.nodes.map(node=>node.id==='author'?{
      ...node,outputs:{draft:{slot:'draft'}}
    }:node)} as ProcessContract;
    expect(project([step('publish-draft','succeeded','publish'),step('validate','failed','validation')],['publish-draft'],unknown).occurrences[0]?.state).toBe('failed');
  });

  it('retains a distinct terminal outcome after a selected rewrite on the same decision event',()=>{
    const decision=step('decide','succeeded','decision');
    const selections=[{runId:'run',stepRunId:'decide',eventSeq:7,edgeId:'rewrite',annotation:{nodeId:'route',round:3}}] as ProcessDecisionObservation[];
    const resolver={resolverVersion:'historical-1',contract,mappings:[],routes:[{edgeId:'route-budget',eventSeq:7,stepRunId:'decide',round:3,
      observation:{route:'rewrite',round:2},reason:'not-converged; revision budget exhausted'}]} as HistoricalProcessResolution;
    const view=projectProcess({run,contract,contractSource:'method',resolver,steps:[decision],attempts:[],contexts:[],outputs:[],assets:[],relations:[],decisions:selections});
    expect(view.routes).toContainEqual({edgeId:'rewrite',eventSeq:7,stepRunId:'decide',round:3,reason:undefined,selectionOnly:true,provenance:'observed'});
    expect(view.routes).toContainEqual({...resolver.routes![0],provenance:'derived'});
  });

  it('keeps legacy resolver routes and same-edge explanations',()=>{
    const decision=step('decide','succeeded','decision');
    const resolver={resolverVersion:'historical-1',contract,mappings:[],routes:[{edgeId:'rewrite',eventSeq:7,stepRunId:'decide',round:3,reason:'guard selected rewrite'}]} as HistoricalProcessResolution;
    const base={run,contract,contractSource:'method' as const,resolver,steps:[decision],attempts:[],contexts:[],outputs:[],assets:[],relations:[]};
    expect(projectProcess(base).routes).toEqual([{...resolver.routes![0],provenance:'derived'}]);
    const decisions=[{runId:'run',stepRunId:'decide',eventSeq:7,edgeId:'rewrite',annotation:{nodeId:'route',round:3}}] as ProcessDecisionObservation[];
    expect(projectProcess({...base,decisions}).routes).toEqual([{edgeId:'rewrite',eventSeq:7,stepRunId:'decide',round:3,
      reason:'guard selected rewrite',selectionOnly:true,provenance:'observed'}]);
  });
});
