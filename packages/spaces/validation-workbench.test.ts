import { describe, expect, it, vi } from 'vitest';
import type { WorkflowSpaceService } from './service.js';
import { createValidationWorkbench } from './validation-workbench.js';
import type { ValidationSummary } from './types.js';

function fixture(){
  const summary={plan:{id:'plan',status:'frozen',judges:[{kind:'human',id:'owner'}]},entries:[{
    entry:{id:'entry',caseId:'case',workflowVersionId:'v2',entrypoint:'main',inputManifestId:'frozen-input'},attempts:[],status:'missing',
  }]} as unknown as ValidationSummary;
  const service={validationSummary:vi.fn(async()=>summary),linkValidationRun:vi.fn(async()=>{}),recordReview:vi.fn()};
  const startRun=vi.fn(async()=>({runId:'run'})),dispatch=vi.fn(async()=>{}),availability=vi.fn(async()=>({available:true}));
  const workbench=createValidationWorkbench({service:service as unknown as WorkflowSpaceService,spaceId:'space',humanJudgeId:'owner',
    startRun,dispatch,availability,isDeliverable:()=>true});
  return {summary,service,startRun,dispatch,availability,workbench};
}
describe('explicit validation operator actions',()=>{
  it('queues the exact manifest and stable attempt command without dispatching',async()=>{
    const f=fixture();
    await expect(f.workbench.start('plan','entry')).resolves.toEqual({runId:'run'});
    expect(f.startRun).toHaveBeenCalledWith({spaceId:'space',caseId:'case',workflowVersionId:'v2',entrypoint:'main',
      inputManifestId:'frozen-input',idempotencyKey:'validation:plan:entry:attempt:1',dispatch:false});
    expect(f.service.linkValidationRun).toHaveBeenCalledWith('space','plan',{entryId:'entry',runId:'run',attempt:1});
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('returns an existing attempt without calling another executor or losing its failure',async()=>{
    const f=fixture();f.summary.entries[0]!.attempts.push({attempt:1,runId:'old',status:'failed',reviews:[]});
    await expect(f.workbench.start('plan','entry',1)).resolves.toEqual({runId:'old'});
    expect(f.startRun).not.toHaveBeenCalled();
    await f.workbench.start('plan','entry',2);
    expect(f.summary.entries[0]!.attempts[0]!.status).toBe('failed');
    expect(f.startRun.mock.calls[0]?.[0]).toMatchObject({idempotencyKey:'validation:plan:entry:attempt:2'});
  });
  it('rejects unavailable executors, missing freeze, sparse retries and unresolved interruption',async()=>{
    const f=fixture();f.availability.mockResolvedValue({available:false});
    await expect(f.workbench.start('plan','entry')).rejects.toThrow('unavailable');
    f.summary.plan.status='draft';
    await expect(f.workbench.start('plan','entry')).rejects.toThrow('Freeze');
    f.summary.plan.status='frozen';
    await expect(f.workbench.start('plan','entry',3)).rejects.toThrow('order');
    f.summary.entries[0]!.attempts.push({attempt:1,runId:'unknown',status:'interrupted',reviews:[]});
    await expect(f.workbench.start('plan','entry',2)).rejects.toThrow('reconciliation');
    expect(f.startRun).not.toHaveBeenCalled();
  });
  it('rejects forged judge or substituted criteria before writing a review',async()=>{
    const f=fixture(),input={id:'review',entryId:'entry',runId:'run',assetVersionIds:['asset'],
      answers:{good:'good',bad:'bad',improvement:'better',unresolved:'unknown'}};
    await expect(f.workbench.review('plan',{...input,judge:{kind:'agent',id:'A'}} as typeof input)).rejects.toThrow('identity');
    await expect(f.workbench.review('plan',{...input,standard:{id:'other'}} as typeof input)).rejects.toThrow('standard');
    expect(f.service.recordReview).not.toHaveBeenCalled();
  });
});
