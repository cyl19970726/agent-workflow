import {JSON_SCHEMA_DIALECT,SchemaRegistry,type SchemaDefinition,type SchemaRef} from '@signal-room/workflow-space-contracts';
import {artifactPayloadSha256} from '@signal-room/workflow';
import type {WorkflowSpaceService} from './service.js';
import {createRunDispositionStore} from './run-disposition.js';
import type {AssetVersion,SavedResponseTarget} from './types.js';

export const RUN_DIAGNOSIS_SCHEMA_NAMESPACE='workflow/run-diagnosis';
export const runDiagnosisAssetId=(runId:string):string=>`run-diagnosis:${runId}`;

export type RunDiagnosisRoute='revise-work'|'supplement-input'|'calibrate-judge'|'change-method'|'dogfood-issue'|'design-method'|'defer'|'no-change';
export type RunDiagnosisCategory='input'|'responsibility'|'handoff'|'generation'|'validation-recovery'|'judge'|'harness'|'design-method'|'other';
export type RunDiagnosisEvidenceRef=
  | {kind:'asset';assetVersionId:string;payloadHash:string;pointer?:string}
  | {kind:'response';target:SavedResponseTarget;pointer?:string}
  | {kind:'review';reviewId:string;pointer?:string}
  | {kind:'disposition';revisionId:string;payloadHash:string;pointer?:string}
  | {kind:'inputs';manifestId:string;payloadHash:string;pointer?:string}
  | {kind:'trace';sessionId:string;eventId?:string;eventSeq?:number;pointer?:string}
  | {kind:'run';runId:string;stepRunId?:string};
export interface RunDiagnosisHypothesis {
  id:string;category:RunDiagnosisCategory;explanation:string;
  supportRefs:RunDiagnosisEvidenceRef[];counterRefs:RunDiagnosisEvidenceRef[];
  unknowns:string[];discriminatingCheck:string;
}
export interface RunDiagnosisIssue {
  id:string;title:string;expected:string;observed:string;evidenceRefs:RunDiagnosisEvidenceRef[];
  hypotheses:RunDiagnosisHypothesis[];unknowns:string[];
  decision:{route:RunDiagnosisRoute;reason:string;nextCheck?:string;externalIssueRef?:string;designSessionRef?:string};
}
export interface RunDiagnosisCandidateDraft {
  predecessorVersionId:string;issueIds:string[];hypothesisIds:string[];
  changes:{target:string;before:string;after:string;reason:string}[];
  expectedBenefits:string[];risks:string[];validationPlan:string;
  falsificationConditions:string[];conditions:string[];
}
export interface RunDiagnosisSave {
  runId:string;reviewIds:string[];dispositionRevisionId:string;dispositionPayloadHash:string;
  issues:RunDiagnosisIssue[];candidateDraft?:RunDiagnosisCandidateDraft;
  expectedRevisionId:string|null;idempotencyKey:string;observationReceiptId?:string;
}
export interface RunDiagnosisRevision extends Omit<RunDiagnosisSave,'expectedRevisionId'|'idempotencyKey'> {
  id:string;assetId:string;revision:number;payloadHash:string;createdAt:string;
  workflowVersionId:string;previousRevisionId:string|null;
  author:{id:string;kind:'human'}|{id:string;kind:'agent';sessionId:string;servicePrincipalId:string};
  recordedBy:string;confirmation:'unconfirmed';
  candidateStatus?:'unregistered-unvalidated-unadopted';
}

const id={type:'string',minLength:1,maxLength:256};
const text={type:'string',minLength:1,maxLength:20000};
const shortText={type:'string',minLength:1,maxLength:2000};
const texts={type:'array',maxItems:100,items:shortText};
const pointer={type:'string',maxLength:2000};
const responseTarget={type:'object',properties:{runId:id,occurrenceId:id,stepRunId:id,attemptId:id,
  sessionId:id,eventId:id,eventSeq:{type:'integer',minimum:1},outputHash:id},
  required:['runId','occurrenceId','stepRunId','attemptId','sessionId','eventId','eventSeq','outputHash'],additionalProperties:false};
