import type { WorkflowSpaceService } from './service.js';
import type { Adoption, AdoptionDraft, AssetVersion, InputManifest, IterationDraft, Review, SpaceOverview,
  ValidationComparison, ValidationIssueDraft, ValidationPlan, ValidationPlanDraft, ValidationSummary } from './types.js';

export interface ValidationStartRequest {
  spaceId:string;caseId:string;workflowVersionId:string;entrypoint:string;inputManifestId:string;
  idempotencyKey:string;dispatch:false;
}
export interface ValidationWorkbenchOptions {
  service:WorkflowSpaceService;spaceId:string;
  /** Supplied by the authenticated host, never a browser form or model argument. */
  humanJudgeId:string;
  startRun:(request:ValidationStartRequest)=>Promise<{runId:string}>;
  dispatch:()=>Promise<unknown>;
  availability:(versionId:string,entrypoint:string)=>Promise<{available:boolean;reason?:string}>;
  isDeliverable:(asset:AssetVersion)=>boolean;
  assertReviewable?:(runId:string,assetVersionIds:string[])=>Promise<void>;
}
export interface ValidationReviewInput {
  id:string;entryId:string;runId:string;assetVersionIds:string[];answers:Review['answers'];baselineReviewId?:string;
}
export type ValidationComparisonInput=Omit<ValidationComparison,'comparison'>;
export interface ValidationWorkbench {
  create(draft:ValidationPlanDraft):Promise<ValidationPlan>;
  freeze(planId:string):Promise<ValidationPlan>;
  list():Promise<{plans:ValidationPlan[];data:SpaceOverview;manifests:InputManifest[];humanJudgeId:string}>;
  detail(planId:string):Promise<ValidationSummary & {data:SpaceOverview;humanJudgeId:string;deliverableAssetVersionIds:string[];currentAdoptions:Adoption[]}>;
  start(planId:string,entryId:string,attempt?:number):Promise<{runId:string}>;
  dispatch():Promise<unknown>;
  review(planId:string,input:ValidationReviewInput):Promise<Review>;
  linkRun(planId:string,input:{entryId:string;runId:string;attempt?:number}):Promise<unknown>;
  linkReview(planId:string,input:{entryId:string;runId:string;reviewId:string}):Promise<unknown>;
  compare(planId:string,input:ValidationComparisonInput):Promise<unknown>;
  issue(planId:string,input:ValidationIssueDraft):Promise<unknown>;
  exclude(planId:string,input:{entryId:string;rule:string;reason:string}):Promise<void>;
  iteration(planId:string,input:IterationDraft):Promise<IterationDraft>;
  adopt(planId:string,input:Omit<AdoptionDraft,'validationPlanId'>):Promise<unknown>;
}

