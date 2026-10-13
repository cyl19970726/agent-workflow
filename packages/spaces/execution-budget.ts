import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {JSON_SCHEMA_DIALECT,SchemaRegistry,type SchemaDefinition,type SchemaRef} from '@signal-room/workflow-space-contracts';
import type {WorkflowSpaceService} from './service.js';
import type {AssetVersion} from './types.js';

export const EXECUTION_BUDGET_SCHEMA_NAMESPACE='workflow/execution-budget';
export const executionBudgetAssetId=(id:string):string=>`execution-budget:${id}`;
export interface ExecutionBudgetLimits {
  maxCalls:number;maxDurationMs:number;maxNodeDurationMs:number;maxTrialCalls:number;maxTechnicalRepairsPerOccurrence:number;
  /** Frozen at creation. Omission preserves the technical-repair-only trial policy. */
  trialSecondKinds?:Array<'tool-continuation'|'technical-repair'>;
}
export const DEFAULT_EXECUTION_BUDGET_LIMITS:ExecutionBudgetLimits={maxCalls:15,maxDurationMs:3_600_000,maxNodeDurationMs:900_000,maxTrialCalls:2,maxTechnicalRepairsPerOccurrence:1};
export interface ExecutionBudgetCreate {id:string;workflowVersionId:string;validationSha256:string;limits:ExecutionBudgetLimits;idempotencyKey:string}
export interface ExecutionBudgetReserve {runId:string;stepRunId:string;attemptId:string;turn:number;stage:'trial'|'case';kind:'original'|'tool-continuation'|'technical-repair'}
export interface ExecutionBudgetReservation extends ExecutionBudgetReserve {callOrdinal:number;reservedAt:string;deadlineAt:string;nodeDeadlineAt:string}
/** A repeated identity is readable for reconciliation, but must not authorize another provider POST. */
export interface ExecutionBudgetReservationReceipt extends ExecutionBudgetReservation {reused:boolean}
export interface ExecutionBudgetRevision {
  id:string;assetId:string;revision:number;payloadHash:string;createdAt:string;recordedBy:string;
  budgetId:string;workflowVersionId:string;validationSha256:string;limits:ExecutionBudgetLimits;creationKey:string;
  startedAt:string|null;reservations:ExecutionBudgetReservation[];
}

const positive={type:'integer',minimum:1};
const identifier={type:'string',minLength:1};
const legacyLimitsSchema={type:'object',properties:{maxCalls:positive,maxDurationMs:positive,maxNodeDurationMs:positive,maxTrialCalls:{type:'integer',minimum:0},maxTechnicalRepairsPerOccurrence:{type:'integer',minimum:0}},
  required:['maxCalls','maxDurationMs','maxNodeDurationMs','maxTrialCalls','maxTechnicalRepairsPerOccurrence'],additionalProperties:false};
const limitsSchema={...legacyLimitsSchema,properties:{...legacyLimitsSchema.properties,
  trialSecondKinds:{type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{type:'string',enum:['tool-continuation','technical-repair']}}}};
const reservationSchema={type:'object',properties:{runId:identifier,stepRunId:identifier,attemptId:identifier,turn:positive,
  stage:{type:'string',enum:['trial','case']},kind:{type:'string',enum:['original','tool-continuation','technical-repair']},
  callOrdinal:positive,reservedAt:identifier,deadlineAt:identifier,nodeDeadlineAt:identifier},
  required:['runId','stepRunId','attemptId','turn','stage','kind','callOrdinal','reservedAt','deadlineAt','nodeDeadlineAt'],additionalProperties:false};
const budgetSchema=(budgetLimitsSchema:typeof legacyLimitsSchema|typeof limitsSchema)=>({$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{budgetId:identifier,workflowVersionId:identifier,
  validationSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},limits:budgetLimitsSchema,creationKey:identifier,startedAt:{type:['string','null']},
  reservations:{type:'array',items:reservationSchema}},
  required:['budgetId','workflowVersionId','validationSha256','limits','creationKey','startedAt','reservations'],additionalProperties:false});
const LEGACY_EXECUTION_BUDGET_SCHEMA_DEFINITION:SchemaDefinition={namespace:EXECUTION_BUDGET_SCHEMA_NAMESPACE,revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:budgetSchema(legacyLimitsSchema)};
export const EXECUTION_BUDGET_SCHEMA_DEFINITION:SchemaDefinition={namespace:EXECUTION_BUDGET_SCHEMA_NAMESPACE,revision:'2',dialect:JSON_SCHEMA_DIALECT,schema:budgetSchema(limitsSchema)};
const legacyRegistered=new SchemaRegistry().registerSchema(LEGACY_EXECUTION_BUDGET_SCHEMA_DEFINITION);
const LEGACY_EXECUTION_BUDGET_SCHEMA_REF:SchemaRef={namespace:legacyRegistered.namespace,revision:legacyRegistered.revision,hash:legacyRegistered.hash};
const registered=new SchemaRegistry().registerSchema(EXECUTION_BUDGET_SCHEMA_DEFINITION);
export const EXECUTION_BUDGET_SCHEMA_REF:SchemaRef={namespace:registered.namespace,revision:registered.revision,hash:registered.hash};

