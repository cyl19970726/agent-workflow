import {describe,expect,it} from 'vitest';
import {SchemaRegistry,type SchemaDefinition} from '@signal-room/workflow-space-contracts';
import {createExecutionBudgetStore,executionBudgetAssetId,EXECUTION_BUDGET_SCHEMA_REF,DEFAULT_EXECUTION_BUDGET_LIMITS,type ExecutionBudgetReserve} from './execution-budget.js';
import type {WorkflowSpaceService} from './service.js';
import type {AssetVersion,AssetWrite} from './types.js';

const initial={id:'budget-1',workflowVersionId:'version-1',validationSha256:'a'.repeat(64),limits:DEFAULT_EXECUTION_BUDGET_LIMITS,idempotencyKey:'create-1'};
function fixture(){
  let clock=Date.parse('2026-10-11T00:00:00Z');
  const assets:AssetVersion[]=[];
  const schemas=new SchemaRegistry();
  const commits=new Map<string,AssetVersion>();
  const service={
    async registerSchemas(_spaceId:string,definitions:SchemaDefinition[]){return definitions.map(value=>schemas.registerSchema(value));},
    async readAssetHead(_spaceId:string,assetId:string){return assets.filter(value=>value.assetId===assetId).at(-1)??null;},
    async importAsset(spaceId:string,input:AssetWrite & {description:string;idempotencyKey:string}){
      await Promise.resolve();
      schemas.validatePayload(input.schema,input.payload);
      const committed=commits.get(input.idempotencyKey);
      if(committed)return committed;
      const head=assets.filter(value=>value.assetId===input.assetId).at(-1);
      if(head?.id!==input.expectedHead&&(head||input.expectedHead))throw new Error('Asset version conflict');
      const version:AssetVersion={id:`budget-revision-${assets.length+1}`,spaceId,assetId:input.assetId!,version:(head?.version??0)+1,
        schema:input.schema,payload:input.payload,payloadHash:`hash-${assets.length+1}`,createdAt:new Date(clock).toISOString(),
        source:{kind:'import',actorId:'writer',description:input.description},dependencies:input.dependencies??[],attachments:[],initialState:'imported'};
      assets.push(version);commits.set(input.idempotencyKey,version);return version;
    },
  } as unknown as WorkflowSpaceService;
  const store=createExecutionBudgetStore(service,{now:()=>new Date(clock)});
  const reserve=(runId:string,turn:number,overrides:Partial<ExecutionBudgetReserve>={}):ExecutionBudgetReserve=>({runId,stepRunId:'step-1',attemptId:'attempt-1',turn,stage:'case',kind:'original',...overrides});
  return {service,store,assets,reserve,advance:(ms:number)=>{clock+=ms;}};
}