/** Orchestrates explicit operator actions; execution is delegated to the existing task queue. */
export function createValidationWorkbench(options:ValidationWorkbenchOptions):ValidationWorkbench {
  const {service,spaceId}=options;
  if(!options.humanJudgeId.trim())throw new Error('Authenticated validation judge is required');
  const frozen=async(planId:string)=>{
    const summary=await service.validationSummary(spaceId,planId);
    if(summary.plan.status!=='frozen')throw new Error('Freeze the validation plan before executing or judging it');
    return summary;
  };
  return {
    create:draft=>service.createValidationPlan(spaceId,draft),
    freeze:planId=>service.freezeValidationPlan(spaceId,planId),
    async list(){
      const [plans,data,manifests]=await Promise.all([service.validationPlans(spaceId),service.overview(spaceId),service.inputManifests(spaceId)]);
      return {plans,data,manifests,humanJudgeId:options.humanJudgeId};
    },
    async detail(planId){
      const [summary,data,currentAdoptions]=await Promise.all([service.validationSummary(spaceId,planId),service.overview(spaceId),service.adoptionHeads(spaceId)]);
      return {...summary,data,currentAdoptions,humanJudgeId:options.humanJudgeId,deliverableAssetVersionIds:data.assets.filter(options.isDeliverable).map(asset=>asset.id)};
    },
    async start(planId,entryId,attempt=1){
      if(!Number.isSafeInteger(attempt)||attempt<1)throw new Error('Attempt must be a positive integer');
      const summary=await frozen(planId),item=summary.entries.find(value=>value.entry.id===entryId);
      if(!item)throw new Error('Validation entry is not in this plan');
      if(item.entry.excludedReason)throw new Error('Excluded validation entry cannot be dispatched');
      const existing=item.attempts.find(value=>value.attempt===attempt);
      if(existing)return {runId:existing.runId};
      if(attempt!==item.attempts.length+1)throw new Error('Retries must preserve all previous attempts in order');
      if(item.attempts.some(value=>['queued','running','cancel_requested','interrupted'].includes(value.status)))
        throw new Error('An earlier attempt is still active or requires reconciliation');
      const available=await options.availability(item.entry.workflowVersionId,item.entry.entrypoint);
      if(!available.available)throw new Error(available.reason??'The exact executor is unavailable');
      const handle=await options.startRun({spaceId,caseId:item.entry.caseId,workflowVersionId:item.entry.workflowVersionId,
        entrypoint:item.entry.entrypoint,inputManifestId:item.entry.inputManifestId,
        idempotencyKey:`validation:${planId}:${entryId}:attempt:${attempt}`,dispatch:false});
      await service.linkValidationRun(spaceId,planId,{entryId,runId:handle.runId,attempt});
      return {runId:handle.runId};
    },
    dispatch:options.dispatch,
    async review(planId,input){
      // Labels and criteria cannot be supplied by an untrusted caller to impersonate a judge.
      if('judge' in input||'standard' in input||'accept' in input)throw new Error('Validation review identity and standard are fixed by the trusted host and plan');
      const summary=await frozen(planId),item=summary.entries.find(value=>value.entry.id===input.entryId);
      if(!item?.attempts.some(attempt=>attempt.runId===input.runId))throw new Error('Review run is not associated with this plan entry');
      if(!summary.plan.judges.some(judge=>judge.kind==='human'&&judge.id===options.humanJudgeId))throw new Error('Authenticated human judge is not permitted by this plan');
      const data=await service.overview(spaceId);
      if(!input.assetVersionIds.length||input.assetVersionIds.some(id=>{
        const asset=data.assets.find(value=>value.id===id);
        return !asset||!options.isDeliverable(asset)||asset.source.kind!=='node'||asset.source.runId!==input.runId;
      }))throw new Error('Review requires exact deliverables of the associated run');
      await options.assertReviewable?.(input.runId,input.assetVersionIds);
      const review=await service.recordReview(spaceId,{id:input.id,runId:input.runId,assetVersionIds:input.assetVersionIds,
        ...(input.baselineReviewId?{baselineReviewId:input.baselineReviewId}:{}),standard:summary.plan.standard,
        judge:{kind:'human',id:options.humanJudgeId},evidence:input.assetVersionIds,answers:input.answers});
      await service.linkValidationReview(spaceId,planId,{entryId:input.entryId,runId:input.runId,reviewId:review.id});
      return review;
    },
    linkRun:(planId,input)=>service.linkValidationRun(spaceId,planId,input),
    linkReview:(planId,input)=>service.linkValidationReview(spaceId,planId,input),
    compare:(planId,input)=>service.compareValidationEntries(spaceId,planId,input),
    issue:(planId,input)=>service.recordValidationIssue(spaceId,planId,input),
    exclude:(planId,input)=>service.excludeValidationEntry(spaceId,planId,input),
    async iteration(planId,input){
      const summary=await frozen(planId);
      if(!input.runIds.length||input.runIds.some(id=>!summary.entries.some(entry=>entry.attempts.some(attempt=>attempt.runId===id))))throw new Error('Iteration requires this plan\'s exact run evidence');
      if(input.reviewIds.some(id=>!summary.entries.some(entry=>entry.attempts.some(attempt=>attempt.reviews.some(review=>review.id===id)))))throw new Error('Iteration review evidence is not linked to this plan');
      return service.recordIteration(spaceId,input);
    },
    adopt:(planId,input)=>service.adopt(spaceId,{...input,validationPlanId:planId}),
  };
}
