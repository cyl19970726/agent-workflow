import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSON_SCHEMA_DIALECT, type SchemaRef } from '@signal-room/workflow-space-contracts';
import { WorkflowSpaceService } from './service.js';
import { PostgresBlobStore } from './blob-store.js';
import { migrateWorkflowSpaces } from './migration.js';
import type { WorkflowVersionDraft } from './types.js';

const url=process.env.WORKFLOW_TEST_DATABASE_URL;
(url?describe:describe.skip)('Published method definitions',()=>{
  let pool:Pool,service:WorkflowSpaceService;
  beforeAll(async()=>{pool=new Pool({connectionString:url});await migrateWorkflowSpaces(pool);service=new WorkflowSpaceService(pool,new PostgresBlobStore(pool),{id:'definition-owner',kind:'human'});});
  afterAll(async()=>{await pool?.end();});
  async function fixture(){
    const space=await service.createSpace({purpose:'Isolated method definition validation'});
    const [registered]=await service.registerSchemas(space.id,[{namespace:'test/method-data',revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:{type:'string'}}]);
    const ref:SchemaRef={namespace:registered!.namespace,revision:registered!.revision,hash:registered!.hash};
    const version=(id:string,workflowId='test.method'):WorkflowVersionDraft=>({id,revision:id,changeReason:'Deterministic fixture',config:{},entrypoints:{main:{workflowId,codeRevision:id,
      storageContract:{workflowVersion:id,nodes:{writer:{actorKinds:['agent'],inputs:{},outputs:{draft:{schema:ref,requiredInputs:[],appendVersions:true,initialState:'candidate'}},actions:['appendOutputVersion']}},stateRules:[]},
      process:{revision:'1',nodes:[{id:'writer',kind:'agent',storageNodeId:'writer',outputs:{draft:{slot:'draft'}}}],edges:[],results:[]},
      nodeDefinitions:{writer:{purpose:'Produce draft',instructions:'Use only supplied evidence',model:'fixture-model',tools:[],configuration:{temperature:0}}},
    }}});
    return {space,version};
  }
  it('publishes with zero runs, records an explicit predecessor, and preserves immutable node instructions',async()=>{
    const {space,version}=await fixture();const first=version('v1');
    const saved=await service.publishWorkflow(space.id,first);
    expect(await service.publishWorkflow(space.id,first)).toEqual(saved);
    await service.publishWorkflow(space.id,{...version('v2'),predecessorId:'v1'});
    const data=await service.overview(space.id);
    expect(data.runs).toHaveLength(0);expect(data.cases).toHaveLength(0);expect(data.assets).toHaveLength(0);
    expect(data.workflows.find(value=>value.id==='v2')?.predecessorId).toBe('v1');
    const changed=version('v1');changed.entrypoints.main!.nodeDefinitions!.writer!.instructions='Changed prompt';
    await expect(service.publishWorkflow(space.id,changed)).rejects.toThrow('immutable');
  });
  it('rejects invented, cross-workflow and self predecessors',async()=>{
    const {space,version}=await fixture();await service.publishWorkflow(space.id,version('other','test.other'));
    await expect(service.publishWorkflow(space.id,{...version('v2'),predecessorId:'missing'})).rejects.toThrow('not found');
    await expect(service.publishWorkflow(space.id,{...version('v2'),predecessorId:'other'})).rejects.toThrow('identity');
    await expect(service.publishWorkflow(space.id,{...version('v2'),predecessorId:'v2'})).rejects.toThrow('itself');
  });
  it('validates declared node references and rejects credentials in declared configurations',async()=>{
    const {space,version}=await fixture();const unknown=version('unknown');unknown.entrypoints.main!.nodeDefinitions={ghost:{purpose:'Invented'}};
    await expect(service.publishWorkflow(space.id,unknown)).rejects.toThrow('declared node');
    const secret=version('secret');secret.entrypoints.main!.nodeDefinitions!.writer!.configuration={api_key:'fixture-secret'};
    await expect(service.publishWorkflow(space.id,secret)).rejects.toThrow('Credentials');
    const legacy=version('legacy');delete legacy.entrypoints.main!.nodeDefinitions;
    expect((await service.publishWorkflow(space.id,legacy)).entrypoints.main!.nodeDefinitions).toBeUndefined();
  });
  it('publishes typed executor declarations and rejects malformed or extended declarations',async()=>{
    const {space,version}=await fixture();
    for(const family of ['agent-sdk','codex','program','human','decision'] as const) {
      const declared=version(`executor-${family}`);
      const executor={family,...(family==='agent-sdk'?{adapter:'SIWC Responses'}:{})};
      declared.entrypoints.main!.nodeDefinitions!.writer!.executor=executor;
      const saved=await service.publishWorkflow(space.id,declared);
      expect(saved.entrypoints.main!.nodeDefinitions!.writer!.executor).toEqual(executor);
    }

    const malformed:Array<{value:unknown;error:string}>=[
      {value:null,error:'Invalid node executor'},
      {value:[],error:'Invalid node executor'},
      {value:{},error:'Invalid node executor family'},
      {value:{family:'unknown'},error:'Invalid node executor family'},
      {value:{family:'human',adapter:''},error:'Invalid node executor adapter'},
      {value:{family:'program',adapter:42},error:'Invalid node executor adapter'},
      {value:{family:'decision',unexpected:true},error:'Unsupported node executor field'},
    ];
    for(const [index,{value:executor,error}] of malformed.entries()) {
      const candidate=version(`executor-invalid-${index}`);
      (candidate.entrypoints.main!.nodeDefinitions!.writer as {executor?:unknown}).executor=executor;
      await expect(service.publishWorkflow(space.id,candidate)).rejects.toThrow(error);
    }
  });
});