describe('durable aggregate execution budget',()=>{
  it('creates an inert clock, reserves idempotently, and aggregates trial and case calls across a restarted store',async()=>{
    const f=fixture();await f.store.ensure('space');
    const created=await f.store.create('space',initial);
    expect(created).toMatchObject({assetId:executionBudgetAssetId(initial.id),startedAt:null,reservations:[]});
    expect(f.assets[0]?.schema).toEqual(EXECUTION_BUDGET_SCHEMA_REF);
    expect((await f.store.create('space',initial)).id).toBe(created.id);
    await expect(f.store.create('space',{...initial,validationSha256:'b'.repeat(64)})).rejects.toThrow('different creation identity');
    const first=await f.store.reserve('space',initial.id,f.reserve('trial',1,{stage:'trial'}));
    expect(first).toMatchObject({callOrdinal:1,reservedAt:'2026-10-11T00:00:00.000Z',deadlineAt:'2026-10-11T01:00:00.000Z'});
    f.advance(1000);
    const restarted=createExecutionBudgetStore(f.service,{now:()=>new Date('2026-10-11T00:00:01Z')});
    expect(await restarted.reserve('space',initial.id,f.reserve('trial',1,{stage:'trial'}))).toEqual({...first,reused:true});
    expect((await restarted.read('space',initial.id)).reservations).toHaveLength(1);
    expect((await restarted.reserve('space',initial.id,f.reserve('trial',2,{stage:'trial',kind:'technical-repair'}))).callOrdinal).toBe(2);
    await expect(restarted.reserve('space',initial.id,f.reserve('trial',3,{stage:'trial'}))).rejects.toThrow('trial call limit');
    for(let turn=1;turn<=13;turn++)await restarted.reserve('space',initial.id,f.reserve('case',turn,{stepRunId:`step-${turn}`,kind:turn===2?'tool-continuation':'original'}));
    expect((await restarted.read('space',initial.id)).reservations).toHaveLength(15);
    await expect(restarted.reserve('space',initial.id,f.reserve('case',14))).rejects.toThrow('call limit');
  });
  it('replays the same creation after PostgreSQL JSONB reorders frozen limit keys',async()=>{
    const f=fixture();await f.store.ensure('space');
    const limits={...DEFAULT_EXECUTION_BUDGET_LIMITS,trialSecondKinds:['tool-continuation','technical-repair'] as Array<'tool-continuation'|'technical-repair'>};
    const request={...initial,limits};
    await f.store.create('space',request);
    await f.store.reserve('space',initial.id,f.reserve('trial',1,{stage:'trial'}));
    const head=f.assets.at(-1)!;
    const payload=head.payload as Record<string,unknown>;
    f.assets[f.assets.length-1]={...head,payload:{...payload,limits:{
      trialSecondKinds:['tool-continuation','technical-repair'],
      maxTechnicalRepairsPerOccurrence:1,maxTrialCalls:2,maxNodeDurationMs:900_000,maxDurationMs:3_600_000,maxCalls:15,
    }}};
    const replay=await f.store.create('space',request);
    expect(replay.id).toBe(head.id);
    expect(replay.reservations).toHaveLength(1);
    expect(f.assets).toHaveLength(2);
  });
  it('allows only original then one technical repair in the trial, while case continuations use the aggregate budget',async()=>{
    const f=fixture();await f.store.ensure('space');await f.store.create('space',initial);
    await expect(f.store.reserve('space',initial.id,f.reserve('trial',1,{stage:'trial',kind:'tool-continuation'}))).rejects.toThrow('begin with an original');
    await expect(f.store.reserve('space',initial.id,f.reserve('trial',1,{stage:'trial',kind:'technical-repair'}))).rejects.toThrow('begin with an original');
    const first=await f.store.reserve('space',initial.id,f.reserve('trial',1,{stage:'trial'}));
    expect(first.callOrdinal).toBe(1);
    await expect(f.store.reserve('space',initial.id,f.reserve('trial',2,{stage:'trial',kind:'tool-continuation'}))).rejects.toThrow('frozen allowed kind');
    await expect(f.store.reserve('space',initial.id,f.reserve('trial',2,{stage:'trial',kind:'original'}))).rejects.toThrow('frozen allowed kind');
    await expect(f.store.reserve('space',initial.id,f.reserve('other-trial',2,{stage:'trial',kind:'technical-repair'}))).rejects.toThrow('original occurrence');
    expect((await f.store.reserve('space',initial.id,f.reserve('trial',2,{stage:'trial',kind:'technical-repair'}))).callOrdinal).toBe(2);
    expect((await f.store.reserve('space',initial.id,f.reserve('case',1))).callOrdinal).toBe(3);
    expect((await f.store.reserve('space',initial.id,f.reserve('case',2,{kind:'tool-continuation'}))).callOrdinal).toBe(4);
  });
  it('honors a frozen v3 trial second-kind choice without a third provider request',async()=>{
    for(const kind of ['tool-continuation','technical-repair'] as const){
      const f=fixture();await f.store.ensure('space');
      const limits={...DEFAULT_EXECUTION_BUDGET_LIMITS,trialSecondKinds:['tool-continuation','technical-repair'] as Array<'tool-continuation'|'technical-repair'>};
      const created=await f.store.create('space',{...initial,limits});
      expect(created.limits.trialSecondKinds).toEqual(['tool-continuation','technical-repair']);
      await f.store.reserve('space',initial.id,f.reserve('trial',1,{stage:'trial'}));
      expect((await f.store.reserve('space',initial.id,f.reserve('trial',2,{stage:'trial',kind}))).callOrdinal).toBe(2);
      await expect(f.store.reserve('space',initial.id,f.reserve('trial',3,{stage:'trial',kind:kind==='tool-continuation'?'technical-repair':'tool-continuation'}))).rejects.toThrow('trial call limit');
      expect((await f.store.read('space',initial.id)).reservations).toHaveLength(2);
    }
  });
  it('denies identity collisions, a second technical repair, and clocks that survive new attempts',async()=>{
    const f=fixture();await f.store.ensure('space');await f.store.create('space',initial);
    await f.store.reserve('space',initial.id,f.reserve('run',1));
    await expect(f.store.reserve('space',initial.id,f.reserve('run',1,{kind:'technical-repair'}))).rejects.toThrow('identity collision');
    await f.store.reserve('space',initial.id,f.reserve('run',2,{kind:'technical-repair'}));
    await expect(f.store.reserve('space',initial.id,f.reserve('run',3,{kind:'technical-repair'}))).rejects.toThrow('technical repair limit');
    f.advance(900_000);
    await expect(f.store.reserve('space',initial.id,f.reserve('run',3,{attemptId:'new-attempt',kind:'tool-continuation'}))).rejects.toThrow('node duration');
    const other=await f.store.reserve('space',initial.id,f.reserve('other',1));
    expect(other.deadlineAt).toBe('2026-10-11T01:00:00.000Z');
    f.advance(2_700_000);
    await expect(f.store.reserve('space',initial.id,f.reserve('other',2,{attemptId:'restart'}))).rejects.toThrow('duration exceeded');
    await expect(f.store.reserve('space',initial.id,f.reserve('run',1))).rejects.toThrow('duration exceeded');
  });
  it('denies reuse of an exact reservation once the occurrence deadline passes',async()=>{
    const f=fixture();await f.store.ensure('space');await f.store.create('space',initial);
    const first=await f.store.reserve('space',initial.id,f.reserve('run',1));
    expect(first.reused).toBe(false);
    expect((await f.store.reserve('space',initial.id,f.reserve('run',1))).reused).toBe(true);
    f.advance(900_000);
    await expect(f.store.reserve('space',initial.id,f.reserve('run',1))).rejects.toThrow('node duration exceeded');
  });
  it('serializes concurrent reservations with CAS and fails closed after repeated contention',async()=>{
    const f=fixture();await f.store.ensure('space');await f.store.create('space',initial);
    const results=await Promise.all([f.store.reserve('space',initial.id,f.reserve('a',1)),f.store.reserve('space',initial.id,f.reserve('b',1))]);
    expect(results.map(item=>item.callOrdinal).sort()).toEqual([1,2]);
    expect((await f.store.read('space',initial.id)).reservations).toHaveLength(2);
    const contested={...f.service,importAsset:async()=>{throw new Error('Asset version conflict');}} as WorkflowSpaceService;
    const denied=createExecutionBudgetStore(contested,{now:()=>new Date('2026-10-11T00:00:01Z')});
    await expect(denied.reserve('space',initial.id,f.reserve('c',1))).rejects.toThrow('contention; reservation denied');
  });
  it('lets only one concurrent identical invocation authorize a provider POST',async()=>{
    const f=fixture();await f.store.ensure('space');await f.store.create('space',initial);
    const same=f.reserve('run',1);
    const receipts=await Promise.all([f.store.reserve('space',initial.id,same),f.store.reserve('space',initial.id,same)]);
    expect(receipts.map(item=>item.reused).sort()).toEqual([false,true]);
    expect(receipts[0]?.callOrdinal).toBe(1);
    expect(receipts[1]?.callOrdinal).toBe(1);
    expect((await f.store.read('space',initial.id)).reservations).toHaveLength(1);
    expect(f.assets).toHaveLength(2);
  });
  it('rejects invalid safety ceilings and cannot register schemas through reads',async()=>{
    const f=fixture();
    await expect(f.store.read('space',initial.id)).rejects.toThrow('not found');
    expect(f.assets).toHaveLength(0);
    await expect(f.store.create('space',{...initial,limits:{...initial.limits,maxCalls:16}})).rejects.toThrow('Invalid execution budget maxCalls');
    await expect(f.store.create('space',{...initial,limits:{...initial.limits,trialSecondKinds:['original' as never]}})).rejects.toThrow('Invalid trial second kinds');
    await expect(f.store.create('space',{...initial,validationSha256:'wrong'})).rejects.toThrow('validation SHA-256');
  });
});