const evidenceRef={oneOf:[
  {type:'object',properties:{kind:{const:'asset'},assetVersionId:id,payloadHash:id,pointer},required:['kind','assetVersionId','payloadHash'],additionalProperties:false},
  {type:'object',properties:{kind:{const:'response'},target:responseTarget,pointer},required:['kind','target'],additionalProperties:false},
  {type:'object',properties:{kind:{const:'review'},reviewId:id,pointer},required:['kind','reviewId'],additionalProperties:false},
  {type:'object',properties:{kind:{const:'disposition'},revisionId:id,payloadHash:id,pointer},required:['kind','revisionId','payloadHash'],additionalProperties:false},
  {type:'object',properties:{kind:{const:'inputs'},manifestId:id,payloadHash:id,pointer},required:['kind','manifestId','payloadHash'],additionalProperties:false},
  {type:'object',properties:{kind:{const:'trace'},sessionId:id,eventId:id,eventSeq:{type:'integer',minimum:1},pointer},required:['kind','sessionId'],additionalProperties:false},
  {type:'object',properties:{kind:{const:'run'},runId:id,stepRunId:id},required:['kind','runId'],additionalProperties:false},
]};
const refs={type:'array',maxItems:100,items:evidenceRef};
const hypothesis={type:'object',properties:{id,category:{type:'string',enum:['input','responsibility','handoff','generation','validation-recovery','judge','harness','design-method','other']},
  explanation:text,supportRefs:refs,counterRefs:refs,unknowns:texts,discriminatingCheck:shortText},
  required:['id','category','explanation','supportRefs','counterRefs','unknowns','discriminatingCheck'],additionalProperties:false};
const issue={type:'object',properties:{id,title:shortText,expected:text,observed:text,
  evidenceRefs:{...refs,minItems:1},hypotheses:{type:'array',minItems:1,maxItems:20,items:hypothesis},unknowns:texts,
  decision:{type:'object',properties:{route:{type:'string',enum:['revise-work','supplement-input','calibrate-judge','change-method','dogfood-issue','design-method','defer','no-change']},
    reason:text,nextCheck:shortText,externalIssueRef:id,designSessionRef:id},required:['route','reason'],additionalProperties:false}},
  required:['id','title','expected','observed','evidenceRefs','hypotheses','unknowns','decision'],additionalProperties:false};
const candidate={type:'object',properties:{predecessorVersionId:id,
  issueIds:{type:'array',minItems:1,maxItems:50,uniqueItems:true,items:id},
  hypothesisIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:id},
  changes:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{target:shortText,before:text,after:text,reason:text},
    required:['target','before','after','reason'],additionalProperties:false}},
  expectedBenefits:{...texts,minItems:1},risks:{...texts,minItems:1},validationPlan:text,falsificationConditions:{...texts,minItems:1},conditions:texts},
  required:['predecessorVersionId','issueIds','hypothesisIds','changes','expectedBenefits','risks','validationPlan','falsificationConditions','conditions'],additionalProperties:false};
const author={oneOf:[
  {type:'object',properties:{id,kind:{const:'human'}},required:['id','kind'],additionalProperties:false},
  {type:'object',properties:{id,kind:{const:'agent'},sessionId:id,servicePrincipalId:id},required:['id','kind','sessionId','servicePrincipalId'],additionalProperties:false},
]};
const definition:SchemaDefinition={namespace:RUN_DIAGNOSIS_SCHEMA_NAMESPACE,revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{runId:id,workflowVersionId:id,
    reviewIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:id},dispositionRevisionId:id,dispositionPayloadHash:id,
    issues:{type:'array',minItems:1,maxItems:50,items:issue},candidateDraft:candidate,
    observationReceiptId:id,previousRevisionId:{type:['string','null'],maxLength:256},author},
    required:['runId','workflowVersionId','reviewIds','dispositionRevisionId','dispositionPayloadHash','issues','previousRevisionId','author'],
    additionalProperties:false} as unknown as SchemaDefinition['schema']};
