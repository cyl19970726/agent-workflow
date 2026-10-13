import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {JSON_SCHEMA_DIALECT} from '@signal-room/workflow-space-contracts';
import {PostgresBlobStore} from './blob-store.js';
import {BUSINESS_UNDERSTANDING_ASSET_ID,BUSINESS_UNDERSTANDING_SCHEMA_REF,createBusinessUnderstandingStore} from './business-understanding.js';
import {createMethodDesignStore} from './method-design.js';
import {migrateWorkflowSpaces} from './migration.js';
import {WorkflowSpaceService} from './service.js';

const databaseUrl=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;

suite('atomic design Space provisioning (isolated PostgreSQL)',()=>{
  let pool:Pool;
  let blobs:PostgresBlobStore;
  beforeAll(async()=>{pool=new Pool({connectionString:databaseUrl!,max:8});await migrateWorkflowSpaces(pool);blobs=new PostgresBlobStore(pool);});
  afterAll(async()=>{await pool?.end();});

  it('creates an empty scoped Space, recovers the exact receipt, and reads later understanding history',async()=>{
    const owner=new WorkflowSpaceService(pool,blobs,{id:'design-owner',kind:'human'});
    const designer={id:'trusted-design-service',kind:'service' as const,
      externalAgent:{id:'design-agent',sessionId:'real-host-session',role:'design' as const}};
    const input={id:`design-test-${randomUUID()}`,purpose:'A first method design',
      scope:{workflowId:'content.first-method',entrypoint:'content'},idempotencyKey:`provision-${randomUUID()}`};
    const receipt=await owner.provisionDesignSpace(input,designer);
    expect(receipt).toMatchObject({space:{id:input.id,owner:'design-owner',designScope:input.scope,
      provisionedBy:{agentId:'design-agent',sessionId:'real-host-session',principalId:designer.id}},
      scope:input.scope,initialCounts:{workflowVersions:0,understandingRevisions:0,methodDesignRevisions:0,
        cases:0,runs:0,businessAssets:0,assetVersions:0,adoptions:0}});
    const reopened=new WorkflowSpaceService(pool,blobs,{id:'design-owner',kind:'human'});
    expect(await reopened.provisionDesignSpace(input,designer)).toEqual(receipt);
    expect(await reopened.designSpaceState(input.id)).toEqual({space:receipt.space,scope:input.scope,
      counts:receipt.initialCounts,understandingRevisionId:null});
    expect((await pool.query<{namespace:string}>('SELECT namespace FROM ws_schemas WHERE space_id=$1',[input.id])).rows)
      .toEqual([{namespace:BUSINESS_UNDERSTANDING_SCHEMA_REF.namespace}]);
    expect((await pool.query<{role:string;principal_id:string}>(
      'SELECT principal_id,role FROM ws_members WHERE space_id=$1 ORDER BY principal_id',[input.id])).rows)
      .toEqual([{principal_id:'design-owner',role:'owner'},{principal_id:designer.id,role:'operator'}]);
    const designService=new WorkflowSpaceService(pool,blobs,designer);
    expect((await designService.listSpaces()).map(space=>space.id)).toContain(input.id);
    await expect(designService.provisionDesignSpace({...input,id:`other-${randomUUID()}`},designer))
      .rejects.toThrow('human owner');
    await expect(owner.provisionDesignSpace({...input,purpose:'Changed'},designer)).rejects.toThrow('Idempotency conflict');
    await expect(owner.provisionDesignSpace({...input,id:`changed-${randomUUID()}`},designer))
      .rejects.toThrow('Idempotency conflict');
    await expect(owner.provisionDesignSpace(input,{...designer,externalAgent:{...designer.externalAgent,id:'other-design-agent'}}))
      .rejects.toThrow('Idempotency conflict');
    await expect(owner.provisionDesignSpace({...input,idempotencyKey:'different-key'},designer))
      .rejects.toThrow('Space already exists');
    const otherOwner=new WorkflowSpaceService(pool,blobs,{id:'independent-owner',kind:'human'});
    const independent=await otherOwner.provisionDesignSpace({...input,id:`independent-${randomUUID()}`},designer);
    expect(independent.space.owner).toBe('independent-owner');
    await expect(otherOwner.designSpaceState(input.id)).rejects.toThrow('Space access denied');
    const concurrentInput={...input,id:`concurrent-${randomUUID()}`,idempotencyKey:`concurrent-${randomUUID()}`};
    const [concurrentA,concurrentB]=await Promise.all([
      owner.provisionDesignSpace(concurrentInput,designer),reopened.provisionDesignSpace(concurrentInput,designer)]);
    expect(concurrentA).toEqual(concurrentB);
    await expect(owner.provisionDesignSpace({...input,id:`observer-${randomUUID()}`,idempotencyKey:'observer-key'},
      {...designer,externalAgent:{...designer.externalAgent,role:'observer'}})).rejects.toThrow('trusted design Agent');
    await expect(owner.provisionDesignSpace({...input,id:`unbound-${randomUUID()}`,idempotencyKey:'unbound-key'},
      {id:'unbound-service',kind:'service'})).rejects.toThrow('trusted design Agent');
    const understanding=createBusinessUnderstandingStore(designService);
    const base={title:'Business understanding',sources:[{kind:'user-request' as const,ref:'request-1',title:'Original request'}],
      authorship:{kind:'agent' as const,name:'design-agent',sessionId:'real-host-session'}};
    const first=await understanding.save(input.id,{...base,content:'Initial purpose',changeReason:'First draft',
      expectedRevisionId:null,idempotencyKey:'understanding-1'});
    const second=await understanding.save(input.id,{...base,content:'Revised purpose',changeReason:'New evidence',
      expectedRevisionId:first.id,idempotencyKey:'understanding-2'});
    expect(second.previousRevisionId).toBe(first.id);
    expect((await understanding.history(input.id)).map(item=>item.id)).toEqual([first.id,second.id]);
    const state=await reopened.designSpaceState(input.id);
    expect(state.counts).toEqual({...receipt.initialCounts,understandingRevisions:2,assetVersions:2});
    expect(state.understandingRevisionId).toBe(second.id);
    expect((await pool.query<{id:string;namespace:string}>('SELECT id,namespace FROM ws_assets WHERE space_id=$1',[input.id])).rows)
      .toEqual([{id:BUSINESS_UNDERSTANDING_ASSET_ID,namespace:BUSINESS_UNDERSTANDING_SCHEMA_REF.namespace}]);
    expect((await reopened.provisionDesignSpace(input,designer)).initialCounts).toEqual(receipt.initialCounts);
    await createMethodDesignStore(owner).ensure(input.id);
    await createMethodDesignStore(designService).save(input.id,{workflowId:input.scope.workflowId,entrypoint:input.scope.entrypoint,
      understanding:{revisionId:second.id,payloadHash:second.payloadHash},expectedRevisionId:null,idempotencyKey:'method-design-1',
      title:'First method',content:'Design draft',sources:base.sources,authorship:base.authorship,changeReason:'Initial method'});
    expect((await reopened.designSpaceState(input.id)).counts)
      .toEqual({...receipt.initialCounts,understandingRevisions:2,methodDesignRevisions:1,assetVersions:3});
    const [businessSchema]=await owner.registerSchemas(input.id,[{namespace:'test/design-space-business',revision:'1',
      dialect:JSON_SCHEMA_DIALECT,schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{text:{type:'string'}},
        required:['text'],additionalProperties:false}}]);
    await owner.importAsset(input.id,{schema:{namespace:businessSchema!.namespace,revision:businessSchema!.revision,
      hash:businessSchema!.hash},payload:{text:'An actual business asset'},description:'Count fixture',idempotencyKey:'business-1'});
    expect((await reopened.designSpaceState(input.id)).counts)
      .toEqual({...receipt.initialCounts,understandingRevisions:2,methodDesignRevisions:1,businessAssets:1,assetVersions:4});
  },20_000);

  it('rolls back Space, membership, schema and receipt when setup fails inside the transaction',async()=>{
    const id=`design-rollback-${randomUUID()}`;
    const brokenPool={connect:async()=>{
      const db=await pool.connect();
      return {query:(sql:string,values?:unknown[])=>{
        if(sql.startsWith('INSERT INTO ws_schemas('))throw new Error('Injected schema failure');
        return db.query(sql,values);
      },release:()=>db.release()} as PoolClient;
    }} as Pool;
    const owner=new WorkflowSpaceService(brokenPool,blobs,{id:'design-owner',kind:'human'});
    const designer={id:'trusted-design-service',kind:'service' as const,
      externalAgent:{id:'design-agent',sessionId:'real-host-session',role:'design' as const}};
    await expect(owner.provisionDesignSpace({id,purpose:'Rollback fixture',
      scope:{workflowId:'content.first-method',entrypoint:'content'},idempotencyKey:'rollback'},designer))
      .rejects.toThrow('Injected schema failure');
    for(const table of ['ws_spaces','ws_members','ws_schemas','ws_commits']){
      const column=table==='ws_spaces'?'id':'space_id';
      const result=await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,[id]);
      expect(result.rows[0]?.count).toBe(0);
    }
  },20_000);
});
