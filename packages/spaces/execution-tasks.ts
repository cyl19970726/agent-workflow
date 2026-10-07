import { randomUUID } from 'node:crypto';
import type { RunRecord } from '@signal-room/workflow';
import type { ExecutionTask, WorkflowSpaceService } from './service.js';
export type { ExecutionTask } from './service.js';

export interface WorkflowExecutionManagerOptions {
  service:WorkflowSpaceService; spaceId:string; concurrency:number; executorKeys:()=>string[];
  execute:(task:ExecutionTask,signal:AbortSignal)=>Promise<{run:RunRecord}>;
  workerId?:string; leaseMs?:number; pollMs?:number; runId?:string;
}

/** Explicit worker. Merely constructing it or reading a completion never dispatches work. */
export class WorkflowExecutionManager {
  private readonly workerId:string;
  private readonly leaseMs:number;
  private readonly pollMs:number;
  private readonly runId?:string;
  private readonly jobs=new Map<string,{abort:AbortController;promise:Promise<void>}>();
  private pumping?:Promise<void>;
  private wakeRequested=false;
  private retryTimer?:ReturnType<typeof setTimeout>;
  private readonly stopSignal=new AbortController();
  private stopped=false;
  constructor(private readonly options:WorkflowExecutionManagerOptions) {
    if(!Number.isInteger(options.concurrency)||options.concurrency<1) throw new Error('Concurrency must be a positive integer');
    if(options.runId!==undefined&&(!options.runId||!options.runId.trim())) throw new Error('Target run ID must be nonempty');
    this.runId=options.runId;
    this.workerId=options.workerId??randomUUID();
    this.leaseMs=options.leaseMs??30_000;
    this.pollMs=options.pollMs??500;
    if(this.leaseMs<1000||this.pollMs<10) throw new Error('Invalid execution polling or lease interval');
  }
  wake():Promise<void> {
    if(this.stopped) return Promise.resolve();
    if(this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer=undefined; }
    if(this.pumping) { this.wakeRequested=true; return this.pumping; }
    const pump=this.admit();
    this.pumping=pump.finally(()=>{
      this.pumping=undefined;
      if(this.wakeRequested&&!this.stopped) { this.wakeRequested=false; void this.wake().catch(()=>{}); }
    });
    return this.pumping;
  }
  private async admit():Promise<void> {
    while(!this.stopped&&this.jobs.size<this.options.concurrency) {
      const task=await this.options.service.claimExecution(this.options.spaceId,{
        workerId:this.workerId,executorKeys:this.options.executorKeys(),concurrency:this.options.concurrency,leaseMs:this.leaseMs,runId:this.runId});
      if(!task) {
        // Another host may occupy the Space while this host owns an eligible queued job.
        // Poll only while a live claim can eventually free that capacity.
        const tasks=await this.options.service.executionTasks(this.options.spaceId);
        const keys=new Set(this.options.executorKeys());
        if(tasks.some(item=>item.status==='queued'&&keys.has(item.executorKey)&&(!this.runId||item.runId===this.runId))&&
          tasks.some(item=>item.status==='running'||item.status==='cancel_requested')) this.scheduleRetry();
        return;
      }
      const abort=new AbortController();
      if(this.stopped) abort.abort(new Error('Execution manager stopped before dispatch'));
      const promise=this.run(task,abort).finally(()=>{
        this.jobs.delete(task.runId);
        if(!this.stopped) void this.wake().catch(()=>{});
      });
      this.jobs.set(task.runId,{abort,promise});
    }
  }
  private scheduleRetry():void {
    if(this.stopped||this.retryTimer) return;
    this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;void this.wake().catch(()=>{});},this.pollMs);
  }
  private async run(task:ExecutionTask,abort:AbortController):Promise<void> {
    const token=task.claimToken!;
    let ticking=false;
    const tick=async()=>{
      if(ticking) return;
      ticking=true;
      try {
        const state=await this.options.service.getExecutionTask(this.options.spaceId,task.runId);
        if(state?.status==='cancel_requested') abort.abort(new Error('Execution canceled'));
        if(state?.status==='interrupted') abort.abort(new Error('Execution lease expired'));
        if(!abort.signal.aborted&&state?.status==='running') await this.options.service.heartbeatExecution(this.options.spaceId,task.runId,token,this.leaseMs);
      } catch(error) { abort.abort(error); }
      finally { ticking=false; }
    };
    const interval=setInterval(()=>{void tick();},Math.min(this.pollMs,Math.max(100,Math.floor(this.leaseMs/3))));
    interval.unref?.();
    let outcome:{run:RunRecord}|undefined,error:unknown;
    try {
      await tick();
      if(abort.signal.aborted) throw abort.signal.reason;
      outcome=await this.options.execute(task,abort.signal);
    }
    catch(caught) { error=caught; }
    finally { clearInterval(interval); }
    try {
      if(outcome&&outcome.run.id!==task.runId) throw new Error('Executor returned a different native run');
      const actual=await (await this.options.service.runtimeEvidence(this.options.spaceId)).getRun(task.runId);
      if(!error&&(!actual||['queued','running'].includes(actual.state))) error=new Error('Executor returned before native run completed');
      const canceled=actual?.state==='canceled'||(!!error&&abort.signal.aborted&&['queued','running','waiting'].includes(actual?.state??''));
      const failed=actual?.state==='failed'||(!!error&&['queued','running','waiting'].includes(actual?.state??''));
      await this.options.service.finishExecution(this.options.spaceId,task.runId,token,{
        status:canceled?'canceled':failed?'failed':'completed',
        ...(error?{error:error instanceof Error?error.message:String(error)}:{}),
      });
    } catch {
      // The task remains nonterminal for lease reconciliation if storage is unavailable.
    }
  }
  async cancel(runId:string):Promise<ExecutionTask> {
    this.assertTarget(runId);
    const task=await this.options.service.cancelExecution(this.options.spaceId,runId);
    if(task.status==='cancel_requested') this.jobs.get(runId)?.abort.abort(new Error('Execution canceled'));
    return task;
  }
  async completion(runId:string):Promise<{run:RunRecord}> {
    this.assertTarget(runId);
    let observedNonterminal=false;
    let observedOwned=false;
    for(;;) {
      if(this.stopped&&observedNonterminal&&!observedOwned&&!this.jobs.has(runId)) throw new Error(`Execution manager stopped; task remains queued or unfinished: ${runId}`);
      const task=await this.options.service.getExecutionTask(this.options.spaceId,runId);
      if(!task) throw new Error(`Execution task not found: ${runId}`);
      if(['failed','canceled','interrupted'].includes(task.status)) throw new Error(task.error??`Execution ${task.status}: ${runId}`);
      if(task.status==='completed') {
        const run=await (await this.options.service.runtimeEvidence(this.options.spaceId)).getRun(runId);
        if(!run) throw new Error(`Native run missing: ${runId}`);
        return {run};
      }
      observedNonterminal=true;
      if(this.jobs.has(runId)||task.owner===this.workerId) observedOwned=true;
      if(this.stopped) {
        const owned=this.jobs.get(runId);
        if(!owned) throw new Error(`Execution manager stopped; task remains queued or unfinished: ${runId}`);
        await owned.promise;
        observedNonterminal=false;
        continue;
      }
      await new Promise<void>(resolve=>{
        const signal=this.stopSignal.signal;
        const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
        const timer=setTimeout(done,this.pollMs);
        signal.addEventListener('abort',done,{once:true});
        if(signal.aborted) done();
      });
    }
  }
  async waitIdle():Promise<void> {
    for(;;) {
      await this.pumping;
      const jobs=[...this.jobs.values()].map(job=>job.promise);
      if(!jobs.length&&!this.retryTimer) return;
      if(!jobs.length&&this.retryTimer) { await new Promise(resolve=>setTimeout(resolve,this.pollMs)); continue; }
      await Promise.allSettled(jobs);
    }
  }
  async stop():Promise<void> {
    this.stopped=true;
    this.stopSignal.abort();
    if(this.retryTimer) { clearTimeout(this.retryTimer);this.retryTimer=undefined; }
    for(const job of this.jobs.values()) job.abort.abort(new Error('Execution manager stopped'));
    await this.waitIdle();
  }
  private assertTarget(runId:string):void {
    if(this.runId&&runId!==this.runId) throw new Error(`Execution manager targets a different run: ${this.runId}`);
  }
}