function nonempty(value:unknown,label:string):asserts value is string {
  if(typeof value!=='string'||!value.trim())throw new Error(`${label} must be nonempty`);
}
function validateLimits(limits:ExecutionBudgetLimits):void {
  if(!limits||typeof limits!=='object')throw new Error('Execution budget limits are required');
  for(const key of ['maxCalls','maxDurationMs','maxNodeDurationMs','maxTrialCalls','maxTechnicalRepairsPerOccurrence'] as const){
    const value=limits[key],ceiling=DEFAULT_EXECUTION_BUDGET_LIMITS[key];
    if(!Number.isSafeInteger(value)||value<(key==='maxTrialCalls'||key==='maxTechnicalRepairsPerOccurrence'?0:1)||value>ceiling)
      throw new Error(`Invalid execution budget ${key}`);
  }
  if(limits.maxTrialCalls>limits.maxCalls||limits.maxNodeDurationMs>limits.maxDurationMs)throw new Error('Execution budget limits are inconsistent');
  if(limits.trialSecondKinds!==undefined){
    const allowed=limits.trialSecondKinds;
    if(!Array.isArray(allowed)||!allowed.length||allowed.length>2||new Set(allowed).size!==allowed.length||
      allowed.some(kind=>kind!=='tool-continuation'&&kind!=='technical-repair'))throw new Error('Invalid trial second kinds');
  }
}
function revision(version:AssetVersion,budgetId:string):ExecutionBudgetRevision {
  const knownSchema=[EXECUTION_BUDGET_SCHEMA_REF,LEGACY_EXECUTION_BUDGET_SCHEMA_REF].some(ref=>version.schema.namespace===ref.namespace&&
    version.schema.revision===ref.revision&&version.schema.hash===ref.hash);
  if(version.assetId!==executionBudgetAssetId(budgetId)||!knownSchema||version.source.kind!=='import')
    throw new Error('Asset is not an execution budget revision');
  const payload=version.payload as Omit<ExecutionBudgetRevision,'id'|'assetId'|'revision'|'payloadHash'|'createdAt'|'recordedBy'>;
  if(payload.budgetId!==budgetId)throw new Error('Execution budget identity mismatch');
  return {id:version.id,assetId:version.assetId,revision:version.version,payloadHash:version.payloadHash,createdAt:version.createdAt,
    ...payload,recordedBy:version.source.actorId};
}
function iso(ms:number):string {return new Date(ms).toISOString();}
function deadline(startedAt:string,duration:number):number {
  const start=Date.parse(startedAt);
  if(!Number.isFinite(start))throw new Error('Execution budget clock is invalid');
  return start+duration;
}
function identity(value:ExecutionBudgetReserve):string{return JSON.stringify([value.runId,value.stepRunId,value.attemptId,value.turn]);}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Immutable, aggregate provider-call reservation ledger. It never estimates tokens or money. */
export function createExecutionBudgetStore(service:WorkflowSpaceService,options:{now?:()=>Date}={}) {
  const now=options.now??(()=>new Date());
  return {
    /** Explicit owner setup; no schema registration occurs from reads or construction. */
    async ensure(spaceId:string):Promise<SchemaRef> {
      const [legacy,frozen]=await service.registerSchemas(spaceId,[LEGACY_EXECUTION_BUDGET_SCHEMA_DEFINITION,EXECUTION_BUDGET_SCHEMA_DEFINITION]);
      if(!legacy||legacy.hash!==LEGACY_EXECUTION_BUDGET_SCHEMA_REF.hash||!frozen||frozen.hash!==EXECUTION_BUDGET_SCHEMA_REF.hash)
        throw new Error('Execution budget schema registration failed');
      return EXECUTION_BUDGET_SCHEMA_REF;
    },
    async create(spaceId:string,input:ExecutionBudgetCreate):Promise<ExecutionBudgetRevision> {
      nonempty(input.id,'Execution budget ID');nonempty(input.workflowVersionId,'Workflow version ID');nonempty(input.idempotencyKey,'Idempotency key');
      if(!/^[a-f0-9]{64}$/u.test(input.validationSha256))throw new Error('Invalid validation SHA-256');
      validateLimits(input.limits);
      const existing=await service.readAssetHead(spaceId,executionBudgetAssetId(input.id));
      if(existing){
        const prior=revision(existing,input.id);
        if(prior.creationKey===input.idempotencyKey&&prior.workflowVersionId===input.workflowVersionId&&
          prior.validationSha256===input.validationSha256&&isDeepStrictEqual(prior.limits,input.limits))return prior;
        throw new Error('Execution budget already exists with different creation identity');
      }
      const version=await service.importAsset(spaceId,{assetId:executionBudgetAssetId(input.id),schema:EXECUTION_BUDGET_SCHEMA_REF,
        payload:{budgetId:input.id,workflowVersionId:input.workflowVersionId,validationSha256:input.validationSha256,
          limits:input.limits,creationKey:input.idempotencyKey,startedAt:null,reservations:[]},
        dependencies:[],description:'Create execution budget',idempotencyKey:input.idempotencyKey});
      return revision(version,input.id);
    },
    async read(spaceId:string,id:string):Promise<ExecutionBudgetRevision> {
      nonempty(id,'Execution budget ID');
      const head=await service.readAssetHead(spaceId,executionBudgetAssetId(id));
      if(!head)throw new Error('Execution budget not found in authorized Space');
      return revision(head,id);
    },
    async reserve(spaceId:string,id:string,input:ExecutionBudgetReserve):Promise<ExecutionBudgetReservationReceipt> {
      nonempty(id,'Execution budget ID');
      for(const key of ['runId','stepRunId','attemptId'] as const)nonempty(input[key],key);
      if(!Number.isSafeInteger(input.turn)||input.turn<1||!['trial','case'].includes(input.stage)||
        !['original','tool-continuation','technical-repair'].includes(input.kind))throw new Error('Invalid execution budget reservation');
      // Distinct invocations must compete through CAS even when they reserve the same turn at the same millisecond.
      // Keep this nonce stable across this invocation's bounded retries for an uncertain write result.
      const invocationNonce=randomUUID();
      for(let attempt=0;attempt<3;attempt++){
        const head=await service.readAssetHead(spaceId,executionBudgetAssetId(id));
        if(!head)throw new Error('Execution budget not found in authorized Space');
        const current=revision(head,id),key=identity(input);
        const sameTurn=current.reservations.find(item=>identity(item)===key);
        const clock=now().getTime();
        if(!Number.isFinite(clock))throw new Error('Execution budget clock is invalid');
        const startedAt=current.startedAt??iso(clock);
        const absoluteDeadline=deadline(startedAt,current.limits.maxDurationMs);
        const occurrence=current.reservations.find(item=>item.runId===input.runId&&item.stepRunId===input.stepRunId);
        const nodeDeadline=deadline(occurrence?.reservedAt??iso(clock),current.limits.maxNodeDurationMs);
        if(clock>=absoluteDeadline)throw new Error('Execution budget duration exceeded');
        if(clock>=nodeDeadline)throw new Error('Execution budget node duration exceeded');
        if(sameTurn){
          if(sameTurn.stage!==input.stage||sameTurn.kind!==input.kind)throw new Error('Execution budget reservation identity collision');
          return {...sameTurn,reused:true};
        }
        if(current.reservations.length>=current.limits.maxCalls)throw new Error('Execution budget call limit exceeded');
        if(input.stage==='trial'){
          const trial=current.reservations.filter(item=>item.stage==='trial');
          if(trial.length>=current.limits.maxTrialCalls)throw new Error('Execution budget trial call limit exceeded');
          if(!trial.length&&input.kind!=='original')throw new Error('Execution trial must begin with an original call');
          if(trial.length&&(!(current.limits.trialSecondKinds??['technical-repair']).includes(input.kind as 'tool-continuation'|'technical-repair')||
            input.runId!==trial[0]!.runId||input.stepRunId!==trial[0]!.stepRunId))
            throw new Error('Execution trial second call must use a frozen allowed kind in the original occurrence');
        }
        if(input.kind==='technical-repair'&&current.reservations.filter(item=>item.runId===input.runId&&item.stepRunId===input.stepRunId&&item.kind==='technical-repair').length>=current.limits.maxTechnicalRepairsPerOccurrence)
          throw new Error('Execution budget technical repair limit exceeded');
        const reservation:ExecutionBudgetReservation={...input,callOrdinal:current.reservations.length+1,reservedAt:iso(clock),
          deadlineAt:iso(absoluteDeadline),nodeDeadlineAt:iso(nodeDeadline)};
        const {id:_revisionId,assetId:_assetId,revision:_revision,payloadHash:_payloadHash,createdAt:_createdAt,recordedBy:_recordedBy,...payload}=current;
        try{
          await service.importAsset(spaceId,{assetId:executionBudgetAssetId(id),expectedHead:head.id,schema:EXECUTION_BUDGET_SCHEMA_REF,
            payload:{...payload,startedAt,reservations:[...current.reservations,reservation]},dependencies:[head.id],
            description:`Reserve execution budget call ${reservation.callOrdinal}`,
            idempotencyKey:`execution-budget-reserve:${sha(`${id}:${key}:${head.id}:${invocationNonce}`)}`});
          return {...reservation,reused:false};
        }catch(error){
          if(!(error instanceof Error)||!/Asset version conflict|expected head|23505/u.test(error.message))throw error;
        }
      }
      throw new Error('Execution budget contention; reservation denied');
    },
  };
}
