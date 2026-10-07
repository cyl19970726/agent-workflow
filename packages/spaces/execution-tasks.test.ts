import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSON_SCHEMA_DIALECT } from '@signal-room/workflow-space-contracts';
import { PostgresBlobStore } from './blob-store.js';
import { migrateWorkflowSpaces } from './migration.js';
import { WorkflowSpaceService } from './service.js';
import { WorkflowExecutionManager } from './execution-tasks.js';

const url=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
let pool:Pool;
async function fixture() {
  const service=new WorkflowSpaceService(pool,new PostgresBlobStore(pool),{id:'execution-owner',kind:'human'});
  const space=await service.createSpace({id:`execution-${randomUUID()}`,purpose:'Execution task test'});
  const [schema]=await service.registerSchemas(space.id,[{namespace:'test/execution',revision:'1',dialect:JSON_SCHEMA_DIALECT,
    schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]);
  await service.publishWorkflow(space.id,{id:'v1',revision:'1',changeReason:'Test',config:{},entrypoints:{main:{workflowId:'flow',codeRevision:'1',
    storageContract:{workflowVersion:'v1',nodes:{node:{actorKinds:['program'],inputs:{},outputs:{},actions:[]}},stateRules:[]}}}});
  await service.createCase(space.id,{id:'case',title:'Case',objective:'Test',constraints:[]});
  const manifest=await service.freezeInputs(space.id,'case',{});
  const binding={workflowVersionId:'v1',entrypoint:'main',inputManifestId:manifest.id};
  let sequence=0;
  const enqueue=(key?:string,executorKey='test')=>service.enqueueExecution(space.id,binding,
    {workflowId:'flow',workflowRevision:'1',inputFingerprint:manifest.hash,state:'queued',
      metadata:{commandKey:key??`command-${++sequence}`,commandFingerprint:(sequence.toString(16)).padStart(64,'0')}},{executorKey});
  return {service,space,binding,manifest,enqueue};
}
suite('durable Workflow Space execution tasks',()=>{
  beforeAll(async()=>{pool=new Pool({connectionString:url!,max:12});await migrateWorkflowSpaces(pool);});
  afterAll(async()=>{await pool?.end();});

  it('binds a queued task and native run atomically, returns exact retry and rejects a changed executor',async()=>{
    const f=await fixture();
    const first=await f.enqueue('same');
    const retry=await f.enqueue('same');
    expect(retry.task).toEqual(first.task);
    expect(retry.run.id).toBe(first.run.id);
    await expect(f.enqueue('same','different')).rejects.toThrow('conflicts');
    expect(await f.service.executionTasks(f.space.id)).toHaveLength(1);
    await expect((await f.service.runtimeEvidence(f.space.id)).getRun(first.run.id)).resolves.toMatchObject({state:'queued'});
  });

  it('enforces one persisted Space limit across managers and leaves expired work interrupted',async()=>{
    const f=await fixture();
    await f.enqueue();await f.enqueue();
    const [a,b]=await Promise.all([
      f.service.claimExecution(f.space.id,{workerId:'host-a',executorKeys:['test'],concurrency:1,leaseMs:1000}),
      f.service.claimExecution(f.space.id,{workerId:'host-b',executorKeys:['test'],concurrency:1,leaseMs:1000}),
    ]);
    expect([a,b].filter(Boolean)).toHaveLength(1);
    await expect(f.service.claimExecution(f.space.id,{workerId:'host-c',executorKeys:['test'],concurrency:2,leaseMs:1000})).rejects.toThrow('concurrency conflict');
    const claimed=a??b!;
    await expect(f.service.heartbeatExecution(f.space.id,claimed.runId,'wrong',1000)).rejects.toThrow('not active');
    await new Promise(resolve=>setTimeout(resolve,1100));
    const restarted=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,concurrency:1,executorKeys:()=>['test'],execute:async()=>{throw new Error('Must not replay');}});
    expect(await f.service.getExecutionTask(f.space.id,claimed.runId)).toMatchObject({status:'interrupted',leaseExpired:true});
    await expect(restarted.completion(claimed.runId)).rejects.toThrow('Lease expired');
    expect((await f.service.reconcileExecutions(f.space.id))[0]?.status).toBe('interrupted');
    expect(await f.service.claimExecution(f.space.id,{workerId:'host-c',executorKeys:['test'],concurrency:1,leaseMs:1000})).toBeUndefined();
    await expect(f.service.finishExecution(f.space.id,claimed.runId,'wrong',{status:'failed'})).rejects.toThrow('token');
    await f.service.finishExecution(f.space.id,claimed.runId,claimed.claimToken!,{status:'failed',error:'Owner confirmed failure'});
    expect((await f.service.claimExecution(f.space.id,{workerId:'host-c',executorKeys:['test'],concurrency:1,leaseMs:1000}))?.status).toBe('running');
  });

  it('cancels a queued run without executing it',async()=>{
    const f=await fixture(),{task}=await f.enqueue();
    expect((await f.service.cancelExecution(f.space.id,task.runId)).status).toBe('canceled');
    expect((await (await f.service.runtimeEvidence(f.space.id)).getRun(task.runId))?.state).toBe('canceled');
    expect(await f.service.claimExecution(f.space.id,{workerId:'host',executorKeys:['test'],concurrency:1,leaseMs:1000})).toBeUndefined();
  });

  it('does not call an executor until wake, and keeps cancel requested until its callback settles',async()=>{
    const f=await fixture(),{task}=await f.enqueue();
    let executions=0;
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const manager=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,concurrency:1,executorKeys:()=>['test'],pollMs:20,leaseMs:1000,
      execute:async(_task,signal)=>{executions++;await gate;expect(signal.aborted).toBe(true);throw new Error('Canceled after callback settled');}});
    expect(executions).toBe(0);
    expect((await f.service.getExecutionTask(f.space.id,task.runId))?.status).toBe('queued');
    await manager.wake();
    for(let i=0;i<20&&executions===0;i++) await new Promise(resolve=>setTimeout(resolve,10));
    expect(executions).toBe(1);
    await manager.cancel(task.runId);
    expect((await f.service.getExecutionTask(f.space.id,task.runId))?.status).toBe('cancel_requested');
    release();
    await manager.waitIdle();
    expect((await f.service.getExecutionTask(f.space.id,task.runId))?.status).toBe('canceled');
    await expect(manager.completion(task.runId)).rejects.toThrow('Canceled after callback settled');
  });

  it('wakes queued work after another host frees the Space, without replaying finished work',async()=>{
    const f=await fixture();
    const first=await f.enqueue(undefined,'first'),second=await f.enqueue(undefined,'second');
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const execute=async(task:{runId:string},wait=false)=>{
      if(wait) await gate;
      const ledger=await f.service.runtimeLedger(f.space.id);
      await ledger.updateRun(task.runId,{state:'succeeded'});
      return {run:(await ledger.getRun(task.runId))!};
    };
    const hostA=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,workerId:'first-host',concurrency:1,executorKeys:()=>['first'],pollMs:20,leaseMs:1000,
      execute:task=>execute(task,true)});
    const hostB=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,workerId:'second-host',concurrency:1,executorKeys:()=>['second'],pollMs:20,leaseMs:1000,
      execute:task=>execute(task)});
    await hostA.wake();
    await hostB.wake();
    expect((await f.service.getExecutionTask(f.space.id,second.task.runId))?.status).toBe('queued');
    release();
    await Promise.all([hostA.waitIdle(),hostB.waitIdle()]);
    expect((await f.service.getExecutionTask(f.space.id,first.task.runId))?.status).toBe('completed');
    expect((await f.service.getExecutionTask(f.space.id,second.task.runId))?.status).toBe('completed');
    expect((await hostB.completion(second.task.runId)).run.state).toBe('succeeded');
    await hostA.stop();await hostB.stop();
  });

  it('settles a queued completion waiter on stop and leaves the task for a new manager',async()=>{
    const f=await fixture(),{task}=await f.enqueue();
    let calls=0;
    const stopped=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,concurrency:1,executorKeys:()=>['test'],pollMs:10_000,
      execute:async()=>{calls++;throw new Error('Stopped manager must not execute');}});
    const pending=stopped.completion(task.runId);
    const rejection=expect(pending).rejects.toThrow('Execution manager stopped; task remains queued or unfinished');
    await new Promise(resolve=>setTimeout(resolve,30));
    await stopped.stop();
    await Promise.race([rejection,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Completion waiter did not stop promptly')),300))]);
    expect(calls).toBe(0);
    expect((await f.service.getExecutionTask(f.space.id,task.runId))?.status).toBe('queued');
    const restarted=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,concurrency:1,executorKeys:()=>['test'],pollMs:20,
      execute:async claimed=>{
        const ledger=await f.service.runtimeLedger(f.space.id);
        await ledger.updateRun(claimed.runId,{state:'succeeded'});
        return {run:(await ledger.getRun(claimed.runId))!};
      }});
    await restarted.wake();
    await restarted.waitIdle();
    expect((await restarted.completion(task.runId)).run.state).toBe('succeeded');
    await restarted.stop();
  });

  it('claims only the exact target under concurrent requests, leaving older and later work queued',async()=>{
    const f=await fixture();
    const older=await f.enqueue(),target=await f.enqueue(),candidate=await f.enqueue();
    const claim=(workerId:string)=>f.service.claimExecution(f.space.id,{workerId,executorKeys:['test'],concurrency:1,leaseMs:1000,runId:target.task.runId});
    const [first,second]=await Promise.all([claim('target-a'),claim('target-b')]);
    expect([first,second].filter(Boolean).map(task=>task!.runId)).toEqual([target.task.runId]);
    expect((await f.service.getExecutionTask(f.space.id,older.task.runId))?.status).toBe('queued');
    expect((await f.service.getExecutionTask(f.space.id,candidate.task.runId))?.status).toBe('queued');
    expect(await claim('target-c')).toBeUndefined();
  });

  it.each(['succeeded','failed'] as const)('keeps every automatic wake on the target after a %s run',async outcome=>{
    const f=await fixture();
    const older=await f.enqueue(),target=await f.enqueue(),candidate=await f.enqueue();
    const executed:string[]=[];
    const manager=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,runId:target.task.runId,
      concurrency:1,executorKeys:()=>['test'],pollMs:20,leaseMs:1000,
      execute:async task=>{
        executed.push(task.runId);
        if(outcome==='failed') throw new Error('Controlled executor failure');
        const ledger=await f.service.runtimeLedger(f.space.id);
        await ledger.updateRun(task.runId,{state:'succeeded'});
        return {run:(await ledger.getRun(task.runId))!};
      }});
    await expect(manager.completion(older.task.runId)).rejects.toThrow('targets a different run');
    await manager.wake();
    await manager.waitIdle();
    await manager.wake();
    await manager.waitIdle();
    expect(executed).toEqual([target.task.runId]);
    expect((await f.service.getExecutionTask(f.space.id,target.task.runId))?.status).toBe(outcome==='succeeded'?'completed':'failed');
    expect((await f.service.getExecutionTask(f.space.id,older.task.runId))?.status).toBe('queued');
    expect((await f.service.getExecutionTask(f.space.id,candidate.task.runId))?.status).toBe('queued');
    await manager.stop();
  });

  it('retries only its target after another host frees the Space',async()=>{
    const f=await fixture();
    const older=await f.enqueue(),target=await f.enqueue(),candidate=await f.enqueue();
    const occupying=await f.service.claimExecution(f.space.id,{workerId:'other-host',executorKeys:['test'],concurrency:1,leaseMs:1000,runId:older.task.runId});
    expect(occupying?.runId).toBe(older.task.runId);
    const executed:string[]=[];
    const manager=new WorkflowExecutionManager({service:f.service,spaceId:f.space.id,runId:target.task.runId,
      concurrency:1,executorKeys:()=>['test'],pollMs:20,leaseMs:1000,
      execute:async task=>{
        executed.push(task.runId);
        const ledger=await f.service.runtimeLedger(f.space.id);
        await ledger.updateRun(task.runId,{state:'succeeded'});
        return {run:(await ledger.getRun(task.runId))!};
      }});
    await manager.wake();
    expect(executed).toEqual([]);
    await f.service.finishExecution(f.space.id,older.task.runId,occupying!.claimToken!,{status:'failed',error:'Controlled release'});
    await Promise.race([manager.completion(target.task.runId),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Target was not retried')),1000))]);
    await manager.waitIdle();
    expect(executed).toEqual([target.task.runId]);
    expect((await f.service.getExecutionTask(f.space.id,candidate.task.runId))?.status).toBe('queued');
    await manager.stop();
  });
});