const frozen=new SchemaRegistry().registerSchema(definition);
export const RUN_DIAGNOSIS_SCHEMA_REF:SchemaRef={namespace:frozen.namespace,revision:frozen.revision,hash:frozen.hash};

const validText=(value:unknown,name:string,max=20000):void=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${name} must be nonempty and at most ${max} characters`);
};
const pointerExists=(root:unknown,value:string):boolean=>{
  if(value==='')return true;
  if(!value.startsWith('/')||/~(?![01])/.test(value))return false;
  let current:unknown=root;
  for(const part of value.slice(1).split('/')) {
    const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
    if(!current||typeof current!=='object'||!Object.hasOwn(current,key))return false;
    current=(current as Record<string,unknown>)[key];
  }
  return true;
};

export function runDiagnosisRevision(version:AssetVersion):RunDiagnosisRevision {
  if(version.schema.namespace!==RUN_DIAGNOSIS_SCHEMA_REF.namespace||version.schema.revision!==RUN_DIAGNOSIS_SCHEMA_REF.revision||
    version.schema.hash!==RUN_DIAGNOSIS_SCHEMA_REF.hash||version.source.kind!=='import')
    throw new Error('Asset is not a run diagnosis revision');
  const payload=version.payload as Omit<RunDiagnosisRevision,'id'|'assetId'|'revision'|'payloadHash'|'createdAt'|'recordedBy'|'confirmation'|'candidateStatus'>;
  if(version.assetId!==runDiagnosisAssetId(payload.runId))throw new Error('Run diagnosis logical asset mismatch');
  if(!payload.author||(payload.author.kind==='human'?payload.author.id!==version.source.actorId||!!payload.observationReceiptId:
    payload.author.kind==='agent'?payload.author.servicePrincipalId!==version.source.actorId||!payload.observationReceiptId:true))
    throw new Error('Run diagnosis authenticated author mismatch');
  return {id:version.id,assetId:version.assetId,revision:version.version,payloadHash:version.payloadHash,createdAt:version.createdAt,
    ...payload,recordedBy:version.source.actorId,confirmation:'unconfirmed',
    ...(payload.candidateDraft?{candidateStatus:'unregistered-unvalidated-unadopted' as const}:{})};
}

/** Revisioned causal assessment; saving never starts a run, registers a method, or adopts a result. */
export function createRunDiagnosisStore(service:WorkflowSpaceService) {
  const dispositions=createRunDispositionStore(service);
  return {
    /** Owner-only explicit setup. Ordinary reads and saves never register schemas. */
    async ensure(spaceId:string):Promise<SchemaRef> {
      const [registered]=await service.registerSchemas(spaceId,[definition]);
      if(!registered||registered.hash!==RUN_DIAGNOSIS_SCHEMA_REF.hash)throw new Error('Run diagnosis schema registration failed');
      return RUN_DIAGNOSIS_SCHEMA_REF;
    },
    async current(spaceId:string,runId:string):Promise<RunDiagnosisRevision|null> {
      const run=await service.readRun(spaceId,runId);
      const head=await service.readAssetHead(spaceId,runDiagnosisAssetId(runId));
      if(!head)return null;
      const revision=runDiagnosisRevision(head);
      if(revision.workflowVersionId!==run.workflowVersionId)throw new Error('Run diagnosis workflow version mismatch');
      return revision;
    },
    async read(spaceId:string,revisionId:string):Promise<RunDiagnosisRevision> {
      const revision=runDiagnosisRevision(await service.readAsset(spaceId,revisionId));
      if(revision.workflowVersionId!==(await service.readRun(spaceId,revision.runId)).workflowVersionId)
        throw new Error('Run diagnosis workflow version mismatch');
      return revision;
    },
    async list(spaceId:string,runId:string):Promise<RunDiagnosisRevision[]> {
      const run=await service.readRun(spaceId,runId);
      const revisions=(await service.readAssetHistory(spaceId,runDiagnosisAssetId(runId))).map(runDiagnosisRevision);
      if(revisions.some(revision=>revision.workflowVersionId!==run.workflowVersionId))
        throw new Error('Run diagnosis workflow version mismatch');
      return revisions;
    },
    async save(spaceId:string,input:RunDiagnosisSave):Promise<RunDiagnosisRevision> {
      validText(input.runId,'Run ID',256);
      validText(input.idempotencyKey,'Idempotency key',256);
      validText(input.dispositionRevisionId,'Disposition revision ID',256);
      validText(input.dispositionPayloadHash,'Disposition payload hash',256);
      if(input.expectedRevisionId===undefined||(input.expectedRevisionId!==null&&
        (typeof input.expectedRevisionId!=='string'||!input.expectedRevisionId.trim())))
        throw new Error('Expected diagnosis revision ID is required; use null for the first revision');
      if(input.expectedRevisionId!==null)validText(input.expectedRevisionId,'Expected diagnosis revision ID',256);
      if(!Array.isArray(input.reviewIds)||!input.reviewIds.length||new Set(input.reviewIds).size!==input.reviewIds.length)
        throw new Error('Run diagnosis requires distinct selected reviews');
      if(!Array.isArray(input.issues)||!input.issues.length)throw new Error('Run diagnosis requires at least one issue');
      if(Buffer.byteLength(JSON.stringify(input),'utf8')>256_000)throw new Error('Run diagnosis exceeds the size limit');
      const run=await service.readRun(spaceId,input.runId);
      const disposition=await dispositions.read(spaceId,input.dispositionRevisionId);
      if(disposition.runId!==run.runId||disposition.payloadHash!==input.dispositionPayloadHash)
        throw new Error('Run diagnosis disposition run or hash mismatch');
      if(input.reviewIds.some(id=>!disposition.reviewIds.includes(id)))
        throw new Error('Run diagnosis selected reviews must occur in the exact disposition revision');
      const author=input.observationReceiptId?
        {kind:'agent' as const,...await service.authenticatedExternalAgentWriter(spaceId,input.observationReceiptId,input.runId)}:
        await service.authenticatedHumanWriter(spaceId);
      const receiptIds=new Set<string>();
      const reviews=new Map<string,Awaited<ReturnType<typeof service.readReview>>>();
      for(const id of input.reviewIds) {
        validText(id,'Review ID',256);
        const review=await service.readReview(spaceId,id);
        if(review.runId!==run.runId)throw new Error('Run diagnosis review is outside the run');
        reviews.set(id,review);
        if(author.kind==='agent') {
          if(review.judge.kind!=='agent'||review.judge.id!==author.id||review.judge.sessionId!==author.sessionId||
            !review.observationReceiptId)throw new Error('Agent diagnosis requires every selected review to be its own observed review');
          await service.authenticatedExternalAgentWriter(spaceId,review.observationReceiptId,run.runId);
          const receipt=await service.readExternalAgentObservation(spaceId,review.observationReceiptId);
          if(receipt.delivery==='saved-response-read') {
            if(!review.responseTarget||review.assetVersionIds.length||
              await artifactPayloadSha256(review.responseTarget)!==await artifactPayloadSha256(receipt.target))
              throw new Error('Agent diagnosis review observation target mismatch');
          } else if(review.responseTarget||review.assetVersionIds.length!==1||
            review.assetVersionIds[0]!==receipt.target.assetVersionId)
            throw new Error('Agent diagnosis review observation target mismatch');
          receiptIds.add(review.observationReceiptId);
        }
      }
      if(author.kind==='agent'&&!receiptIds.has(input.observationReceiptId!))
        throw new Error('Agent diagnosis primary observation receipt must belong to a selected review');
      const manifest=await service.readManifest(spaceId,run.inputManifestId);
      const manifestAssets=new Set(Object.values(manifest.assets));
      const evidenceAssetIds=new Set<string>();
      const validateRef=async(ref:RunDiagnosisEvidenceRef):Promise<void>=>{
        let body:unknown;
        if(ref.kind==='asset') {
          const asset=await service.readAsset(spaceId,ref.assetVersionId);
          if(asset.payloadHash!==ref.payloadHash)throw new Error('Diagnosis asset evidence hash mismatch');
          if(!((asset.source.kind==='node'||asset.source.kind==='historical-artifact')&&asset.source.runId===run.runId)&&!manifestAssets.has(asset.id))
            throw new Error('Diagnosis asset evidence is outside the run');
          evidenceAssetIds.add(asset.id);body=asset.payload;
        } else if(ref.kind==='response') {
          if(ref.target.runId!==run.runId)throw new Error('Diagnosis response evidence is outside the run');
          body=(await service.readSavedResponseTarget(spaceId,ref.target)).output;
        } else if(ref.kind==='review') {
          if(!reviews.has(ref.reviewId))throw new Error('Diagnosis review evidence is not a selected review');
          body=reviews.get(ref.reviewId);
        } else if(ref.kind==='disposition') {
          const revision=await dispositions.read(spaceId,ref.revisionId);
          if(revision.runId!==run.runId||revision.payloadHash!==ref.payloadHash)
            throw new Error('Diagnosis disposition evidence run or hash mismatch');
          evidenceAssetIds.add(revision.id);body=revision;
        } else if(ref.kind==='inputs') {
          if(ref.manifestId!==run.inputManifestId||ref.payloadHash!==manifest.hash)
            throw new Error('Diagnosis input manifest run or hash mismatch');
          for(const id of manifestAssets)evidenceAssetIds.add(id);
          body=manifest;
        } else if(ref.kind==='trace') {
          const found=await service.readRunTraceReference(spaceId,run.runId,ref.sessionId,ref.eventId,ref.eventSeq);
          if(ref.pointer!==undefined&&!found.event)throw new Error('Diagnosis trace pointer requires an exact event');
          body=found.event?.body;
        } else if(ref.kind==='run') {
          if(ref.runId!==run.runId)throw new Error('Diagnosis run evidence is outside the run');
          if(ref.stepRunId) {
            const steps=await (await service.runtimeEvidence(spaceId)).listSteps(run.runId);
            if(!steps.some(step=>step.id===ref.stepRunId))throw new Error('Diagnosis run step evidence does not exist');
          }
        } else throw new Error('Unknown diagnosis evidence kind');
        if('pointer' in ref&&ref.pointer!==undefined&&!pointerExists(body,ref.pointer))
          throw new Error('Diagnosis evidence pointer does not exist');
      };
      const issueIds=new Set<string>(),hypothesisIds=new Set<string>();
      for(const issue of input.issues) {
        validText(issue.id,'Issue ID',256);
        for(const field of ['title','expected','observed'] as const)validText(issue[field],`Issue ${field}`);
        validText(issue.decision?.reason,'Issue decision reason');
        if(issue.decision.nextCheck!==undefined)validText(issue.decision.nextCheck,'Issue next check',2000);
        if(issue.decision.externalIssueRef!==undefined)validText(issue.decision.externalIssueRef,'External issue reference',256);
        if(issue.decision.designSessionRef!==undefined)validText(issue.decision.designSessionRef,'Design session reference',256);
        if(!Array.isArray(issue.unknowns)||issue.unknowns.some(value=>typeof value!=='string'||!value.trim()))
          throw new Error('Diagnosis issue unknowns must contain nonblank text');
        if(issueIds.has(issue.id))throw new Error('Diagnosis issue IDs must be distinct');
        issueIds.add(issue.id);
        if(!issue.evidenceRefs?.length||!issue.hypotheses?.length)
          throw new Error('Diagnosis issue needs evidence and at least one competing explanation');
        for(const ref of issue.evidenceRefs)await validateRef(ref);
        for(const hypothesis of issue.hypotheses) {
          validText(hypothesis.id,'Hypothesis ID',256);
          validText(hypothesis.explanation,'Hypothesis explanation');
          validText(hypothesis.discriminatingCheck,'Hypothesis discriminating check',2000);
          if(!Array.isArray(hypothesis.unknowns)||hypothesis.unknowns.some(value=>typeof value!=='string'||!value.trim()))
            throw new Error('Diagnosis hypothesis unknowns must contain nonblank text');
          if(!Array.isArray(hypothesis.supportRefs)||!Array.isArray(hypothesis.counterRefs))
            throw new Error('Diagnosis hypothesis evidence must be arrays');
          if(hypothesisIds.has(hypothesis.id))throw new Error('Diagnosis hypothesis IDs must be distinct');
          hypothesisIds.add(hypothesis.id);
          for(const ref of [...hypothesis.supportRefs,...hypothesis.counterRefs])await validateRef(ref);
        }
      }
      if(input.candidateDraft) {
        const draft=input.candidateDraft;
        if(draft.predecessorVersionId!==run.workflowVersionId)throw new Error('Diagnosis candidate predecessor must be the exact run workflow version');
        if(!draft.issueIds?.length||draft.issueIds.some(id=>!issueIds.has(id)||
          input.issues.find(issue=>issue.id===id)?.decision.route!=='change-method'))
          throw new Error('Diagnosis candidate must cite a change-method issue');
        const citedHypotheses=new Set(input.issues.filter(issue=>draft.issueIds.includes(issue.id))
          .flatMap(issue=>issue.hypotheses.map(hypothesis=>hypothesis.id)));
        if(!draft.hypothesisIds?.length||draft.hypothesisIds.some(id=>!citedHypotheses.has(id)))
          throw new Error('Diagnosis candidate must cite hypotheses from its change-method issues');
        const selectedHypotheses=input.issues.flatMap(issue=>issue.hypotheses).filter(hypothesis=>draft.hypothesisIds.includes(hypothesis.id));
        if(selectedHypotheses.some(hypothesis=>!hypothesis.supportRefs.length))
          throw new Error('Diagnosis candidate hypothesis needs at least one supporting evidence reference');
        if(!draft.changes?.length||!draft.expectedBenefits?.length||!draft.risks?.length||
          !draft.validationPlan?.trim()||!draft.falsificationConditions?.length)
          throw new Error('Diagnosis candidate needs changes, benefits, risks and falsification conditions');
        for(const change of draft.changes) {
          for(const field of ['target','before','after','reason'] as const)validText(change[field],`Candidate change ${field}`);
          if(change.before.trim()===change.after.trim())throw new Error('Diagnosis candidate change before and after must differ');
        }
        for(const [name,values] of [['expected benefits',draft.expectedBenefits],['risks',draft.risks],
          ['falsification conditions',draft.falsificationConditions],['conditions',draft.conditions]] as const)
          if(!Array.isArray(values)||values.some(value=>typeof value!=='string'||!value.trim()))
            throw new Error(`Diagnosis candidate ${name} must contain nonblank text`);
      }
      const {expectedRevisionId,idempotencyKey,candidateDraft,...supplied}=input;
      const version=await service.importAsset(spaceId,{assetId:runDiagnosisAssetId(run.runId),
        ...(expectedRevisionId?{expectedHead:expectedRevisionId}:{}),schema:RUN_DIAGNOSIS_SCHEMA_REF,
        payload:{...supplied,...(candidateDraft?{candidateDraft}:{}),workflowVersionId:run.workflowVersionId,
          previousRevisionId:expectedRevisionId,author},
        dependencies:[...(expectedRevisionId?[expectedRevisionId]:[]),disposition.id,...receiptIds,...evidenceAssetIds],
        description:'Run diagnosis revision',idempotencyKey:`run-diagnosis:${run.runId}:${idempotencyKey}`});
      return runDiagnosisRevision(version);
    },
  };
}
