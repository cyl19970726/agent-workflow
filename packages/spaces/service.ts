import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RunRecord, StepResultCommit, StepResultReceipt, ValidationState } from '@signal-room/workflow';
import { artifactPayloadSha256, workflowFingerprint } from '@signal-room/workflow';
import { PostgresWorkflowRunStore } from '@signal-room/workflow-postgres';
import {
  SchemaRegistry, publishStorageContract, projectBoundInput, validateNodeWrite, assertNodeAction, assertStateTransition,
  ContractValidationError, validateAgentOutput, verifyStorageContract,
  type SchemaDefinition, type FrozenSchemaRevision, type FrozenStorageContract,
} from '@signal-room/workflow-space-contracts';
import { bytesHash, type BlobStore } from './blob-store.js';
import { InvalidObservedOutputError } from './errors.js';
import { publishProcessContract } from './process-contract.js';
import type { HistoricalProcessResolver, ProcessView } from './process-projection.js';
import { projectProcess } from './process-projection.js';
import { insertNodeRelations, validateRelationEvent, validateStoredRelation, persistRelation, queryRelationFacts, type ExplicitRelationEvent, projectRunRelations, type RelationProjection } from './relation.js';
import { validateWorkflowPresentation, type WorkflowPresentationDraft, type WorkflowPresentation, type PresentationBinding, type ResolvedPresentation } from './presentation.js';
import type {
  SpacePrincipal, SpaceRole, WorkflowSpace, WorkflowVersionDraft, WorkflowVersion, SpaceCase, InputManifest,
  SpaceRun, AssetSource, AssetVersion, AssetWrite, BlobManifest, NodeStart, NodeContext, NodeClient, NodeCommit, NodeReceipt,
  DeliveredInput, SessionRecord, SessionEvent, KnowledgeRevision, ReviewDraft, Review, ComparisonDraft, Comparison,
  IterationDraft, AdoptionDraft, Adoption, SpaceOverview,
  ValidationPlanDraft, ValidationPlan, ValidationEntry, ValidationRunLink, ValidationReviewLink,
  ValidationComparison, ValidationIssueDraft, ValidationIssue, ValidationSummary, ValidationEntrySummary,
  ValidationJudgePolicy, ValidationJudgeEvidence,
} from './types.js';
import {validationEntries,validationStatuses,sameJson} from './validation.js';

type DB = Pool | PoolClient;
const json = (value: unknown): string => JSON.stringify(value);
const clone = <T>(value: T): T => structuredClone(value);
const now = (): string => new Date().toISOString();
const required = (value: string, name: string): void => { if (!value?.trim()) throw new Error(`${name} is required`); };
const hash = artifactPayloadSha256;
const roles: SpaceRole[] = ['owner','creator','operator','viewer'];
const writers: SpaceRole[] = ['owner','creator','operator'];
function safeConfig(value:unknown):void {
  if(!value || typeof value!=='object') return;
  for(const [key,item] of Object.entries(value)) {
    if(/^(?:.*_)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|client[_-]?secret)$/i.test(key)) throw new Error('Credentials must use protected references, not configuration snapshots');
    safeConfig(item);
  }
}
function validateNodeDefinitions(entry: WorkflowVersionDraft['entrypoints'][string]):void {
  if (!entry.nodeDefinitions) return;
  safeConfig(entry.nodeDefinitions);
  const nodeIds=new Set(entry.process?.nodes.map(node=>node.id)??Object.keys(entry.storageContract.nodes));
  const executorFamilies=new Set(['agent-sdk','codex','program','human','decision']);
  for(const [id,definition] of Object.entries(entry.nodeDefinitions)) {
    if(!nodeIds.has(id)) throw new Error('Node definition must reference a declared node');
    if(!definition || typeof definition!=='object' || Array.isArray(definition)) throw new Error('Invalid node definition');
    for(const key of Object.keys(definition))if(!['purpose','instructions','model','tools','executor','configuration'].includes(key))throw new Error('Unsupported node definition field');
    for(const key of ['purpose','instructions','model'] as const)if(definition[key]!==undefined && typeof definition[key]!=='string')throw new Error('Invalid node definition text');
    if(definition.tools!==undefined && (!Array.isArray(definition.tools)||definition.tools.some(tool=>typeof tool!=='string'||!tool.trim())))throw new Error('Invalid node definition tools');
    if(definition.executor!==undefined) {
      const executor=definition.executor as unknown;
      if(!executor || typeof executor!=='object' || Array.isArray(executor))throw new Error('Invalid node executor');
      const declaration=executor as Record<string,unknown>;
      if(Object.keys(declaration).some(key=>!['family','adapter'].includes(key)))throw new Error('Unsupported node executor field');
      if(typeof declaration.family!=='string' || !executorFamilies.has(declaration.family))throw new Error('Invalid node executor family');
      if(declaration.adapter!==undefined && (typeof declaration.adapter!=='string' || !declaration.adapter.trim()))throw new Error('Invalid node executor adapter');
    }
    if(definition.configuration!==undefined && (!definition.configuration||typeof definition.configuration!=='object'||Array.isArray(definition.configuration)))throw new Error('Invalid node configuration');
  }
}

/** The command has a durable run receipt. Callers must read that run, never invoke its runner again. */
export class RuntimeCommandAlreadyStartedError extends Error {
  constructor(readonly runId: string) {
    super(`Runtime command already started: ${runId}`);
    this.name = 'RuntimeCommandAlreadyStartedError';
  }
}

export type ExecutionTaskStatus = 'queued'|'running'|'cancel_requested'|'interrupted'|'completed'|'failed'|'canceled';
export interface ExecutionTask {
  spaceId:string; runId:string; workflowVersionId:string; entrypoint:string; inputManifestId:string; caseId:string;
  executorKey:string; status:ExecutionTaskStatus; owner?:string; claimToken?:string; leaseExpiresAt?:string;
  createdAt:string; updatedAt:string; error?:string; leaseExpired?:boolean;
}
type ExecutionRow = {
  space_id:string; run_id:string; workflow_version_id:string; entrypoint:string; input_manifest_id:string; case_id:string;
  executor_key:string; request_hash:string; status:ExecutionTaskStatus; owner:string|null; claim_token:string|null; lease_expires_at:Date|null;
  created_at:Date; updated_at:Date; error:string|null; lease_expired?:boolean;
};
const executionTask=(row:ExecutionRow):ExecutionTask=>({spaceId:row.space_id,runId:row.run_id,workflowVersionId:row.workflow_version_id,
  entrypoint:row.entrypoint,inputManifestId:row.input_manifest_id,caseId:row.case_id,executorKey:row.executor_key,
  status:row.lease_expired?'interrupted':row.status,...(row.lease_expired?{leaseExpired:true}:{}),
  ...(row.owner?{owner:row.owner}:{}),...(row.claim_token?{claimToken:row.claim_token}:{}),
  ...(row.lease_expires_at?{leaseExpiresAt:row.lease_expires_at.toISOString()}:{}),
  createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),
  ...(row.lease_expired?{error:'Lease expired; execution outcome requires reconciliation'}:row.error?{error:row.error}:{})});


/** Trusted server service. Give Agents only the object returned by nodeClient().
 * The host authenticates principal IDs; membership and capabilities are checked here. */
export class WorkflowSpaceService {
  constructor(private readonly pool: Pool, private readonly blobs: BlobStore, private readonly principal: SpacePrincipal,
    private readonly presentationOptions: { readerIds?: readonly string[]; resultRoleIds?: readonly string[]; processResolvers?: Record<string, HistoricalProcessResolver> } = {}) {
    required(principal.id,'Authenticated principal');
  }
  private async tx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  private async access(db: DB, spaceId: string, allowed = roles, writing = false): Promise<WorkflowSpace> {
    const result = await db.query<{role: SpaceRole; document: WorkflowSpace}>(
      'SELECT m.role,s.document FROM ws_members m JOIN ws_spaces s ON s.id=m.space_id WHERE m.space_id=$1 AND m.principal_id=$2', [spaceId,this.principal.id]);
    const row = result.rows[0];
    if (!row || !allowed.includes(row.role)) throw new Error('Space access denied');
    if (writing && row.document.status !== 'active') throw new Error('Space is archived');
    return row.document;
  }
  private async one<T>(db: DB, table: string, spaceId: string, id: string, idColumn = 'id'): Promise<T> {
    // Table/column names are internal constants only, never accepted from a public operation.
    const result = await db.query<{document: T}>(`SELECT document FROM ${table} WHERE space_id=$1 AND ${idColumn}=$2`, [spaceId,id]);
    if (!result.rows[0]) throw new Error('Record not found in authorized space');
    return result.rows[0].document;
  }
  private async list<T>(db: DB, table: string, spaceId: string): Promise<T[]> {
    return (await db.query<{document: T}>(`SELECT document FROM ${table} WHERE space_id=$1`,[spaceId])).rows.map(r=>r.document);
  }
  private async registry(db: DB, spaceId: string): Promise<SchemaRegistry> {
    return new SchemaRegistry(await this.list<FrozenSchemaRevision>(db,'ws_schemas',spaceId));
  }
  private async lock(db: PoolClient, spaceId: string): Promise<void> {
    await db.query('SELECT id FROM ws_spaces WHERE id=$1 FOR UPDATE',[spaceId]);
  }
  private async idempotent<T>(db: PoolClient, spaceId: string, scope: string, key: string, request: unknown, work: ()=>Promise<T>): Promise<T> {
    required(key,'Idempotency key');
    await this.lock(db,spaceId);
    const requestHash = await hash(request);
    const prior = await db.query<{request_hash: string; receipt: T}>(
      'SELECT request_hash,receipt FROM ws_commits WHERE space_id=$1 AND scope=$2 AND idempotency_key=$3',[spaceId,scope,key]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new Error('Idempotency conflict');
      return prior.rows[0].receipt;
    }
    const receipt = await work();
    await db.query('INSERT INTO ws_commits(space_id,scope,idempotency_key,request_hash,receipt) VALUES ($1,$2,$3,$4,$5::jsonb)',[spaceId,scope,key,requestHash,json(receipt)]);
    return receipt;
  }
  private ledger(spaceId: string): PostgresWorkflowRunStore {
    // Host-only wiring for the workflow runtime; never expose it as an Agent tool.
    return new PostgresWorkflowRunStore(this.pool,{workspaceId:spaceId});
  }
  async createSpace(input: {id?: string; purpose: string}): Promise<WorkflowSpace> {
    required(input.purpose,'Business purpose');
    if (this.principal.kind !== 'human') throw new Error('Space creation requires a human owner');
    return this.tx(async db => {
      const space: WorkflowSpace = {id:input.id??randomUUID(),purpose:input.purpose,owner:this.principal.id,status:'active',createdAt:now()};
      await db.query('INSERT INTO ws_spaces(id,document) VALUES($1,$2::jsonb)',[space.id,json(space)]);
      await db.query('INSERT INTO ws_members(space_id,principal_id,role) VALUES($1,$2,$3)',[space.id,this.principal.id,'owner']);
      return space;
    });
  }
  async listSpaces(): Promise<WorkflowSpace[]> {
    return (await this.pool.query<{document: WorkflowSpace}>('SELECT s.document FROM ws_spaces s JOIN ws_members m ON m.space_id=s.id WHERE m.principal_id=$1',[this.principal.id])).rows.map(r=>r.document);
  }
  async grant(spaceId: string, principalId: string, role: SpaceRole): Promise<void> {
    await this.access(this.pool,spaceId,['owner'],true); required(principalId,'Principal');
    if (!roles.includes(role)) throw new Error('Unknown space role');
    await this.pool.query('INSERT INTO ws_members(space_id,principal_id,role) VALUES($1,$2,$3) ON CONFLICT(space_id,principal_id) DO UPDATE SET role=EXCLUDED.role',[spaceId,principalId,role]);
  }
  async registerSchemas(spaceId: string, definitions: SchemaDefinition[]): Promise<FrozenSchemaRevision[]> {
    return this.tx(async db => {
      await this.access(db,spaceId,['owner'],true); await this.lock(db,spaceId);
      const registry = await this.registry(db,spaceId);
      const results: FrozenSchemaRevision[] = [];
      for (const definition of definitions) {
        const frozen = registry.registerSchema(definition);
        await db.query('INSERT INTO ws_schemas(space_id,namespace,revision,hash,document) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(space_id,namespace,revision) DO NOTHING',[spaceId,frozen.namespace,frozen.revision,frozen.hash,json(frozen)]);
        for (const dependency of frozen.dependencies) await db.query(
          'INSERT INTO ws_schema_dependencies(space_id,namespace,revision,dependency_namespace,dependency_revision,dependency_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [spaceId,frozen.namespace,frozen.revision,dependency.namespace,dependency.revision,dependency.hash]);
        results.push(frozen);
      }
      return results;
    });
  }
  async publishWorkflow(spaceId: string, draft: WorkflowVersionDraft): Promise<WorkflowVersion> {
    return this.tx(async db => {
      await this.access(db,spaceId,['owner'],true); await this.lock(db,spaceId);
      safeConfig(draft.config);
      required(draft.id,'Workflow version ID'); required(draft.revision,'Workflow revision'); required(draft.changeReason,'Change reason');
      if (!Object.keys(draft.entrypoints).length) throw new Error('Workflow needs an execution entrypoint');
      if(draft.predecessorId) {
        if(draft.predecessorId===draft.id)throw new Error('Workflow predecessor cannot be itself');
        const predecessor=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,draft.predecessorId);
        if(!Object.values(predecessor.entrypoints).some(prior=>Object.values(draft.entrypoints).some(entry=>entry.workflowId===prior.workflowId))) {
          throw new Error('Workflow predecessor must share an executable workflow identity');
        }
      }
      const registry = await this.registry(db,spaceId);
      const entrypoints: WorkflowVersion['entrypoints'] = {};
      for (const [name,entry] of Object.entries(draft.entrypoints)) {
        validateNodeDefinitions(entry);
        required(entry.workflowId,'Executable workflow ID'); required(entry.codeRevision,'Code revision');
        if (entry.storageContract.workflowVersion !== draft.id) throw new Error('Contract must bind this workflow version');
        const storageContract=publishStorageContract(registry,entry.storageContract);
        const {process:processDraft,...rest}=entry;
        entrypoints[name] = {...rest,storageContract,
          ...(processDraft ? {process:await publishProcessContract(processDraft,storageContract)} : {})};
      }
      const publishedTypes=new Map<string,string>();
      const definitions=[...await this.list<WorkflowVersion>(db,'ws_workflows',spaceId),{entrypoints}];
      for(const definition of definitions) for(const entry of Object.values(definition.entrypoints)) for(const type of entry.process?.relationTypes??[]) {
        const key=`${type.id}@${type.revision}`,digest=await hash(type),previous=publishedTypes.get(key);
        if(previous&&previous!==digest) throw new Error('Relation type revision is immutable within a Space');
        publishedTypes.set(key,digest);
      }
      const data = {...clone(draft),spaceId,entrypoints};
      const digest = await hash(data);
      const old = await db.query<{hash: string; document: WorkflowVersion}>('SELECT hash,document FROM ws_workflows WHERE space_id=$1 AND id=$2',[spaceId,draft.id]);
      if (old.rows[0]) {
        if (old.rows[0].hash !== digest) throw new Error('Published workflow version is immutable');
        return old.rows[0].document;
      }
      const version = {...data,hash:digest,createdAt:now()};
      await db.query('INSERT INTO ws_workflows(space_id,id,predecessor_id,hash,document) VALUES($1,$2,$3,$4,$5::jsonb)',[spaceId,draft.id,draft.predecessorId??null,digest,json(version)]);
      return version;
    });
  }
  async registerPresentation(spaceId: string, draft: WorkflowPresentationDraft): Promise<WorkflowPresentation> {
    return this.tx(async db => {
      await this.access(db,spaceId,['owner'],true); await this.lock(db,spaceId);
      const registry = await this.registry(db,spaceId);
      const digest = await validateWorkflowPresentation(draft,registry,this.presentationOptions.readerIds,this.presentationOptions.resultRoleIds??[]);
      const old = await db.query<{hash:string;document:WorkflowPresentation}>(
        'SELECT hash,document FROM ws_presentations WHERE space_id=$1 AND id=$2 AND revision=$3',
        [spaceId,draft.id,draft.revision]);
      if (old.rows[0]) {
        if (old.rows[0].hash !== digest) throw new Error('Published presentation revision is immutable');
        return old.rows[0].document;
      }
      const presentation: WorkflowPresentation = {...clone(draft),spaceId,hash:digest,createdAt:now(),createdBy:this.principal.id};
      await db.query('INSERT INTO ws_presentations(space_id,id,revision,hash,document) VALUES($1,$2,$3,$4,$5::jsonb)',
        [spaceId,draft.id,draft.revision,digest,json(presentation)]);
      return presentation;
    });
  }
  async getPresentation(spaceId: string, id: string, revision: string): Promise<WorkflowPresentation> {
    await this.access(this.pool,spaceId);
    const result=await this.pool.query<{document:WorkflowPresentation}>(
      'SELECT document FROM ws_presentations WHERE space_id=$1 AND id=$2 AND revision=$3',[spaceId,id,revision]);
    if (!result.rows[0]) throw new Error('Presentation not found in authorized space');
    return result.rows[0].document;
  }
  async listPresentations(spaceId: string): Promise<WorkflowPresentation[]> {
    await this.access(this.pool,spaceId);
    return (await this.pool.query<{document:WorkflowPresentation}>(
      'SELECT document FROM ws_presentations WHERE space_id=$1 ORDER BY id,revision',[spaceId])).rows.map(row=>row.document);
  }
  async bindPresentation(spaceId: string, input: {workflowVersionId:string;entrypoint:string;presentationId:string;revision:string}): Promise<PresentationBinding> {
    return this.tx(async db => {
      await this.access(db,spaceId,['owner'],true); await this.lock(db,spaceId);
      const workflow=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,input.workflowVersionId);
      if (!Object.hasOwn(workflow.entrypoints,input.entrypoint)) throw new Error('Unknown workflow entrypoint');
      const result=await db.query<{document:WorkflowPresentation}>(
        'SELECT document FROM ws_presentations WHERE space_id=$1 AND id=$2 AND revision=$3',
        [spaceId,input.presentationId,input.revision]);
      const presentation=result.rows[0]?.document;
      if (!presentation) throw new Error('Presentation not found in authorized space');
      if (presentation.entrypoint!==input.entrypoint) throw new Error('Presentation entrypoint does not match binding');
      const binding:PresentationBinding={id:randomUUID(),spaceId,workflowVersionId:input.workflowVersionId,
        entrypoint:input.entrypoint,presentationId:presentation.id,presentationRevision:presentation.revision,
        presentationHash:presentation.hash,actorId:this.principal.id,createdAt:now()};
      await db.query('INSERT INTO ws_presentation_bindings(space_id,id,workflow_version_id,entrypoint,presentation_id,presentation_revision,presentation_hash,actor_id,created_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
        [spaceId,binding.id,binding.workflowVersionId,binding.entrypoint,binding.presentationId,binding.presentationRevision,binding.presentationHash,binding.actorId,binding.createdAt,json(binding)]);
      return binding;
    });
  }
  async resolvePresentation(spaceId:string,workflowVersionId:string,entrypoint:string):Promise<ResolvedPresentation|null> {
    await this.access(this.pool,spaceId);
    const workflow=await this.one<WorkflowVersion>(this.pool,'ws_workflows',spaceId,workflowVersionId);
    if (!Object.hasOwn(workflow.entrypoints,entrypoint)) throw new Error('Unknown workflow entrypoint');
    const history=(await this.pool.query<{document:PresentationBinding}>(
      'SELECT document FROM ws_presentation_bindings WHERE space_id=$1 AND workflow_version_id=$2 AND entrypoint=$3 ORDER BY ordinal',
      [spaceId,workflowVersionId,entrypoint])).rows.map(row=>row.document);
    const binding=history.at(-1);
    if (!binding) return null;
    const presentation=await this.getPresentation(spaceId,binding.presentationId,binding.presentationRevision);
    if (presentation.hash!==binding.presentationHash) throw new Error('Presentation binding hash mismatch');
    return {presentation,binding,history};
  }
  async createCase(spaceId: string, input: Omit<SpaceCase,'spaceId'>): Promise<SpaceCase> {
    return this.tx(async db => {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId);
      required(input.title,'Case title'); required(input.objective,'Case objective');
      const value = {...clone(input),spaceId};
      const prior = await db.query<{document:SpaceCase}>('SELECT document FROM ws_cases WHERE space_id=$1 AND id=$2',[spaceId,input.id]);
      if (prior.rows[0]) {
        if (await hash(prior.rows[0].document) !== await hash(value)) throw new Error('Case ID conflicts with a different request');
        return prior.rows[0].document;
      }
      await db.query('INSERT INTO ws_cases(space_id,id,document) VALUES($1,$2,$3::jsonb)',[spaceId,input.id,json(value)]);
      return value;
    });
  }
  async freezeInputs(spaceId: string, caseId: string, assets: Record<string,string>): Promise<InputManifest> {
    return this.tx(async db => {
      await this.access(db,spaceId,writers,true);
      for (const id of Object.values(assets)) await this.asset(db,spaceId,id);
      const digest=await hash({caseId,assets});
      const value = {id:digest,spaceId,caseId,assets:clone(assets),hash:digest};
      // Both unique keys identify this same content-addressed manifest; either may arbitrate a concurrent insert.
      await db.query('INSERT INTO ws_manifests(space_id,id,case_id,document) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[spaceId,value.id,caseId,json(value)]);
      for (const [slot,id] of Object.entries(assets)) await db.query('INSERT INTO ws_manifest_assets(space_id,manifest_id,slot,version_id) VALUES($1,$2,$3,$4) ON CONFLICT(space_id,manifest_id,slot) DO NOTHING',[spaceId,value.id,slot,id]);
      return value;
    });
  }
  async startRun(spaceId: string, input: {workflowVersionId: string; entrypoint: string; inputManifestId: string; effectiveConfig?: Record<string,unknown>; idempotencyKey: string}): Promise<SpaceRun> {
    return this.tx(async db => {
      await this.access(db,spaceId,writers,true);
      return this.idempotent(db,spaceId,'startRun',input.idempotencyKey,input,async()=> {
        const version = await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,input.workflowVersionId);
        const entry = version.entrypoints[input.entrypoint]; if (!entry) throw new Error('Unknown workflow entrypoint');
        const manifest = await this.one<InputManifest>(db,'ws_manifests',spaceId,input.inputManifestId);
        const config = {...version.config,...input.effectiveConfig};
        safeConfig(config);
        const run = await this.ledger(spaceId).inTransaction(db).createRun({workflowId:entry.workflowId,workflowRevision:entry.codeRevision,inputFingerprint:manifest.hash,state:'running',metadata:{spaceId,workflowVersionId:version.id,entrypoint:input.entrypoint}});
        const binding: SpaceRun = {runId:run.id,spaceId,workflowVersionId:version.id,entrypoint:input.entrypoint,caseId:manifest.caseId,inputManifestId:manifest.id,effectiveConfig:config,configHash:await hash(config),
          ...(entry.process?{process:{revision:entry.process.revision,hash:entry.process.hash}}:{})};
        await db.query('INSERT INTO ws_runs(space_id,run_id,workflow_version_id,case_id,manifest_id,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[spaceId,run.id,version.id,manifest.caseId,manifest.id,json(binding)]);
        return binding;
      });
    });
  }
  private async asset(db: DB, spaceId: string, id: string): Promise<AssetVersion> {
    const asset = await this.one<AssetVersion>(db,'ws_asset_versions',spaceId,id);
    if (await hash(asset.payload) !== asset.payloadHash) throw new Error('Asset payload integrity check failed');
    (await this.registry(db,spaceId)).validatePayload(asset.schema,asset.payload);
    return asset;
  }
  async readAsset(spaceId: string, id: string): Promise<AssetVersion & {state:string}> {
    await this.access(this.pool,spaceId);
    const asset = await this.asset(this.pool,spaceId,id);
    return {...asset,state:await this.state(this.pool,spaceId,asset)};
  }
  private async state(db: DB, spaceId: string, asset: AssetVersion): Promise<string> {
    const rows = await db.query<{document:{to:string}}>('SELECT document FROM ws_transitions WHERE space_id=$1 AND version_id=$2 ORDER BY ordinal DESC LIMIT 1',[spaceId,asset.id]);
    return rows.rows[0]?.document.to ?? asset.initialState;
  }
  private async writeAsset(db: PoolClient, spaceId: string, input: Omit<AssetWrite,'idempotencyKey'>, source: AssetSource, initialState: string): Promise<AssetVersion> {
    (await this.registry(db,spaceId)).validatePayload(input.schema,input.payload);
    const assetId = input.assetId ?? randomUUID();
    const existing = await db.query<{namespace:string; head_id:string; next_version:number}>('SELECT namespace,head_id,next_version FROM ws_assets WHERE space_id=$1 AND id=$2 FOR UPDATE',[spaceId,assetId]);
    if (existing.rows[0]) {
      if (existing.rows[0].namespace !== input.schema.namespace) throw new Error('Logical asset schema namespace cannot change');
      if (existing.rows[0].head_id !== input.expectedHead) throw new Error('Asset version conflict: expected head required');
      const head=await this.asset(db,spaceId,existing.rows[0].head_id);
      if((head.schema.revision!==input.schema.revision || head.schema.hash!==input.schema.hash) &&
        (source.kind!=='transform' || !input.dependencies?.includes(head.id))) throw new Error('Schema revision change requires explicit transformation from the previous version');
    } else {
      if (input.expectedHead) throw new Error('Asset version conflict: no head');
      await db.query('INSERT INTO ws_assets(space_id,id,namespace) VALUES($1,$2,$3)',[spaceId,assetId,input.schema.namespace]);
    }
    const dependencies = [...new Set(input.dependencies??[])];
    for (const id of dependencies) await this.asset(db,spaceId,id);
    const attachments: BlobManifest[] = [];
    for (const id of [...new Set(input.blobIds??[])]) {
      const blob = await this.one<BlobManifest>(db,'ws_blobs',spaceId,id);
      const bytes = await this.blobs.get(blob.key);
      if (bytesHash(bytes)!==blob.sha256 || bytes.byteLength!==blob.size) throw new Error('Blob integrity check failed');
      attachments.push(blob);
    }
    const version: AssetVersion = {id:randomUUID(),spaceId,assetId,version:existing.rows[0]?.next_version??1,schema:clone(input.schema),payload:clone(input.payload),payloadHash:await hash(input.payload),source,dependencies,attachments,initialState,createdAt:now()};
    const producer = source.kind==='node'?source:undefined;
    await db.query('INSERT INTO ws_asset_versions(space_id,id,asset_id,version,namespace,schema_revision,schema_hash,run_id,step_run_id,attempt_id,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',
      [spaceId,version.id,assetId,version.version,input.schema.namespace,input.schema.revision,input.schema.hash,producer?.runId??null,producer?.stepRunId??null,producer?.attemptId??null,json(version)]);
    for (const id of dependencies) await db.query('INSERT INTO ws_asset_dependencies(space_id,version_id,dependency_id) VALUES($1,$2,$3)',[spaceId,version.id,id]);
    for (const blob of attachments) await db.query('INSERT INTO ws_asset_blobs(space_id,version_id,blob_id) VALUES($1,$2,$3)',[spaceId,version.id,blob.id]);
    await db.query('UPDATE ws_assets SET head_id=$3,next_version=$4 WHERE space_id=$1 AND id=$2',[spaceId,assetId,version.id,version.version+1]);
    return version;
  }
  async importAsset(spaceId: string, input: AssetWrite & {description: string}): Promise<AssetVersion> {
    return this.tx(async db => {
      await this.access(db,spaceId,writers,true); required(input.description,'Import source');
      return this.idempotent(db,spaceId,'import',input.idempotencyKey,input,()=>this.writeAsset(db,spaceId,input,{kind:'import',actorId:this.principal.id,description:input.description},'imported'));
    });
  }
  async transformAsset(spaceId: string, input: AssetWrite & {operation: string; description: string}): Promise<AssetVersion> {
    return this.tx(async db=> {
      await this.access(db,spaceId,['owner','creator'],true);
      if (!input.dependencies?.length) throw new Error('Explicit conversion requires source versions');
      required(input.operation,'Transform operation'); required(input.description,'Transform description');
      return this.idempotent(db,spaceId,'transform',input.idempotencyKey,input,()=>this.writeAsset(db,spaceId,input,{kind:'transform',actorId:this.principal.id,description:input.description,operation:input.operation,fromVersionIds:input.dependencies!},'candidate'));
    });
  }
  async uploadBlob(spaceId: string, bytes: Uint8Array, mediaType: string): Promise<BlobManifest> {
    await this.access(this.pool,spaceId,writers,true); required(mediaType,'Media type');
    const sha256 = bytesHash(bytes), key = `${spaceId}/${sha256}`;
    await this.blobs.put(key,bytes);
    const stored = await this.blobs.get(key);
    if (bytesHash(stored)!==sha256 || stored.byteLength!==bytes.byteLength) throw new Error('Blob upload verification failed');
    const manifest: BlobManifest = {id:sha256,spaceId,sha256,size:bytes.byteLength,mediaType,key};
    await this.pool.query('INSERT INTO ws_blobs(space_id,id,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(space_id,id) DO NOTHING',[spaceId,manifest.id,json(manifest)]);
    return this.one(this.pool,'ws_blobs',spaceId,manifest.id);
  }
  async readBlob(spaceId: string, id: string): Promise<Uint8Array> {
    await this.access(this.pool,spaceId);
    const manifest = await this.one<BlobManifest>(this.pool,'ws_blobs',spaceId,id);
    const bytes = await this.blobs.get(manifest.key);
    if (bytesHash(bytes)!==manifest.sha256 || bytes.byteLength!==manifest.size) throw new Error('Blob integrity check failed');
    return bytes;
  }
  private async runContract(db: DB, spaceId: string, runId: string): Promise<{run: SpaceRun; contract: FrozenStorageContract}> {
    const run = await this.one<SpaceRun>(db,'ws_runs',spaceId,runId,'run_id');
    const version = await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,run.workflowVersionId);
    const contract = version.entrypoints[run.entrypoint]?.storageContract;
    if (!contract) throw new Error('Frozen entrypoint missing');
    const {hash:versionHash,createdAt:_createdAt,...versionBody}=version;
    if(await hash(versionBody)!==versionHash) throw new Error('Workflow version integrity check failed');
    verifyStorageContract(contract);
    const process=version.entrypoints[run.entrypoint]?.process;
    if(process) {
      const {hash:processHash,...draft}=process;
      if((await publishProcessContract(draft,contract)).hash!==processHash) throw new Error('Process contract integrity check failed');
    }
    if(run.process && (!process || run.process.hash!==process.hash || run.process.revision!==process.revision)) throw new Error('Frozen run process binding mismatch');
    return {run,contract};
  }
  async startNode(spaceId: string, input: NodeStart): Promise<NodeContext> {
    return this.tx(async db => {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId);
      const prior=await db.query<{document:NodeContext}>(`SELECT c.document FROM ws_contexts c JOIN aw_steps s ON s.workspace_id=c.space_id AND s.id=c.step_run_id WHERE c.space_id=$1 AND c.run_id=$2 AND ${input.existingAttempt?'c.attempt_id=$3':"s.document->>'key'=$3"}`,[spaceId,input.runId,input.existingAttempt?.attemptId??input.key]);
      if(prior.rows[0]) {
        if(prior.rows[0].document.executionPrincipalId!==this.principal.id || prior.rows[0].document.startRequestHash!==await hash(input)) throw new Error('Node start idempotency conflict');
        return prior.rows[0].document;
      }
      const {run,contract} = await this.runContract(db,spaceId,input.runId);
      const workflow=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,run.workflowVersionId);
      const process=workflow.entrypoints[run.entrypoint]?.process;
      if (process && input.process) {
        const processNode=process.nodes.find(item=>item.id===input.process!.nodeId);
        if (!processNode || processNode.storageNodeId!==input.nodeId) throw new Error('Process node does not match storage binding');
        if (input.process.round!==undefined && (!Number.isInteger(input.process.round)||input.process.round<1)) throw new Error('Invalid business round');
        if(input.process.branch && !process.edges.some(edge=>['fork','join'].includes(edge.kind)&&(edge.branch??edge.route)===input.process!.branch&&(edge.from===processNode.id||edge.to===processNode.id))) throw new Error('Unbound process branch');
        if (input.process.route) {
          const edge=process.edges.find(edge=>edge.from===processNode.id && edge.route===input.process!.route && ['condition','rework'].includes(edge.kind));
          const event=(await this.ledger(spaceId).inTransaction(db).listEvents(run.runId)).find(event=>event.seq===input.process!.decisionEventSeq&&event.type==='decision.recorded');
          const raw=event?.data as {decision?:unknown}|undefined;
          const decision=(raw?.decision??raw) as {route?:string;round?:number}|undefined;
          if(!edge||!event||decision?.route!==edge.route||(input.process.round!==undefined&&decision?.round!==input.process.round)) throw new Error('Process route lacks matching recorded decision');
        } else if(input.process.decisionEventSeq!==undefined) throw new Error('Decision reference needs a process route');
      } else if (process && !input.process && process.nodes.some(node=>node.storageNodeId===input.nodeId)) throw new Error('Node requires a process occurrence binding');
      else if (!process && input.process) throw new Error('Run has no frozen process contract');
      safeConfig(input.effectiveConfig);
      const node = contract.nodes[input.nodeId];
      if (!node || !node.actorKinds.includes(input.producer)) throw new Error('Node producer denied');
      const ledgerRun=await this.ledger(spaceId).inTransaction(db).getRun(run.runId);
      if(ledgerRun?.state!=='running') throw new Error('Run is not running');
      const manifest=await this.one<InputManifest>(db,'ws_manifests',spaceId,run.inputManifestId);
      const frozenIds=new Set(Object.values(manifest.assets));
      const registry = await this.registry(db,spaceId);
      const inputs: Record<string,DeliveredInput> = {};
      for (const name of Object.keys(input.inputs)) if (!node.inputs[name]) throw new Error('Undeclared input slot');
      for (const [name,binding] of Object.entries(node.inputs)) {
        const id = input.inputs[name];
        if (!id) { if(binding.optional) continue; throw new Error(`Required input missing: ${name}`); }
        const asset = await this.asset(db,spaceId,id);
        if(!frozenIds.has(id) && !(asset.source.kind==='node' && asset.source.runId===run.runId)) throw new Error('Input is outside the frozen manifest and this run outputs');
        if (await hash(asset.schema)!==await hash(binding.schema)) throw new Error('Input schema mismatch; explicit conversion required');
        const state = await this.state(db,spaceId,asset);
        if (!binding.states.includes(state)) throw new Error(`Input state not allowed: ${name} (${state})`);
        const payload = projectBoundInput(registry,contract,input.nodeId,name,asset.payload,input.producer);
        inputs[name] = {assetVersionId:id,stateAtBinding:state,payloadHash:asset.payloadHash,schema:asset.schema,viewVersion:binding.projection?.version??'full',deliveredHash:await hash(payload),payload};
      }
      const knowledge: KnowledgeRevision[] = [];
      for (const id of input.knowledgeIds??[]) {
        const entry = await this.one<KnowledgeRevision>(db,'ws_knowledge',spaceId,id);
        if (entry.status!=='active' || (entry.scope.roles && !entry.scope.roles.includes(input.nodeId)) || (entry.scope.caseId && entry.scope.caseId!==run.caseId)) throw new Error('Knowledge scope denied');
        knowledge.push(entry);
      }
      const ledger = this.ledger(spaceId).inTransaction(db);
      const existing = (await ledger.listSteps(run.runId)).find(step=>input.existingAttempt ? step.id===input.existingAttempt.stepRunId : step.key===input.key);
      if (existing && !input.existingAttempt) throw new Error('Node key already exists; reconcile its durable context before starting a new attempt');
      if(input.existingAttempt && (!existing || existing.state!=='running' || existing.key!==input.key ||
        (input.producer==='agent' ? existing.kind!=='agent' : !['publish','task'].includes(existing.kind)))) throw new Error('Runtime step binding mismatch');
      if(existing && input.producer==='agent' && input.actualInput!==undefined && existing.inputFingerprint!==workflowFingerprint(input.actualInput)) throw new Error('Runtime delivered input fingerprint mismatch');
      const step = existing ?? await ledger.createStep({runId:run.runId,key:input.key,kind:input.producer==='agent'?'agent':'task',workflowId:(await ledger.getRun(run.runId))!.workflowId,workflowRevision:(await ledger.getRun(run.runId))!.workflowRevision,inputFingerprint:await hash(inputs),configFingerprint:await hash(input.effectiveConfig),state:'running',validation:'pending'});
      const attempt = input.existingAttempt ? (await ledger.listAttempts(step.id)).find(a=>a.id===input.existingAttempt!.attemptId) : await ledger.createAttempt({runId:run.runId,stepRunId:step.id,state:'running'});
      if(!attempt || attempt.state!=='running') throw new Error('Runtime attempt binding mismatch');
      if(input.generatedByContextId) {
        const origin=await this.one<NodeContext>(db,'ws_contexts',spaceId,input.generatedByContextId);
        if(origin.runId!==run.runId || origin.producer!=='agent' || origin.nodeId!==input.nodeId || await hash(origin.process??null)!==await hash(input.process??null)) throw new Error('Agent production origin mismatch');
      }
      let session: SessionRecord;
      if (input.resumeSessionId) {
        if (node.sessionPolicy!=='continue') throw new Error('Node requires a fresh session');
        session = await this.one<SessionRecord>(db,'ws_sessions',spaceId,input.resumeSessionId);
        if (session.role!==input.nodeId) throw new Error('Session role mismatch');
        const priorContexts = await db.query<{document:NodeContext}>('SELECT document FROM ws_contexts WHERE space_id=$1 AND session_id=$2',[spaceId,session.id]);
        for(const row of priorContexts.rows) if((await this.runContract(db,spaceId,row.document.runId)).run.workflowVersionId!==run.workflowVersionId) throw new Error('Session workflow version mismatch');
      } else {
        session = {id:randomUUID(),spaceId,role:input.nodeId,completeness:'open',nextSeq:1};
        await db.query('INSERT INTO ws_sessions(space_id,id,role,document) VALUES($1,$2,$3,$4::jsonb)',[spaceId,session.id,input.nodeId,json(session)]);
      }
      const body = {startRequestHash:await hash(input),declaredConfigHash:run.configHash,effectiveConfigHash:await hash(input.effectiveConfig),executionPrincipalId:this.principal.id,spaceId,runId:run.runId,stepRunId:step.id,attemptId:attempt.id,nodeId:input.nodeId,sessionId:session.id,producer:input.producer,inputs,instructions:input.instructions,effectiveConfig:clone(input.effectiveConfig),knowledge,...(input.actualInput!==undefined?{actualInput:clone(input.actualInput)}:{}),...(input.generatedByContextId?{generatedByContextId:input.generatedByContextId}:{}),...(input.process?{process:clone(input.process)}:{})};
      const context: NodeContext = {...body,id:randomUUID(),hash:await hash(body)};
      await db.query('INSERT INTO ws_contexts(space_id,id,run_id,step_run_id,attempt_id,session_id,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[spaceId,context.id,run.runId,step.id,attempt.id,session.id,json(context)]);
      for(const [slot,item] of Object.entries(inputs)) await db.query('INSERT INTO ws_context_inputs(space_id,context_id,slot,version_id) VALUES($1,$2,$3,$4)',[spaceId,context.id,slot,item.assetVersionId]);
      await this.appendSession(db,spaceId,context,'context','message',{role:'system',instructions:context.instructions,inputs,knowledge,effectiveConfig:context.effectiveConfig,...(context.actualInput!==undefined?{actualInput:context.actualInput}:{})});
      await ledger.appendEvent({runId:run.runId,stepRunId:step.id,attemptId:attempt.id,type:'space.node.started',data:{contextId:context.id,sessionId:session.id,nodeId:input.nodeId}});
      return context;
    });
  }
  async readContext(spaceId: string, contextId: string): Promise<NodeContext> {
    await this.access(this.pool,spaceId); return this.one(this.pool,'ws_contexts',spaceId,contextId);
  }
  /** Closure captures server-validated binding. Tool callers cannot choose another Space or version. */
  async nodeClient(spaceId: string, contextId: string): Promise<NodeClient> {
    await this.access(this.pool,spaceId,writers);
    const context = await this.one<NodeContext>(this.pool,'ws_contexts',spaceId,contextId);
    if(context.executionPrincipalId!==this.principal.id) throw new Error('Execution binding access denied');
    const {contract} = await this.runContract(this.pool,spaceId,context.runId);
    const read = async(slot: string, full = false): Promise<DeliveredInput> => {
      await this.access(this.pool,spaceId,writers);
      const binding = contract.nodes[context.nodeId]?.inputs[slot];
      if (!binding || !context.inputs[slot]) throw new Error('Unbound input denied');
      if (full && binding.projection) throw new Error('Full asset read denied: this node is restricted to its projection');
      assertNodeAction(contract,context.nodeId,binding.projection?'readBoundInputProjection':'readBoundInput',context.producer);
      const delivered = context.inputs[slot]!;
      if(await hash(delivered.payload)!==delivered.deliveredHash) throw new Error('Delivered context integrity check failed');
      await this.recordSessionEvent(spaceId,contextId,`read:${slot}:${full}`, 'trace',{operation:'asset.read',slot,assetVersionId:delivered.assetVersionId,viewVersion:delivered.viewVersion,deliveredHash:delivered.deliveredHash});
      return clone(delivered);
    };
    return Object.freeze({read:(slot:string)=>read(slot),readFull:(slot:string)=>read(slot,true),submit:(commit:NodeCommit)=>this.submitNode(spaceId,contextId,commit),act:async(action:string,input:unknown):Promise<unknown>=>{
      if(action!=='evaluate') throw new Error(`Node action denied: ${action}; creator transitions require the authenticated human service`);
      assertNodeAction(contract,context.nodeId,'evaluate',context.producer);
      if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('Invalid evaluation');
      const draft=input as Omit<ReviewDraft,'judge'>;
      if('judge' in draft || 'spaceId' in draft) throw new Error('System evaluation identity cannot be overridden');
      const allowed=new Set(Object.values(context.inputs).map(i=>i.assetVersionId));
      if(!Array.isArray(draft.assetVersionIds)||!Array.isArray(draft.evidence)||[...draft.assetVersionIds,...draft.evidence].some(id=>!allowed.has(id))) throw new Error('Evaluation evidence is not bound to this node');
      return this.recordReview(spaceId,{...draft,judge:{kind:'agent',id:context.nodeId,sessionId:context.sessionId}});
    }});
  }
  private async appendSession(db: PoolClient, spaceId: string, context: NodeContext, key: string, kind: SessionEvent['kind'], body: unknown): Promise<SessionEvent> {
    const digest = await hash({kind,body});
    const old = await db.query<{request_hash:string;document:SessionEvent}>('SELECT request_hash,document FROM ws_session_events WHERE space_id=$1 AND context_id=$2 AND dedup_key=$3',[spaceId,context.id,key]);
    if(old.rows[0]) { if(old.rows[0].request_hash!==digest) throw new Error('Session event idempotency conflict'); return old.rows[0].document; }
    const counter = await db.query<{next_seq:number}>('UPDATE ws_sessions SET next_seq=next_seq+1 WHERE space_id=$1 AND id=$2 RETURNING next_seq',[spaceId,context.sessionId]);
    const seq = counter.rows[0]!.next_seq-1;
    const event: SessionEvent = {id:randomUUID(),sessionId:context.sessionId,seq,attemptId:context.attemptId,kind,body:clone(body),createdAt:now()};
    await db.query('INSERT INTO ws_session_events(space_id,id,session_id,seq,context_id,dedup_key,request_hash,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[spaceId,event.id,context.sessionId,seq,context.id,key,digest,json(event)]);
    return event;
  }
  async recordSessionEvent(spaceId: string, contextId: string, key: string, kind: SessionEvent['kind'], body: unknown): Promise<SessionEvent> {
    return this.tx(async db=> {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId);
      const context = await this.one<NodeContext>(db,'ws_contexts',spaceId,contextId);
      if(context.executionPrincipalId!==this.principal.id) throw new Error('Execution binding access denied');
      const record=await this.appendSession(db,spaceId,context,key,kind,body);
      const observation=body as {type?:string;data?:{threadId?:unknown}};
      if(kind==='trace' && observation?.type==='agent.completed' && typeof observation.data?.threadId==='string') {
        await db.query("UPDATE ws_sessions SET document=jsonb_set(document,'{nativeSessionId}',$3::jsonb) WHERE space_id=$1 AND id=$2",[spaceId,context.sessionId,json(observation.data.threadId)]);
      }
      return record;
    });
  }
  async sessionEvents(spaceId: string, sessionId: string, after = 0, limit = 100): Promise<{items:SessionEvent[];nextCursor:number;hasMore:boolean}> {
    await this.access(this.pool,spaceId);
    await this.one(this.pool,'ws_sessions',spaceId,sessionId);
    if (!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('Invalid event cursor or page size');
    const rows = await this.pool.query<{document:SessionEvent}>('SELECT document FROM ws_session_events WHERE space_id=$1 AND session_id=$2 AND seq>$3 ORDER BY seq LIMIT $4',[spaceId,sessionId,after,limit+1]);
    const items = rows.rows.slice(0,limit).map(r=>r.document);
    return {items,nextCursor:items.at(-1)?.seq??after,hasMore:rows.rows.length>limit};
  }
  async submitNode(spaceId: string, contextId: string, commit: NodeCommit, runtimeCommit?: StepResultCommit): Promise<NodeReceipt> {
    return this.tx(async db=> {
      await this.access(db,spaceId,writers,true);
      const authorizedContext=await this.one<NodeContext>(db,'ws_contexts',spaceId,contextId);
      if(authorizedContext.executionPrincipalId!==this.principal.id) throw new Error('Execution binding access denied');
      return this.idempotent(db,spaceId,`node:${contextId}`,commit.idempotencyKey,runtimeCommit?{commit,runtimeCommit}:commit,async()=> {
        const context = await this.one<NodeContext>(db,'ws_contexts',spaceId,contextId);
        if(context.executionPrincipalId!==this.principal.id) throw new Error('Execution binding access denied');
        const {contract} = await this.runContract(db,spaceId,context.runId);
        const registry = await this.registry(db,spaceId);
        const ledger = this.ledger(spaceId).inTransaction(db);
        const attempt = (await ledger.listAttempts(context.stepRunId)).find(a=>a.id===context.attemptId);
        if (attempt?.state!=='running') throw new Error('Producer attempt is not running');
        if(new Set(commit.outputs.map(o=>o.slot)).size!==commit.outputs.length) throw new Error('Duplicate output slot');
        const versions: AssetVersion[] = [];
        for(const output of commit.outputs) {
          const rule = contract.nodes[context.nodeId]?.outputs[output.slot];
          if(!rule) throw new Error('Output slot denied');
          validateNodeWrite(registry,contract,{nodeId:context.nodeId,outputSlot:output.slot,payload:output.payload,dependencySlots:output.dependencySlots,append:!!output.assetId,actorKind:context.producer});
          const dependencies = output.dependencySlots.map(slot=> {
            const input = context.inputs[slot]; if(!input) throw new Error('Dependency not bound to node context'); return input.assetVersionId;
          });
          const version = await this.writeAsset(db,spaceId,{schema:rule.schema,payload:output.payload,assetId:output.assetId,expectedHead:output.expectedHead,dependencies,blobIds:output.blobIds},
            {kind:'node',runId:context.runId,stepRunId:context.stepRunId,attemptId:context.attemptId,nodeId:context.nodeId,producer:context.producer,sessionId:context.sessionId,contextId:context.id,...(context.generatedByContextId?{generatedByContextId:context.generatedByContextId}:{})},rule.initialState);
          await db.query('INSERT INTO ws_output_bindings(space_id,context_id,slot,version_id) VALUES($1,$2,$3,$4)',[spaceId,context.id,output.slot,version.id]);
          versions.push(version);
        }
        const receipt: NodeReceipt = {contextId,versions,result:commit.result??null};
        const run=await this.one<SpaceRun>(db,'ws_runs',spaceId,context.runId,'run_id');
        const workflow=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,run.workflowVersionId);
        const process=workflow.entrypoints[run.entrypoint]?.process;
        if (process) await insertNodeRelations(db,spaceId,run,context,process,versions,commit.relations??[],this.principal.id);
        else if (commit.relations?.length) throw new Error('Run has no relation contract');
        await this.appendSession(db,spaceId,context,'result','message',{role:context.producer==='agent'?'assistant':'program',result:commit.result??null,outputs:commit.outputs});
        if(runtimeCommit && (runtimeCommit.stepRunId!==context.stepRunId || runtimeCommit.attemptId!==context.attemptId || versions.length!==1 || !runtimeCommit.artifact)) throw new Error('Runtime publication binding mismatch');
        const coreReceipt=await ledger.commitStepResult(runtimeCommit??{stepRunId:context.stepRunId,attemptId:context.attemptId,idempotencyKey:commit.idempotencyKey,state:'succeeded',validation:'valid',output:receipt,
          events:[{runId:context.runId,stepRunId:context.stepRunId,attemptId:context.attemptId,type:'space.node.completed',data:{contextId,assetVersionIds:versions.map(v=>v.id)}}]});
        if(runtimeCommit) await db.query('INSERT INTO ws_runtime_artifacts(space_id,artifact_id,version_id) VALUES($1,$2,$3)',[spaceId,coreReceipt.artifact!.id,versions[0]!.id]);
        await db.query("UPDATE ws_sessions SET document=jsonb_set(document,'{completeness}','\"complete\"') WHERE space_id=$1 AND id=$2",[spaceId,context.sessionId]);
        return receipt;
      });
    });
  }
  async failNode(spaceId: string, contextId: string, error: string, completeness: 'complete'|'incomplete' = 'incomplete'): Promise<void> {
    await this.tx(async db=> {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId);
      const context = await this.one<NodeContext>(db,'ws_contexts',spaceId,contextId), ledger = this.ledger(spaceId).inTransaction(db);
      const attempt = (await ledger.listAttempts(context.stepRunId)).find(a=>a.id===context.attemptId);
      if(attempt?.state==='succeeded') throw new Error('A committed result cannot become a failure');
      await this.appendSession(db,spaceId,context,'failure','error',{error,completeness});
      await ledger.updateAttempt(context.attemptId,{state:'failed',error});
      await ledger.updateStep(context.stepRunId,{state:'failed',validation:'invalid',error});
      await db.query("UPDATE ws_sessions SET document=jsonb_set(document,'{completeness}',$3::jsonb) WHERE space_id=$1 AND id=$2",[spaceId,context.sessionId,json(completeness)]);
    });
  }
  async finishRun(spaceId: string, runId: string): Promise<void> {
    await this.tx(async db=> {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId); await this.one(db,'ws_runs',spaceId,runId,'run_id');
      const ledger = this.ledger(spaceId).inTransaction(db), steps = await ledger.listSteps(runId);
      if(!steps.length || steps.some(s=>s.state!=='succeeded')) throw new Error('Run has unfinished or failed nodes');
      await ledger.updateRun(runId,{state:'succeeded'});
    });
  }
  async transition(spaceId: string, input: {workflowVersionId:string;entrypoint:string;nodeId:string;assetVersionId:string;to:string;action:'accept'|'requestRevision';reason:string;idempotencyKey:string}): Promise<{id:string;from:string;to:string}> {
    return this.tx(async db=> {
      await this.access(db,spaceId,['owner','creator'],true);
      if(this.principal.kind!=='human') throw new Error('Creator transition requires authenticated human');
      required(input.reason,'Decision reason');
      return this.idempotent(db,spaceId,'transition',input.idempotencyKey,{...input,actorId:this.principal.id},async()=> {
        const asset = await this.asset(db,spaceId,input.assetVersionId);
        const version = await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,input.workflowVersionId),contract = version.entrypoints[input.entrypoint]?.storageContract;
        if(!contract) throw new Error('Unknown entrypoint');
        if(asset.source.kind==='node') {
          const sourceRun=await this.one<SpaceRun>(db,'ws_runs',spaceId,asset.source.runId,'run_id');
          if(sourceRun.workflowVersionId!==input.workflowVersionId||sourceRun.entrypoint!==input.entrypoint) throw new Error('Decision workflow does not match asset production');
        }
        const from = await this.state(db,spaceId,asset);
        assertStateTransition(contract,{nodeId:input.nodeId,schema:asset.schema,from,to:input.to,action:input.action,actorKind:'human'});
        const value = {...input,id:randomUUID(),from,actorId:this.principal.id,createdAt:now()};
        await db.query('INSERT INTO ws_transitions(space_id,id,version_id,document) VALUES($1,$2,$3,$4::jsonb)',[spaceId,value.id,asset.id,json(value)]);
        return value;
      });
    });
  }
  async saveKnowledge(spaceId: string, input: Omit<KnowledgeRevision,'spaceId'|'author'>): Promise<KnowledgeRevision> {
    return this.tx(async db=> {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId); required(input.content,'Knowledge content');
      if(!['fact','inference'].includes(input.classification)||!['active','superseded'].includes(input.status)) throw new Error('Invalid knowledge classification or status');
      if(!input.sourceAssetIds.length&&!input.sourceMessageIds.length) throw new Error('Knowledge needs source evidence');
      const head = await db.query<{revision_id:string}>('SELECT revision_id FROM ws_knowledge_heads WHERE space_id=$1 AND entry_id=$2',[spaceId,input.entryId]);
      if(head.rows[0]?.revision_id!==input.previousId) throw new Error('Knowledge version conflict');
      if(input.scope.caseId) await this.one(db,'ws_cases',spaceId,input.scope.caseId);
      const value:KnowledgeRevision = {...clone(input),spaceId,author:this.principal.id};
      await db.query('INSERT INTO ws_knowledge(space_id,id,entry_id,previous_id,document) VALUES($1,$2,$3,$4,$5::jsonb)',[spaceId,input.id,input.entryId,input.previousId??null,json(value)]);
      for(const id of new Set(input.sourceAssetIds)) await db.query('INSERT INTO ws_knowledge_assets(space_id,knowledge_id,version_id) VALUES($1,$2,$3)',[spaceId,input.id,id]);
      for(const id of new Set(input.sourceMessageIds)) await db.query('INSERT INTO ws_knowledge_messages(space_id,knowledge_id,message_id) VALUES($1,$2,$3)',[spaceId,input.id,id]);
      await db.query('INSERT INTO ws_knowledge_heads(space_id,entry_id,revision_id) VALUES($1,$2,$3) ON CONFLICT(space_id,entry_id) DO UPDATE SET revision_id=EXCLUDED.revision_id',[spaceId,input.entryId,input.id]);
      return value;
    });
  }
  async recordReview(spaceId: string, input: ReviewDraft): Promise<Review> {
    return this.tx(async db=> {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId);
      const run = await this.one<SpaceRun>(db,'ws_runs',spaceId,input.runId,'run_id');
      for(const key of ['good','bad','improvement','unresolved'] as const) required(input.answers[key],`Review answer ${key}`);
      required(input.standard.id,'Standard ID'); required(input.standard.revision,'Standard revision'); required(input.standard.content,'Standard content');
      if(!input.assetVersionIds.length) throw new Error('Review needs exact target versions');
      for(const id of input.assetVersionIds) {
        const asset = await this.asset(db,spaceId,id);
        if(asset.source.kind!=='node'||asset.source.runId!==run.runId) throw new Error('Review target must be produced by reviewed run');
      }
      for(const id of input.evidence) await this.asset(db,spaceId,id);
      if(!['human','agent'].includes(input.judge.kind)) throw new Error('Unknown judge kind');
      if(input.judge.kind==='human') {
        if(this.principal.kind!=='human'||input.judge.id!==this.principal.id) throw new Error('Human judge identity mismatch');
      } else {
        if(!input.judge.sessionId) throw new Error('Agent review requires an independent observed session');
        const session = await this.one<SessionRecord>(db,'ws_sessions',spaceId,input.judge.sessionId);
        if(session.role!==input.judge.id || session.completeness!=='complete') throw new Error('Agent judge role or completion mismatch');
        const judgeContexts=(await db.query<{document:NodeContext}>('SELECT document FROM ws_contexts WHERE space_id=$1 AND session_id=$2',[spaceId,session.id])).rows.map(r=>r.document);
        const completedAgentContexts=judgeContexts.filter(c=>c.producer==='agent');
        if(!completedAgentContexts.length) throw new Error('Agent review requires an observed Agent context');
        for(const context of completedAgentContexts) {
          const {contract}=await this.runContract(db,spaceId,context.runId);
          assertNodeAction(contract,context.nodeId,'evaluate','agent');
        }
        const seenIds=new Set(judgeContexts.flatMap(c=>Object.values(c.inputs).map(i=>i.assetVersionId)));
        if(input.assetVersionIds.some(id=>!seenIds.has(id))) throw new Error('Judge session did not receive the reviewed versions');
        for(const id of input.assetVersionIds) {
          const asset=await this.asset(db,spaceId,id);
          if(asset.source.kind==='node') {
            const generated=asset.source.generatedByContextId?await this.one<NodeContext>(db,'ws_contexts',spaceId,asset.source.generatedByContextId):undefined;
            if(asset.source.sessionId===session.id || generated?.sessionId===session.id) throw new Error('Judge must be independent from producer');
          }
        }
      }
      if(input.baselineReviewId) {
        const baseline=await this.one<Review>(db,'ws_reviews',spaceId,input.baselineReviewId);
        const priorRun=await this.one<SpaceRun>(db,'ws_runs',spaceId,baseline.runId,'run_id');
        if(priorRun.caseId!==run.caseId) throw new Error('Baseline must refer to the same case');
      }
      const prior = await db.query<{document:Review}>('SELECT document FROM ws_reviews WHERE space_id=$1 AND id=$2',[spaceId,input.id]);
      if (prior.rows[0]) {
        const {spaceId: _spaceId, createdAt: _createdAt, ...draft} = prior.rows[0].document;
        if (await hash(draft) !== await hash(input)) throw new Error('Review ID conflicts with a different request');
        return prior.rows[0].document;
      }
      const value:Review = {...clone(input),spaceId,createdAt:now()};
      await db.query('INSERT INTO ws_reviews(space_id,id,run_id,baseline_id,session_id,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[spaceId,input.id,input.runId,input.baselineReviewId??null,input.judge.sessionId??null,json(value)]);
      for(const id of new Set([...input.assetVersionIds,...input.evidence])) await db.query('INSERT INTO ws_review_assets(space_id,review_id,version_id) VALUES($1,$2,$3)',[spaceId,input.id,id]);
      return value;
    });
  }
  async compare(spaceId: string, input: ComparisonDraft): Promise<Comparison> {
    return this.tx(async db=> {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId);
      const baseline = await this.one<Review>(db,'ws_reviews',spaceId,input.baselineReviewId),candidate=await this.one<Review>(db,'ws_reviews',spaceId,input.candidateReviewId);
      if(candidate.baselineReviewId!==baseline.id) throw new Error('Comparison must use the candidate review explicit baseline');
      const a=await this.one<SpaceRun>(db,'ws_runs',spaceId,baseline.runId,'run_id'),b=await this.one<SpaceRun>(db,'ws_runs',spaceId,candidate.runId,'run_id');
      const ai=await this.one<InputManifest>(db,'ws_manifests',spaceId,a.inputManifestId),bi=await this.one<InputManifest>(db,'ws_manifests',spaceId,b.inputManifestId);
      const pairs:Record<string,{baseline:unknown;candidate:unknown}> = {
        workflowVersion:{baseline:a.workflowVersionId,candidate:b.workflowVersionId},inputs:{baseline:ai.assets,candidate:bi.assets},effectiveConfig:{baseline:a.effectiveConfig,candidate:b.effectiveConfig},standard:{baseline:baseline.standard,candidate:candidate.standard},judge:{baseline:baseline.judge,candidate:candidate.judge},
      };
      const changedConditions:Comparison['changedConditions']={};
      for(const [key,pair] of Object.entries(pairs)) if(await hash(pair.baseline)!==await hash(pair.candidate)) changedConditions[key]=pair;
      const value:Comparison={...clone(input),spaceId,changedConditions};
      const prior = await db.query<{document:Comparison}>('SELECT document FROM ws_comparisons WHERE space_id=$1 AND id=$2',[spaceId,input.id]);
      if (prior.rows[0]) {
        const {spaceId: _spaceId, changedConditions: _changedConditions, ...draft} = prior.rows[0].document;
        if (await hash(draft) !== await hash(input)) throw new Error('Comparison ID conflicts with a different request');
        return prior.rows[0].document;
      }
      await db.query('INSERT INTO ws_comparisons(space_id,id,baseline_id,candidate_id,document) VALUES($1,$2,$3,$4,$5::jsonb)',[spaceId,value.id,baseline.id,candidate.id,json(value)]);
      return value;
    });
  }
  async recordIteration(spaceId: string, input: IterationDraft): Promise<IterationDraft> {
    return this.tx(async db=> {
      await this.access(db,spaceId,writers,true); await this.lock(db,spaceId); required(input.hypothesis,'Iteration hypothesis');
      if(!input.reviewIds.length||!input.caseIds.length||!input.runIds.length) throw new Error('Iteration requires feedback, cases and validating runs');
      for(const id of input.caseIds) await this.one(db,'ws_cases',spaceId,id);
      for(const id of input.runIds) {
        const run=await this.one<SpaceRun>(db,'ws_runs',spaceId,id,'run_id');
        if(run.workflowVersionId!==input.workflowVersionId||!input.caseIds.includes(run.caseId)) throw new Error('Iteration validation run mismatch');
      }
      const prior = await db.query<{document:IterationDraft}>('SELECT document FROM ws_iterations WHERE space_id=$1 AND id=$2',[spaceId,input.id]);
      if (prior.rows[0]) {
        if (await hash(prior.rows[0].document) !== await hash(input)) throw new Error('Iteration ID conflicts with a different request');
        return prior.rows[0].document;
      }
      await db.query('INSERT INTO ws_iterations(space_id,id,workflow_version_id,document) VALUES($1,$2,$3,$4::jsonb)',[spaceId,input.id,input.workflowVersionId,json(input)]);
      for(const id of new Set(input.reviewIds)) await db.query('INSERT INTO ws_iteration_reviews(space_id,iteration_id,review_id) VALUES($1,$2,$3)',[spaceId,input.id,id]);
      for(const id of new Set(input.runIds)) await db.query('INSERT INTO ws_iteration_runs(space_id,iteration_id,run_id) VALUES($1,$2,$3)',[spaceId,input.id,id]);
      return clone(input);
    });
  }
  async adopt(spaceId: string, input: AdoptionDraft): Promise<Adoption> {
    return this.tx(async db=> {
      await this.access(db,spaceId,['owner','creator'],true);
      if(this.principal.kind!=='human') throw new Error('Adoption requires authenticated human');
      required(input.reason,'Adoption reason');required(input.slot,'Adoption slot');
      if(!['workflow','asset'].includes(input.target.kind)) throw new Error('Invalid adoption target kind');
      return this.idempotent(db,spaceId,'adopt',input.idempotencyKey,{...input,actorId:this.principal.id},async()=> {
        const old=await db.query<{adoption_id:string}>('SELECT adoption_id FROM ws_adoption_heads WHERE space_id=$1 AND slot=$2',[spaceId,input.slot]);
        if(old.rows[0]?.adoption_id!==input.expectedPrevious) throw new Error('Adoption version conflict');
        if(input.target.kind==='asset') {
          const asset=await this.asset(db,spaceId,input.target.id);
          if(await this.state(db,spaceId,asset)!=='accepted') throw new Error('Only creator-accepted assets can be adopted');
        }
        if(input.comparisonId) {
          const comparison=await this.one<Comparison>(db,'ws_comparisons',spaceId,input.comparisonId);
          const review=await this.one<Review>(db,'ws_reviews',spaceId,comparison.candidateReviewId);
          const run=await this.one<SpaceRun>(db,'ws_runs',spaceId,review.runId,'run_id');
          if(input.target.kind==='workflow'&&run.workflowVersionId!==input.target.id) throw new Error('Adoption comparison target version mismatch');
        }
        if(input.validationPlanId) {
          if(input.target.kind!=='workflow') throw new Error('Validation plan adoption requires workflow target');
          const plan=await this.one<ValidationPlan>(db,'ws_validation_plans',spaceId,input.validationPlanId);
          if(plan.status!=='frozen') throw new Error('Adoption validation plan must be frozen');
          if(input.target.id!==plan.candidate.workflowVersionId) throw new Error('Adoption plan target must be candidate version');
          if(!input.comparisonId) throw new Error('Validation adoption requires linked comparison evidence');
          const linked=await db.query('SELECT 1 FROM ws_validation_comparisons WHERE space_id=$1 AND plan_id=$2 AND comparison_id=$3',[spaceId,plan.id,input.comparisonId]);
          if(!linked.rows.length) throw new Error('Adoption comparison is not in validation plan');
        }
        const value:Adoption={...clone(input),id:randomUUID(),actorId:this.principal.id,createdAt:now()};
        await db.query('INSERT INTO ws_adoptions(space_id,id,slot,target_workflow_id,target_asset_id,comparison_id,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[spaceId,value.id,input.slot,input.target.kind==='workflow'?input.target.id:null,input.target.kind==='asset'?input.target.id:null,input.comparisonId??null,json(value)]);
        await db.query('INSERT INTO ws_adoption_heads(space_id,slot,adoption_id) VALUES($1,$2,$3) ON CONFLICT(space_id,slot) DO UPDATE SET adoption_id=EXCLUDED.adoption_id',[spaceId,input.slot,value.id]);
        return value;
      });
    });
  }
  async inputManifests(spaceId:string):Promise<InputManifest[]> {
    await this.access(this.pool,spaceId);
    return this.list<InputManifest>(this.pool,'ws_manifests',spaceId);
  }
  async adoptionHeads(spaceId:string):Promise<Adoption[]> {
    await this.access(this.pool,spaceId);
    const rows=await this.pool.query<{document:Adoption}>(`SELECT a.document FROM ws_adoption_heads h
      JOIN ws_adoptions a ON a.space_id=h.space_id AND a.id=h.adoption_id
      WHERE h.space_id=$1 ORDER BY h.slot`,[spaceId]);
    return rows.rows.map(row=>row.document);
  }
  async createValidationPlan(spaceId:string,draft:ValidationPlanDraft):Promise<ValidationPlan> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      for(const value of [draft.id,draft.question,draft.hypothesis,draft.standard?.id,draft.standard?.revision,draft.standard?.content]) required(value,'Validation plan field');
      if(!['prospective','retrospective'].includes(draft.kind)) throw new Error('Unknown validation plan kind');
      if(!draft.cases?.length||!draft.judges?.length) throw new Error('Validation requires cases and judges');
      if(!Array.isArray(draft.expectedVariables)||!Array.isArray(draft.exclusionRules)) throw new Error('Validation conditions required');
      if(new Set(draft.cases.map(item=>item.caseId)).size!==draft.cases.length) throw new Error('Duplicate validation case');
      for(const side of ['baseline','candidate'] as const) {
        const method=draft[side];
        const version=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,method.workflowVersionId);
        if(!version.entrypoints[method.entrypoint]) throw new Error('Validation entrypoint is not published');
      }
      if(draft.baseline.workflowVersionId===draft.candidate.workflowVersionId&&draft.baseline.entrypoint===draft.candidate.entrypoint) throw new Error('Validation needs distinct methods');
      for(const item of draft.cases) {
        if(!Number.isInteger(item.repeats)||item.repeats<1||item.repeats>100) throw new Error('Invalid validation repeat count');
        const manifest=await this.one<InputManifest>(db,'ws_manifests',spaceId,item.inputManifestId);
        if(manifest.caseId!==item.caseId) throw new Error('Validation input manifest case mismatch');
      }
      for(const judge of draft.judges) {
        if(!['human','agent'].includes(judge.kind)) throw new Error('Unknown validation judge kind');
        required(judge.id,'Judge identity');safeConfig(judge.configuration);
        if(judge.kind==='agent') {
          if(typeof judge.instructions!=='string'||!Array.isArray(judge.tools)) throw new Error('Agent judge requires frozen instructions and tool profile');
          if(judge.tools.some(tool=>!tool||typeof tool.name!=='string'||!tool.name.trim()||typeof tool.description!=='string'||!tool.parameters||typeof tool.parameters!=='object')) throw new Error('Invalid Agent judge tool profile');
          if(new Set(judge.tools.map(tool=>tool.name)).size!==judge.tools.length) throw new Error('Duplicate Agent judge tool');
          safeConfig(judge.tools);
        }
      }
      if(new Set(draft.judges.map(judge=>`${judge.kind}:${judge.id}`)).size!==draft.judges.length) throw new Error('Duplicate validation judge policy');
      if(draft.replacesPlanId) {
        const previous=await this.one<ValidationPlan>(db,'ws_validation_plans',spaceId,draft.replacesPlanId);
        if(previous.status!=='frozen'||previous.id===draft.id) throw new Error('Replacement requires different frozen plan');
      }
      const entries=validationEntries(draft);
      for(const exclusion of draft.excludedEntries??[]) {
        if(!entries.some(entry=>entry.id===exclusion.entryId)) throw new Error('Unknown excluded entry');
        required(exclusion.reason,'Exclusion reason');
      }
      const prior=await db.query<{document:ValidationPlan}>('SELECT document FROM ws_validation_plans WHERE space_id=$1 AND id=$2',[spaceId,draft.id]);
      if(prior.rows[0]) {
        const {spaceId:_spaceId,status:_status,createdAt:_createdAt,frozenAt:_frozenAt,frozenRunOrdinal:_ordinal,entries:_entries,...oldDraft}=prior.rows[0].document;
        if(!sameJson(oldDraft,draft)) throw new Error('Validation plan ID conflicts with immutable draft');
        return prior.rows[0].document;
      }
      const value:ValidationPlan={...clone(draft),spaceId,status:'draft',createdAt:now(),entries};
      await db.query('INSERT INTO ws_validation_plans(space_id,id,status,document) VALUES($1,$2,$3,$4::jsonb)',[spaceId,draft.id,'draft',json(value)]);
      return value;
    });
  }
  async freezeValidationPlan(spaceId:string,planId:string):Promise<ValidationPlan> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const plan=await this.one<ValidationPlan>(db,'ws_validation_plans',spaceId,planId);
      if(plan.status==='frozen') return plan;
      for(const entry of plan.entries) {
        const manifest=await this.one<InputManifest>(db,'ws_manifests',spaceId,entry.inputManifestId);
        if(manifest.caseId!==entry.caseId) throw new Error('Frozen manifest case mismatch');
      }
      const associated=await db.query('SELECT 1 FROM ws_validation_runs WHERE space_id=$1 AND plan_id=$2 LIMIT 1',[spaceId,planId]);
      if(associated.rows.length) throw new Error('Cannot freeze plan after associating runs');
      const ordinal=await db.query<{n:string}>('SELECT COALESCE(MAX(created_at),0)::text AS n FROM aw_runs WHERE workspace_id=$1',[spaceId]);
      const value:ValidationPlan={...plan,status:'frozen',frozenAt:now(),frozenRunOrdinal:ordinal.rows[0]!.n};
      await db.query('UPDATE ws_validation_plans SET status=$3,document=$4::jsonb WHERE space_id=$1 AND id=$2',[spaceId,planId,'frozen',json(value)]);
      return value;
    });
  }
  async validationPlans(spaceId:string):Promise<ValidationPlan[]> {await this.access(this.pool,spaceId);return this.list<ValidationPlan>(this.pool,'ws_validation_plans',spaceId);}
  async validationPlan(spaceId:string,planId:string):Promise<ValidationPlan> {await this.access(this.pool,spaceId);return this.one<ValidationPlan>(this.pool,'ws_validation_plans',spaceId,planId);}
  private validationEntry(plan:ValidationPlan,entryId:string):ValidationEntry {
    const entry=plan.entries.find(item=>item.id===entryId);
    if(!entry) throw new Error('Validation entry not found in plan');
    return entry;
  }
  private async validationJudgeEvidence(db:DB,spaceId:string,review:Review,policy:ValidationJudgePolicy):Promise<{evidence:ValidationJudgeEvidence;observed:boolean}> {
    const differences:ValidationJudgeEvidence['differences']={};
    const diff=(field:string,expected:unknown,observed:unknown)=>{if(!sameJson(expected,observed)) differences[field]={expected,observed};};
    if(policy.kind==='human') return {evidence:{reviewId:review.id,verified:true,differences},observed:true};
    if(!review.judge.sessionId) return {evidence:{reviewId:review.id,verified:false,differences:{session:{expected:'observed Agent session',observed:null}}},observed:false};
    const session=await this.one<SessionRecord>(db,'ws_sessions',spaceId,review.judge.sessionId);
    if(session.role!==policy.id||session.completeness!=='complete') throw new Error('Agent judge source mismatch');
    const contexts=(await db.query<{id:string;document:NodeContext}>('SELECT id,document FROM ws_contexts WHERE space_id=$1 AND session_id=$2',[spaceId,session.id])).rows;
    if(!contexts.length||contexts.some(row=>row.document.producer!=='agent')) throw new Error('Agent judge observed context missing');
    let fullyObserved=true;
    const expectedProfileHash=typeof policy.instructions==='string'&&Array.isArray(policy.tools)?await hash({configuration:policy.configuration??{},instructions:policy.instructions,tools:policy.tools}):undefined;
    const observedProfiles:{configuration:Record<string,unknown>;instructions:string;tools:unknown}[]=[];
    if(typeof policy.instructions!=='string'||!Array.isArray(policy.tools)) {
      fullyObserved=false;
      differences.frozenProfile={expected:'frozen Agent instructions and tools',observed:null};
    }
    for(const row of contexts) {
      const context=row.document;
      diff('configuration',policy.configuration??{},context.effectiveConfig);
      if(typeof policy.instructions==='string') diff('contextInstructions',policy.instructions,context.instructions);
      const events=(await db.query<{document:SessionEvent}>(`SELECT document FROM ws_session_events WHERE space_id=$1 AND context_id=$2
        AND document->'body'->>'type'='siwc.started' ORDER BY seq`,[spaceId,row.id])).rows;
      if(events.length!==1) {
        fullyObserved=false;
        differences.toolProfileObservation={expected:'one trusted siwc.started event',observed:events.length};
        continue;
      }
      const body=events[0]!.document.body as {data?:{model?:unknown;instructions?:unknown;toolDefinitions?:unknown;toolProfileHash?:unknown}};
      const observed=body.data;
      if(typeof observed?.instructions!=='string'||!Array.isArray(observed.toolDefinitions)||typeof observed.toolProfileHash!=='string') {
        fullyObserved=false;
        differences.toolProfileObservation={expected:'complete trusted SIWC profile',observed:observed??null};
        continue;
      }
      const actualHash=await hash(observed.toolDefinitions);
      observedProfiles.push({configuration:context.effectiveConfig,instructions:observed.instructions,tools:observed.toolDefinitions});
      if(typeof policy.configuration?.model==='string') diff('runnerModel',policy.configuration.model,observed.model);
      if(typeof policy.instructions==='string') diff('runnerInstructions',policy.instructions,observed.instructions);
      if(Array.isArray(policy.tools)) diff('tools',policy.tools,observed.toolDefinitions);
      diff('toolProfileHash',actualHash,observed.toolProfileHash);
      if(actualHash!==observed.toolProfileHash) fullyObserved=false;
    }
    if(observedProfiles.length>1&&observedProfiles.some(profile=>!sameJson(profile,observedProfiles[0]))) differences.sessionProfiles={expected:'same profile for all judge contexts',observed:observedProfiles};
    const observedProfileHash=fullyObserved&&observedProfiles.length?await hash(observedProfiles[0]):undefined;
    return {evidence:{reviewId:review.id,verified:fullyObserved&&Object.keys(differences).length===0,
      ...(expectedProfileHash?{expectedProfileHash}:{}),...(observedProfileHash?{observedProfileHash}:{}),differences},observed:fullyObserved};
  }
  async linkValidationRun(spaceId:string,planId:string,input:{entryId:string;runId:string;attempt?:number}):Promise<ValidationRunLink> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const plan=await this.one<ValidationPlan>(db,'ws_validation_plans',spaceId,planId);
      if(plan.status!=='frozen') throw new Error('Validation plan is not frozen');
      const entry=this.validationEntry(plan,input.entryId);
      const run=await this.one<SpaceRun>(db,'ws_runs',spaceId,input.runId,'run_id');
      if(run.caseId!==entry.caseId||run.inputManifestId!==entry.inputManifestId||run.workflowVersionId!==entry.workflowVersionId||run.entrypoint!==entry.entrypoint) throw new Error('Validation run binding mismatch');
      const version=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,entry.workflowVersionId);
      if(!sameJson(run.effectiveConfig,version.config)||run.configHash!==await hash(run.effectiveConfig)) throw new Error('Validation run effective conditions mismatch');
      const native=await db.query<{created_at:string}>('SELECT created_at::text FROM aw_runs WHERE workspace_id=$1 AND id=$2',[spaceId,input.runId]);
      if(plan.kind==='prospective'&&BigInt(native.rows[0]!.created_at)<=BigInt(plan.frozenRunOrdinal??'0')) throw new Error('Prospective plan cannot link pre-freeze run');
      const attempt=input.attempt??1;
      if(!Number.isInteger(attempt)||attempt<1) throw new Error('Validation attempt must be positive integer');
      const sequence=await db.query<{maximum:number}>('SELECT COALESCE(MAX(attempt),0)::integer AS maximum FROM ws_validation_runs WHERE space_id=$1 AND plan_id=$2 AND entry_id=$3',[spaceId,planId,input.entryId]);
      if(attempt>sequence.rows[0]!.maximum+1) throw new Error('Validation attempts must be sequential');
      const prior=await db.query<{run_id:string;linked_at:Date}>('SELECT run_id,linked_at FROM ws_validation_runs WHERE space_id=$1 AND plan_id=$2 AND entry_id=$3 AND attempt=$4',[spaceId,planId,input.entryId,attempt]);
      if(prior.rows[0]) {
        if(prior.rows[0].run_id!==input.runId) throw new Error('Validation attempt already linked to another run');
        return {entryId:input.entryId,runId:input.runId,attempt,linkedAt:prior.rows[0].linked_at.toISOString()};
      }
      const inserted=await db.query<{linked_at:Date}>('INSERT INTO ws_validation_runs(space_id,plan_id,entry_id,attempt,run_id) VALUES($1,$2,$3,$4,$5) RETURNING linked_at',[spaceId,planId,input.entryId,attempt,input.runId]);
      return {entryId:input.entryId,runId:input.runId,attempt,linkedAt:inserted.rows[0]!.linked_at.toISOString()};
    });
  }
  async linkValidationReview(spaceId:string,planId:string,input:{entryId:string;runId:string;reviewId:string}):Promise<ValidationReviewLink> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const plan=await this.one<ValidationPlan>(db,'ws_validation_plans',spaceId,planId);
      if(plan.status!=='frozen') throw new Error('Validation plan is not frozen');
      this.validationEntry(plan,input.entryId);
      const linked=await db.query('SELECT 1 FROM ws_validation_runs WHERE space_id=$1 AND plan_id=$2 AND entry_id=$3 AND run_id=$4',[spaceId,planId,input.entryId,input.runId]);
      if(!linked.rows.length) throw new Error('Review run is not linked to validation entry');
      const review=await this.one<Review>(db,'ws_reviews',spaceId,input.reviewId);
      if(review.runId!==input.runId) throw new Error('Validation review source run mismatch');
      if(!sameJson(review.standard,plan.standard)) throw new Error('Validation review standard changed');
      const policy=plan.judges.find(judge=>judge.kind===review.judge.kind&&judge.id===review.judge.id);
      if(!policy) throw new Error('Validation judge identity is outside frozen policy');
      const profile=await this.validationJudgeEvidence(db,spaceId,review,policy);
      if(profile.observed&&!profile.evidence.verified) throw new Error(`Validation judge observed profile mismatch: ${Object.keys(profile.evidence.differences).join(', ')}`);
      if(review.judge.kind==='human'&&(review.judge.id!==this.principal.id||this.principal.kind!=='human')) {
        // A different human's existing review may be linked by an authorized operator after checking its authenticated source.
        const member=await db.query('SELECT 1 FROM ws_members WHERE space_id=$1 AND principal_id=$2',[spaceId,review.judge.id]);
        if(!member.rows.length) throw new Error('Human judge identity is not a Space member');
      }
      const prior=await db.query<{linked_at:Date;run_id:string;policy_verified:boolean|null;policy_differences:ValidationJudgeEvidence['differences']|null;expected_profile_hash:string|null;observed_profile_hash:string|null}>('SELECT linked_at,run_id,policy_verified,policy_differences,expected_profile_hash,observed_profile_hash FROM ws_validation_reviews WHERE space_id=$1 AND plan_id=$2 AND entry_id=$3 AND review_id=$4',[spaceId,planId,input.entryId,input.reviewId]);
      if(prior.rows[0]) {
        if(prior.rows[0].run_id!==input.runId) throw new Error('Validation review link mismatch');
        return {...input,linkedAt:prior.rows[0].linked_at.toISOString(),judgeEvidence:{reviewId:review.id,verified:prior.rows[0].policy_verified??(review.judge.kind==='human'),
          ...(prior.rows[0].expected_profile_hash?{expectedProfileHash:prior.rows[0].expected_profile_hash}:{}),
          ...(prior.rows[0].observed_profile_hash?{observedProfileHash:prior.rows[0].observed_profile_hash}:{}),differences:prior.rows[0].policy_differences??{}}};
      }
      const inserted=await db.query<{linked_at:Date}>('INSERT INTO ws_validation_reviews(space_id,plan_id,entry_id,run_id,review_id,policy_verified,policy_differences,expected_profile_hash,observed_profile_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING linked_at',[spaceId,planId,input.entryId,input.runId,input.reviewId,profile.evidence.verified,json(profile.evidence.differences),profile.evidence.expectedProfileHash??null,profile.evidence.observedProfileHash??null]);
      return {...input,linkedAt:inserted.rows[0]!.linked_at.toISOString(),judgeEvidence:profile.evidence};
    });
  }
  async compareValidationEntries(spaceId:string,planId:string,input:{id:string;baselineEntryId:string;candidateEntryId:string;baselineReviewId:string;candidateReviewId:string;conclusion:string}):Promise<ValidationComparison> {
    await this.access(this.pool,spaceId,writers,true);
    const plan=await this.validationPlan(spaceId,planId);
    if(plan.status!=='frozen') throw new Error('Validation plan is not frozen');
    const baseline=this.validationEntry(plan,input.baselineEntryId),candidate=this.validationEntry(plan,input.candidateEntryId);
    if(baseline.side!=='baseline'||candidate.side!=='candidate'||baseline.caseId!==candidate.caseId||baseline.repeat!==candidate.repeat||baseline.inputManifestId!==candidate.inputManifestId) throw new Error('Validation entries are not a frozen pair');
    const links=await this.pool.query<{entry_id:string;review_id:string;run_id:string;policy_verified:boolean|null}>('SELECT entry_id,review_id,run_id,policy_verified FROM ws_validation_reviews WHERE space_id=$1 AND plan_id=$2 AND review_id=ANY($3::text[])',[spaceId,planId,[input.baselineReviewId,input.candidateReviewId]]);
    const a=links.rows.find(row=>row.entry_id===baseline.id&&row.review_id===input.baselineReviewId),b=links.rows.find(row=>row.entry_id===candidate.id&&row.review_id===input.candidateReviewId);
    if(!a||!b) throw new Error('Validation comparison reviews must be linked to paired entries');
    const reviews=await Promise.all([this.one<Review>(this.pool,'ws_reviews',spaceId,a.review_id),this.one<Review>(this.pool,'ws_reviews',spaceId,b.review_id)]);
    if((reviews[0].judge.kind==='agent'&&a.policy_verified!==true)||(reviews[1].judge.kind==='agent'&&b.policy_verified!==true)) throw new Error('Validation comparison requires verified Agent judge profiles');
    if(!sameJson(reviews[0].standard,reviews[1].standard)||!sameJson(reviews[0].standard,plan.standard)) throw new Error('Validation comparison standard mismatch');
    if(reviews[0].judge.kind!==reviews[1].judge.kind||reviews[0].judge.id!==reviews[1].judge.id) throw new Error('Validation comparison judge mismatch');
    const runs=await Promise.all([this.one<SpaceRun>(this.pool,'ws_runs',spaceId,a.run_id,'run_id'),this.one<SpaceRun>(this.pool,'ws_runs',spaceId,b.run_id,'run_id')]);
    const strip=(config:Record<string,unknown>)=>Object.fromEntries(Object.entries(config).filter(([key])=>!plan.expectedVariables.includes(key)));
    if(!sameJson(strip(runs[0].effectiveConfig),strip(runs[1].effectiveConfig))) throw new Error('Validation comparison has undeclared changed conditions');
    const comparison=await this.compare(spaceId,{id:input.id,baselineReviewId:input.baselineReviewId,candidateReviewId:input.candidateReviewId,conclusion:input.conclusion});
    const value:ValidationComparison={...clone(input),comparison};
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const old=await db.query<{document:ValidationComparison}>('SELECT document FROM ws_validation_comparisons WHERE space_id=$1 AND plan_id=$2 AND id=$3',[spaceId,planId,input.id]);
      if(old.rows[0]) {
        if(!sameJson(old.rows[0].document,value)) throw new Error('Validation comparison ID conflict');
        return old.rows[0].document;
      }
      await db.query('INSERT INTO ws_validation_comparisons(space_id,plan_id,id,comparison_id,document) VALUES($1,$2,$3,$4,$5::jsonb)',[spaceId,planId,input.id,comparison.id,json(value)]);
      return value;
    });
  }
  async excludeValidationEntry(spaceId:string,planId:string,input:{entryId:string;rule:string;reason:string}):Promise<void> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const plan=await this.one<ValidationPlan>(db,'ws_validation_plans',spaceId,planId);
      if(plan.status!=='frozen') throw new Error('Validation plan is not frozen');
      this.validationEntry(plan,input.entryId);
      required(input.rule,'Exclusion rule');required(input.reason,'Exclusion reason');
      if(!plan.exclusionRules.includes(input.rule)) throw new Error('Exclusion rule was not frozen in plan');
      const old=await db.query<{rule:string;reason:string}>('SELECT rule,reason FROM ws_validation_exclusions WHERE space_id=$1 AND plan_id=$2 AND entry_id=$3',[spaceId,planId,input.entryId]);
      if(old.rows[0]) {
        if(old.rows[0].rule!==input.rule||old.rows[0].reason!==input.reason) throw new Error('Validation exclusion is immutable');
        return;
      }
      await db.query('INSERT INTO ws_validation_exclusions(space_id,plan_id,entry_id,rule,reason) VALUES($1,$2,$3,$4,$5)',[spaceId,planId,input.entryId,input.rule,input.reason]);
    });
  }
  async recordValidationIssue(spaceId:string,planId:string,draft:ValidationIssueDraft):Promise<ValidationIssue> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const plan=await this.one<ValidationPlan>(db,'ws_validation_plans',spaceId,planId);
      if(plan.status!=='frozen') throw new Error('Validation plan is not frozen');
      for(const value of [draft.id,draft.category,draft.text]) required(value,'Validation issue field');
      if(!['observation','cause-hypothesis'].includes(draft.kind)||!draft.evidence?.length) throw new Error('Validation issue needs kind and evidence');
      for(const evidence of draft.evidence) {
        const entry=this.validationEntry(plan,evidence.entryId);
        if(entry.caseId!==evidence.caseId) throw new Error('Validation issue case mismatch');
        if(evidence.runId) {
          const link=await db.query('SELECT 1 FROM ws_validation_runs WHERE space_id=$1 AND plan_id=$2 AND entry_id=$3 AND run_id=$4',[spaceId,planId,entry.id,evidence.runId]);
          if(!link.rows.length) throw new Error('Validation issue run is not linked');
        }
        if(evidence.nodeId) {
          const version=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,entry.workflowVersionId);
          const declared=version.entrypoints[entry.entrypoint]?.storageContract.nodes;
          if(!declared||!Object.hasOwn(declared,evidence.nodeId)) throw new Error('Validation issue node is not in frozen method');
        }
      }
      const old=await db.query<{document:ValidationIssue}>('SELECT document FROM ws_validation_issues WHERE space_id=$1 AND plan_id=$2 AND id=$3',[spaceId,planId,draft.id]);
      if(old.rows[0]) {
        const {spaceId:_spaceId,planId:_planId,createdAt:_createdAt,...oldDraft}=old.rows[0].document;
        if(!sameJson(oldDraft,draft)) throw new Error('Validation issue ID conflict');
        return old.rows[0].document;
      }
      const value:ValidationIssue={...clone(draft),spaceId,planId,createdAt:now()};
      await db.query('INSERT INTO ws_validation_issues(space_id,plan_id,id,document) VALUES($1,$2,$3,$4::jsonb)',[spaceId,planId,draft.id,json(value)]);
      return value;
    });
  }
  async validationSummary(spaceId:string,planId:string):Promise<ValidationSummary> {
    const plan=await this.validationPlan(spaceId,planId);
    const [links,reviews,taskRows,nativeRows,issues,comparisons,exclusions]=await Promise.all([
      this.pool.query<{entry_id:string;attempt:number;run_id:string}>('SELECT entry_id,attempt,run_id FROM ws_validation_runs WHERE space_id=$1 AND plan_id=$2 ORDER BY entry_id,attempt',[spaceId,planId]),
      this.pool.query<{entry_id:string;run_id:string;document:Review;policy_verified:boolean|null;policy_differences:ValidationJudgeEvidence['differences']|null;expected_profile_hash:string|null;observed_profile_hash:string|null}>('SELECT l.entry_id,l.run_id,l.policy_verified,l.policy_differences,l.expected_profile_hash,l.observed_profile_hash,r.document FROM ws_validation_reviews l JOIN ws_reviews r ON r.space_id=l.space_id AND r.id=l.review_id WHERE l.space_id=$1 AND l.plan_id=$2',[spaceId,planId]),
      this.pool.query<{run_id:string;status:string;error:string|null}>(`SELECT t.run_id,
        CASE WHEN t.status IN ('running','cancel_requested') AND t.lease_expires_at<=now() THEN 'interrupted' ELSE t.status END AS status,
        t.error FROM ws_execution_tasks t JOIN ws_validation_runs l ON l.space_id=t.space_id AND l.run_id=t.run_id
        WHERE l.space_id=$1 AND l.plan_id=$2`,[spaceId,planId]),
      this.pool.query<{run_id:string;document:RunRecord}>('SELECT a.id AS run_id,a.document FROM aw_runs a JOIN ws_validation_runs l ON l.space_id=a.workspace_id AND l.run_id=a.id WHERE l.space_id=$1 AND l.plan_id=$2',[spaceId,planId]),
      this.pool.query<{document:ValidationIssue}>('SELECT document FROM ws_validation_issues WHERE space_id=$1 AND plan_id=$2',[spaceId,planId]),
      this.pool.query<{document:ValidationComparison}>('SELECT document FROM ws_validation_comparisons WHERE space_id=$1 AND plan_id=$2',[spaceId,planId]),
      this.pool.query<{entry_id:string;reason:string}>('SELECT entry_id,reason FROM ws_validation_exclusions WHERE space_id=$1 AND plan_id=$2',[spaceId,planId]),
    ]);
    const taskByRun=new Map(taskRows.rows.map(row=>[row.run_id,row]));
    const nativeByRun=new Map(nativeRows.rows.map(row=>[row.run_id,row.document]));
    const exclusionByEntry=new Map(exclusions.rows.map(row=>[row.entry_id,row.reason]));
    const entries:ValidationEntrySummary[]=plan.entries.map(entry=>{
      const attempts=links.rows.filter(link=>link.entry_id===entry.id).map(link=>{
        const task=taskByRun.get(link.run_id),run=nativeByRun.get(link.run_id);
        return {attempt:link.attempt,runId:link.run_id,status:task?.status??run?.state??'pending',
          ...(task?{task:{status:task.status,...(task.error?{error:task.error}:{})}}:{}),
          ...(run?{run:{state:run.state,...(run.error?{error:run.error}:{})}}:{}),
          reviews:reviews.rows.filter(review=>review.entry_id===entry.id&&review.run_id===link.run_id).map(review=>review.document),
          judgeEvidence:reviews.rows.filter(review=>review.entry_id===entry.id&&review.run_id===link.run_id).map(review=>({reviewId:review.document.id,verified:review.policy_verified??(review.document.judge.kind==='human'),
            ...(review.expected_profile_hash?{expectedProfileHash:review.expected_profile_hash}:{}),...(review.observed_profile_hash?{observedProfileHash:review.observed_profile_hash}:{}),
            differences:review.policy_differences??(review.document.judge.kind==='agent'?{legacyProfile:{expected:'trusted runner profile',observed:null}}:{})}))};
      });
      const recent=attempts.at(-1);
      let status:ValidationEntrySummary['status'];
      const requiredJudgeCoverage=plan.judges.map(judge=>({kind:judge.kind,id:judge.id,
        reviewIds:(recent?.reviews??[]).filter(review=>review.judge.kind===judge.kind&&review.judge.id===judge.id&&recent?.judgeEvidence.some(evidence=>evidence.reviewId===review.id&&evidence.verified)).map(review=>review.id),
        unverifiedReviewIds:(recent?.reviews??[]).filter(review=>review.judge.kind===judge.kind&&review.judge.id===judge.id&&!recent?.judgeEvidence.some(evidence=>evidence.reviewId===review.id&&evidence.verified)).map(review=>review.id)}));
      if(entry.excludedReason||exclusionByEntry.has(entry.id)) status='excluded';
      else if(!recent) status='missing';
      else if(recent.task&&['failed','canceled','interrupted','cancel_requested'].includes(recent.task.status)) status=recent.task.status as ValidationEntrySummary['status'];
      else if(recent.run&&['failed','canceled'].includes(recent.run.state)) status=recent.run.state as ValidationEntrySummary['status'];
      else if(recent.task&&['queued','running'].includes(recent.task.status)) status=recent.task.status as ValidationEntrySummary['status'];
      else if(recent.run?.state==='queued') status='queued';
      else if(recent.run?.state==='running') status='running';
      else if(recent.run&&['waiting','blocked'].includes(recent.run.state)) status='pending';
      else if(recent.task&&recent.task.status!=='completed') status='pending';
      else if(recent.run&&['succeeded','needs_review'].includes(recent.run.state)) status=requiredJudgeCoverage.every(judge=>judge.reviewIds.length>0)?'reviewed':'needs_review';
      else status='pending';
      return {entry:{...entry,...(exclusionByEntry.has(entry.id)?{excludedReason:exclusionByEntry.get(entry.id)}:{})},status,requiredJudgeCoverage,attempts};
    });
    const caseIds=plan.cases.map(item=>item.caseId);
    const pairs=plan.cases.flatMap(item=>Array.from({length:item.repeats},(_,index)=>{
      const repeat=index+1;
      const a=entries.find(row=>row.entry.caseId===item.caseId&&row.entry.repeat===repeat&&row.entry.side==='baseline')!;
      const b=entries.find(row=>row.entry.caseId===item.caseId&&row.entry.repeat===repeat&&row.entry.side==='candidate')!;
      const matched=comparisons.rows.map(row=>row.document).filter(row=>row.baselineEntryId===a.entry.id&&row.candidateEntryId===b.entry.id);
      const requiredJudgeCoverage=plan.judges.map(judge=>({kind:judge.kind,id:judge.id,comparisonIds:matched.filter(row=>{
        const baseline=a.attempts.at(-1)?.reviews.find(review=>review.id===row.baselineReviewId&&review.judge.kind===judge.kind&&review.judge.id===judge.id&&a.attempts.at(-1)?.judgeEvidence.some(evidence=>evidence.reviewId===review.id&&evidence.verified));
        const candidate=b.attempts.at(-1)?.reviews.find(review=>review.id===row.candidateReviewId&&review.judge.kind===judge.kind&&review.judge.id===judge.id&&b.attempts.at(-1)?.judgeEvidence.some(evidence=>evidence.reviewId===review.id&&evidence.verified));
        return !!baseline&&!!candidate;
      }).map(row=>row.id)}));
      const changedConditions:Record<string,{baseline:unknown;candidate:unknown}>={workflowVersion:{baseline:a.entry.workflowVersionId,candidate:b.entry.workflowVersionId}};
      for(const item of matched) Object.assign(changedConditions,item.comparison.changedConditions);
      return {caseId:item.caseId,repeat,baselineEntryId:a.entry.id,candidateEntryId:b.entry.id,
        status:(a.status==='excluded'||b.status==='excluded'?'excluded':a.status==='reviewed'&&b.status==='reviewed'&&requiredJudgeCoverage.every(judge=>judge.comparisonIds.length>0)?'compared':a.status==='missing'||b.status==='missing'?'missing':'pending') as 'excluded'|'compared'|'missing'|'pending',
        comparisonIds:matched.map(row=>row.id),requiredJudgeCoverage,changedConditions};
    }));
    const cases=caseIds.map(caseId=>({caseId,baselineEntryIds:entries.filter(row=>row.entry.caseId===caseId&&row.entry.side==='baseline').map(row=>row.entry.id),
      candidateEntryIds:entries.filter(row=>row.entry.caseId===caseId&&row.entry.side==='candidate').map(row=>row.entry.id),
      status:pairs.filter(pair=>pair.caseId===caseId).every(pair=>pair.status==='compared')?'compared':pairs.filter(pair=>pair.caseId===caseId).every(pair=>pair.status==='excluded')?'excluded':'incomplete'}));
    const byStatus=Object.fromEntries(validationStatuses.map(status=>[status,entries.filter(row=>row.status===status).length])) as ValidationSummary['totals']['byStatus'];
    return {plan,entries,cases,pairs,totals:{cases:caseIds.length,plannedPairs:pairs.length,entries:entries.length,attempts:entries.reduce((sum,row)=>sum+row.attempts.length,0),byStatus},issues:issues.rows.map(row=>row.document),comparisons:comparisons.rows.map(row=>row.document)};
  }
  async runtimeLedger(spaceId:string):Promise<PostgresWorkflowRunStore> {
    await this.access(this.pool,spaceId,writers,true); return this.ledger(spaceId);
  }
  async runtimeEvidence(spaceId:string):Promise<Pick<PostgresWorkflowRunStore,'getRun'|'getArtifact'|'listArtifacts'|'listSteps'|'listEvents'|'listAttempts'>> {
    await this.access(this.pool,spaceId);
    const ledger=this.ledger(spaceId);
    const checkRun=async (runId:string):Promise<void> => {
      await this.access(this.pool,spaceId);
      await this.one<SpaceRun>(this.pool,'ws_runs',spaceId,runId,'run_id');
    };
    const checkStep=async (stepRunId:string):Promise<void> => {
      await this.access(this.pool,spaceId);
      const result=await this.pool.query<{run_id:string}>('SELECT run_id FROM aw_steps WHERE workspace_id=$1 AND id=$2',[spaceId,stepRunId]);
      if (!result.rows[0]) throw new Error('Step not found in authorized space');
      await checkRun(result.rows[0].run_id);
    };
    return {
      getRun:async id=>{await checkRun(id);return ledger.getRun(id);},
      getArtifact:async id=>{
        await this.access(this.pool,spaceId);
        const artifact=await ledger.getArtifact(id);
        if (artifact) await checkRun(artifact.producedBy.workflowRunId);
        return artifact;
      },
      listArtifacts:async runId=>{await checkRun(runId);return ledger.listArtifacts(runId);},
      listSteps:async runId=>{await checkRun(runId);return ledger.listSteps(runId);},
      listEvents:async (runId,afterSeq)=>{await checkRun(runId);return ledger.listEvents(runId,afterSeq);},
      listAttempts:async stepRunId=>{await checkStep(stepRunId);return ledger.listAttempts(stepRunId);},
    };
  }
  async bindRuntimeRun(spaceId:string, config:{workflowVersionId:string;entrypoint:string;inputManifestId:string}, draft:Omit<RunRecord,'id'>):Promise<RunRecord> {
    return this.tx(db=>this.bindRuntimeRunInTransaction(db,spaceId,config,draft));
  }
  private async bindRuntimeRunInTransaction(db:PoolClient,spaceId:string,config:{workflowVersionId:string;entrypoint:string;inputManifestId:string}, draft:Omit<RunRecord,'id'>):Promise<RunRecord> {
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const version=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,config.workflowVersionId),entry=version.entrypoints[config.entrypoint];
      if(!entry || entry.workflowId!==draft.workflowId || entry.codeRevision!==draft.workflowRevision) throw new Error('Executable identity does not match frozen entrypoint');
      const manifest=await this.one<InputManifest>(db,'ws_manifests',spaceId,config.inputManifestId);
      const commandKey = draft.metadata?.commandKey;
      const commandFingerprint = draft.metadata?.commandFingerprint;
      if (commandKey !== undefined || commandFingerprint !== undefined) {
        if (typeof commandKey !== 'string' || !commandKey.trim() || typeof commandFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(commandFingerprint)) {
          throw new Error('Runtime command key and fingerprint must both be valid');
        }
        const committed = await db.query<{request_hash:string;receipt:{runId:string}}>(
          'SELECT request_hash,receipt FROM ws_commits WHERE space_id=$1 AND scope=$2 AND idempotency_key=$3',
          [spaceId,'runtimeCommand',commandKey]);
        if (committed.rows[0]) {
          if (committed.rows[0].request_hash !== commandFingerprint) throw new Error('Runtime command key conflicts with a different request');
          const bound = await this.one<SpaceRun>(db,'ws_runs',spaceId,committed.rows[0].receipt.runId,'run_id');
          if (bound.workflowVersionId !== config.workflowVersionId || bound.entrypoint !== config.entrypoint ||
              bound.caseId !== manifest.caseId || bound.inputManifestId !== config.inputManifestId) {
            throw new Error('Runtime command key conflicts with a different binding');
          }
          throw new RuntimeCommandAlreadyStartedError(committed.rows[0].receipt.runId);
        }
        // Old runs may predate ws_commits receipts. The Space row lock also serializes them with new claims.
        const legacy = await db.query<{run_id:string;fingerprint:string}>(
          `SELECT r.run_id, a.document->'metadata'->>'commandFingerprint' AS fingerprint
           FROM ws_runs r JOIN aw_runs a ON a.workspace_id=r.space_id AND a.id=r.run_id
           WHERE r.space_id=$1 AND a.document->'metadata'->>'commandKey'=$2`,[spaceId,commandKey]);
        if (legacy.rows.length) {
          if (legacy.rows.some(row => row.fingerprint !== commandFingerprint)) throw new Error('Runtime command key conflicts with a different request');
          const bound = await this.one<SpaceRun>(db,'ws_runs',spaceId,legacy.rows[0]!.run_id,'run_id');
          if (bound.workflowVersionId !== config.workflowVersionId || bound.entrypoint !== config.entrypoint ||
              bound.caseId !== manifest.caseId || bound.inputManifestId !== config.inputManifestId) {
            throw new Error('Runtime command key conflicts with a different binding');
          }
          throw new RuntimeCommandAlreadyStartedError(legacy.rows[0]!.run_id);
        }
      }
      const run=await this.ledger(spaceId).inTransaction(db).createRun(draft);
      const binding:SpaceRun={runId:run.id,spaceId,workflowVersionId:version.id,entrypoint:config.entrypoint,caseId:manifest.caseId,inputManifestId:manifest.id,effectiveConfig:version.config,configHash:await hash(version.config),
        ...(entry.process?{process:{revision:entry.process.revision,hash:entry.process.hash}}:{})};
      await db.query('INSERT INTO ws_runs(space_id,run_id,workflow_version_id,case_id,manifest_id,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[spaceId,run.id,version.id,manifest.caseId,manifest.id,json(binding)]);
      if (typeof commandKey === 'string' && typeof commandFingerprint === 'string') {
        await db.query('INSERT INTO ws_commits(space_id,scope,idempotency_key,request_hash,receipt) VALUES($1,$2,$3,$4,$5::jsonb)',
          [spaceId,'runtimeCommand',commandKey,commandFingerprint,json({runId:run.id})]);
      }
      return run;
  }
  private async executionRow(db:DB,spaceId:string,runId:string):Promise<ExecutionRow|undefined> {
    return (await db.query<ExecutionRow>(`SELECT *, (status IN ('running','cancel_requested') AND lease_expires_at<=now()) AS lease_expired
      FROM ws_execution_tasks WHERE space_id=$1 AND run_id=$2`,[spaceId,runId])).rows[0];
  }
  async enqueueExecution(spaceId:string,binding:{workflowVersionId:string;entrypoint:string;inputManifestId:string},draft:Omit<RunRecord,'id'>,options:{executorKey:string}):Promise<{task:ExecutionTask;run:RunRecord}> {
    required(options.executorKey,'Executor key');
    if(draft.state!=='queued') throw new Error('Execution must start queued');
    const key=draft.metadata?.commandKey,fingerprint=draft.metadata?.commandFingerprint;
    if(typeof key!=='string'||!key.trim()||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Execution requires a valid command key and fingerprint');
    const requestHash=await hash({binding,draft,executorKey:options.executorKey});
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const prior=await db.query<{request_hash:string;receipt:{runId:string}}>('SELECT request_hash,receipt FROM ws_commits WHERE space_id=$1 AND scope=$2 AND idempotency_key=$3',[spaceId,'runtimeCommand',key]);
      if(prior.rows[0]) {
        if(prior.rows[0].request_hash!==fingerprint) throw new Error('Runtime command key conflicts with a different request');
        const task=await this.executionRow(db,spaceId,prior.rows[0].receipt.runId);
        if(!task||task.request_hash!==requestHash) throw new Error('Execution command conflicts with a different request');
        const run=await this.ledger(spaceId).inTransaction(db).getRun(task.run_id);
        if(!run) throw new Error('Execution run receipt missing');
        return {task:executionTask(task),run};
      }
      const run=await this.bindRuntimeRunInTransaction(db,spaceId,binding,draft);
      const bound=await this.one<SpaceRun>(db,'ws_runs',spaceId,run.id,'run_id');
      const inserted=await db.query<ExecutionRow>(`INSERT INTO ws_execution_tasks
        (space_id,run_id,workflow_version_id,entrypoint,input_manifest_id,case_id,executor_key,request_hash,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`,
        [spaceId,run.id,binding.workflowVersionId,binding.entrypoint,binding.inputManifestId,bound.caseId,options.executorKey,requestHash]);
      await this.ledger(spaceId).inTransaction(db).appendEvent({runId:run.id,type:'execution.queued',data:{executorKey:options.executorKey}});
      return {task:executionTask(inserted.rows[0]!),run};
    });
  }
  async executionTasks(spaceId:string):Promise<ExecutionTask[]> {
    await this.access(this.pool,spaceId);
    return (await this.pool.query<ExecutionRow>(`SELECT *, (status IN ('running','cancel_requested') AND lease_expires_at<=now()) AS lease_expired
      FROM ws_execution_tasks WHERE space_id=$1 ORDER BY created_at,run_id`,[spaceId])).rows.map(executionTask);
  }
  async getExecutionTask(spaceId:string,runId:string):Promise<ExecutionTask|undefined> {
    await this.access(this.pool,spaceId);
    const row=await this.executionRow(this.pool,spaceId,runId);
    return row&&executionTask(row);
  }
  private async expireExecutions(db:PoolClient,spaceId:string):Promise<ExecutionTask[]> {
    const changed=await db.query<ExecutionRow>(`UPDATE ws_execution_tasks SET status='interrupted',updated_at=now(),error='Lease expired; execution outcome requires reconciliation'
      WHERE space_id=$1 AND status IN ('running','cancel_requested') AND lease_expires_at<=now() RETURNING *`,[spaceId]);
    for(const row of changed.rows) await this.ledger(spaceId).inTransaction(db).appendEvent({runId:row.run_id,type:'execution.interrupted',data:{owner:row.owner,reason:'lease_expired'}});
    return changed.rows.map(executionTask);
  }
  async reconcileExecutions(spaceId:string):Promise<ExecutionTask[]> {
    return this.tx(async db=>{await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);return this.expireExecutions(db,spaceId);});
  }
  async claimExecution(spaceId:string,options:{workerId:string;executorKeys:string[];concurrency:number;leaseMs:number;runId?:string}):Promise<ExecutionTask|undefined> {
    required(options.workerId,'Worker ID');
    if(options.runId!==undefined) required(options.runId,'Target run ID');
    if(!Number.isInteger(options.concurrency)||options.concurrency<1) throw new Error('Concurrency must be a positive integer');
    if(!Number.isFinite(options.leaseMs)||options.leaseMs<1000) throw new Error('Lease must be at least one second');
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const policy=await db.query<{concurrency:number}>('SELECT concurrency FROM ws_execution_limits WHERE space_id=$1',[spaceId]);
      if(policy.rows[0]&&policy.rows[0].concurrency!==options.concurrency) throw new Error('Space execution concurrency conflict');
      if(!policy.rows[0]) await db.query('INSERT INTO ws_execution_limits(space_id,concurrency) VALUES($1,$2)',[spaceId,options.concurrency]);
      await this.expireExecutions(db,spaceId);
      const active=await db.query<{count:string}>(`SELECT count(*) FROM ws_execution_tasks WHERE space_id=$1 AND status IN ('running','cancel_requested','interrupted')`,[spaceId]);
      if(Number(active.rows[0]!.count)>=options.concurrency||!options.executorKeys.length) return undefined;
      const token=randomUUID();
      const result=await db.query<ExecutionRow>(`UPDATE ws_execution_tasks SET status='running',owner=$3,claim_token=$4,
          lease_expires_at=now()+($5::double precision * interval '1 millisecond'),updated_at=now()
        WHERE (space_id,run_id)=(SELECT space_id,run_id FROM ws_execution_tasks
          WHERE space_id=$1 AND status='queued' AND executor_key=ANY($2::text[])
            AND ($6::text IS NULL OR run_id=$6) ORDER BY created_at,run_id LIMIT 1)
        RETURNING *`,[spaceId,options.executorKeys,options.workerId,token,options.leaseMs,options.runId??null]);
      if(result.rows[0]) await this.ledger(spaceId).inTransaction(db).appendEvent({runId:result.rows[0].run_id,type:'execution.claimed',data:{owner:options.workerId}});
      return result.rows[0]&&executionTask(result.rows[0]);
    });
  }
  async heartbeatExecution(spaceId:string,runId:string,claimToken:string,leaseMs:number):Promise<ExecutionTask> {
    if(!Number.isFinite(leaseMs)||leaseMs<1000) throw new Error('Lease must be at least one second');
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const row=await this.executionRow(db,spaceId,runId);
      if(!row||row.claim_token!==claimToken||!['running','cancel_requested'].includes(row.status)) throw new Error('Execution claim is not active');
      const updated=await db.query<ExecutionRow>(`UPDATE ws_execution_tasks SET lease_expires_at=now()+($3::double precision * interval '1 millisecond'),updated_at=now()
        WHERE space_id=$1 AND run_id=$2 AND lease_expires_at>now() RETURNING *`,[spaceId,runId,leaseMs]);
      if(!updated.rows[0]) throw new Error('Execution claim is not active');
      return executionTask(updated.rows[0]!);
    });
  }
  async cancelExecution(spaceId:string,runId:string):Promise<ExecutionTask> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      await this.expireExecutions(db,spaceId);
      const row=await this.executionRow(db,spaceId,runId);
      if(!row) throw new Error('Execution task not found');
      if(row.status==='queued') {
        const ledger=this.ledger(spaceId).inTransaction(db);
        await ledger.updateRun(runId,{state:'canceled'});
        await ledger.appendEvent({runId,type:'workflow.canceled',data:{reason:'Canceled before execution'}});
        await ledger.appendEvent({runId,type:'execution.canceled',data:{actorId:this.principal.id,reason:'queued_cancel'}});
        const updated=await db.query<ExecutionRow>("UPDATE ws_execution_tasks SET status='canceled',updated_at=now() WHERE space_id=$1 AND run_id=$2 RETURNING *",[spaceId,runId]);
        return executionTask(updated.rows[0]!);
      }
      if(row.status==='running') {
        await this.ledger(spaceId).inTransaction(db).appendEvent({runId,type:'execution.cancel_requested',data:{actorId:this.principal.id}});
        const updated=await db.query<ExecutionRow>("UPDATE ws_execution_tasks SET status='cancel_requested',updated_at=now() WHERE space_id=$1 AND run_id=$2 RETURNING *",[spaceId,runId]);
        return executionTask(updated.rows[0]!);
      }
      return executionTask(row);
    });
  }
  async finishExecution(spaceId:string,runId:string,claimToken:string,result:{status:'completed'|'failed'|'canceled';error?:string}):Promise<ExecutionTask> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const row=await this.executionRow(db,spaceId,runId);
      if(!row||row.claim_token!==claimToken||!['running','cancel_requested','interrupted'].includes(row.status)) throw new Error('Execution claim token rejected');
      const ledger=this.ledger(spaceId).inTransaction(db),run=await ledger.getRun(runId);
      if(!run) throw new Error('Execution native run missing');
      if(result.status==='completed'&&['queued','running','failed','canceled'].includes(run.state)) throw new Error('Native run has not completed successfully');
      if(result.status==='failed'&&['succeeded','needs_review','blocked','canceled'].includes(run.state)) throw new Error('Native run outcome conflicts with failed task');
      if(result.status==='canceled'&&['succeeded','needs_review','blocked','failed'].includes(run.state)) throw new Error('Native run outcome conflicts with canceled task');
      if(result.status==='failed'&&['queued','running','waiting'].includes(run.state)) {
        await ledger.updateRun(runId,{state:'failed',error:result.error??'Executor failed'});
        await ledger.appendEvent({runId,type:'workflow.failed',data:{error:result.error??'Executor failed'}});
      }
      if(result.status==='canceled'&&['queued','running','waiting'].includes(run.state)) {
        await ledger.updateRun(runId,{state:'canceled',error:result.error});
        await ledger.appendEvent({runId,type:'workflow.canceled',data:{error:result.error}});
      }
      const updated=await db.query<ExecutionRow>(`UPDATE ws_execution_tasks SET status=$3,error=$4,lease_expires_at=NULL,updated_at=now()
        WHERE space_id=$1 AND run_id=$2 RETURNING *`,[spaceId,runId,result.status,result.error??null]);
      await ledger.appendEvent({runId,type:`execution.${result.status}`,data:{owner:row.owner,...(result.error?{error:result.error}:{})}});
      return executionTask(updated.rows[0]!);
    });
  }
  async completeObservedAgent(spaceId:string,contextId:string,output:unknown,validation:ValidationState='valid'):Promise<void> {
    let invalidOutput: InvalidObservedOutputError | undefined;
    await this.tx(async db=> {
      await this.access(db,spaceId,writers,true);await this.lock(db,spaceId);
      const context=await this.one<NodeContext>(db,'ws_contexts',spaceId,contextId);
      if(context.executionPrincipalId!==this.principal.id || context.producer!=='agent') throw new Error('Agent recording capability denied');
      const ledger=this.ledger(spaceId).inTransaction(db);
      const attempt=(await ledger.listAttempts(context.stepRunId)).find(a=>a.id===context.attemptId);
      if(attempt?.state!=='running') throw new Error('Observed result requires a running Agent attempt');
      const {contract}=await this.runContract(db,spaceId,context.runId),registry=await this.registry(db,spaceId);
      const outputs=Object.entries(contract.nodes[context.nodeId]!.outputs);
      if(!outputs.length) throw new Error('Observed Agent result requires an output schema');
      try {
        for(const [slot,binding] of outputs) {
          if(binding.agentOutputSchema) validateAgentOutput(registry,contract,context.nodeId,slot,output,context.producer);
          else registry.validatePayload(binding.schema,output);
        }
      } catch(error) {
        if(!(error instanceof ContractValidationError)) throw error;
        const issues=error.issues.length?error.issues:[error.message];
        // Record the complete observed reply and schema failure before marking the
        // attempt failed. This transaction is the durable proof that no output passed.
        await this.appendSession(db,spaceId,context,'agent-result','message',{role:'assistant',output,validation:'invalid'});
        await this.appendSession(db,spaceId,context,'agent-validation','error',{message:error.message,issues});
        await ledger.updateAttempt(context.attemptId,{state:'failed',error:'Observed Agent output failed its registered schema'});
        await ledger.updateStep(context.stepRunId,{state:'failed',validation:'invalid',error:'Observed Agent output failed its registered schema'});
        await ledger.appendEvent({runId:context.runId,stepRunId:context.stepRunId,attemptId:context.attemptId,
          type:'space.agent.invalid_output',data:{contextId:context.id,issues}});
        await db.query("UPDATE ws_sessions SET document=jsonb_set(document,'{completeness}','\"complete\"') WHERE space_id=$1 AND id=$2",[spaceId,context.sessionId]);
        invalidOutput=new InvalidObservedOutputError(context.id,issues);
        return;
      }
      await this.appendSession(db,spaceId,context,'agent-result','message',{role:'assistant',output,validation});
      // Persist the observed response and the identical core completion in one transaction.
      // The core repeats this commit using the same key; no second model call is needed.
      await ledger.commitStepResult({stepRunId:context.stepRunId,attemptId:context.attemptId,
        idempotencyKey:`${context.runId}:${context.stepRunId}:${context.attemptId}:completion`,
        state:validation==='invalid'?'needs_review':'succeeded',validation,output,
        events:[{runId:context.runId,stepRunId:context.stepRunId,attemptId:context.attemptId,type:'step.completed',data:{validation}}]});
      await db.query("UPDATE ws_sessions SET document=jsonb_set(document,'{completeness}','\"complete\"') WHERE space_id=$1 AND id=$2",[spaceId,context.sessionId]);
    });
    if(invalidOutput) throw invalidOutput;
  }
  async commitRuntimeDecision(spaceId:string,commit:StepResultCommit,binding:import('./types.js').ProcessDecisionBinding):Promise<StepResultReceipt> {
    return this.tx(async db=>{
      await this.access(db,spaceId,writers,true);
      return this.idempotent(db,spaceId,`decision:${commit.stepRunId}:${commit.attemptId}`,commit.idempotencyKey,
        {commit,binding,actorId:this.principal.id},async()=>{
          const row=await db.query<{run_id:string}>('SELECT run_id FROM aw_steps WHERE workspace_id=$1 AND id=$2',[spaceId,commit.stepRunId]);
          if(!row.rows[0]) throw new Error('Decision step outside authorized Space');
          const {run}=await this.runContract(db,spaceId,row.rows[0].run_id);
          const workflow=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,run.workflowVersionId);
          const process=run.process?workflow.entrypoints[run.entrypoint]?.process:undefined;
          const node=process?.nodes.find(node=>node.id===binding.nodeId&&node.kind==='decision');
          const edge=process?.edges.find(edge=>edge.id===binding.edgeId&&edge.from===node?.id&&['condition','rework'].includes(edge.kind));
          if(!process||!node||!edge) throw new Error('Decision mapping requires a frozen decision node/edge');
          if(binding.round!==undefined&&(!Number.isInteger(binding.round)||binding.round<1)) throw new Error('Invalid decision business round');
          const ledger=this.ledger(spaceId).inTransaction(db),step=(await ledger.listSteps(run.runId)).find(step=>step.id===commit.stepRunId);
          const attempt=(await ledger.listAttempts(commit.stepRunId)).find(attempt=>attempt.id===commit.attemptId);
          if(step?.kind!=='decision'||attempt?.state!=='running'||commit.artifact||commit.state!=='succeeded'||commit.validation!=='valid') throw new Error('Decision source/receipt mismatch');
          const events=(await ledger.listEvents(run.runId)).filter(event=>event.type==='decision.recorded'&&event.stepRunId===step.id&&event.attemptId===attempt.id);
          const event=events.at(-1),raw=event?.data as {decision?:unknown}|undefined,data=raw?.decision??raw;
          const value=data as {route?:string;round?:number}|undefined;
          if(!event||await hash(data)!==await hash(commit.output)||
            (binding.observation?binding.observation.route!==value?.route||binding.observation.round!==value?.round||!binding.reason:edge.route!==value?.route)) throw new Error('Decision mapping does not match exact recorded payload/route');
          const observation:import('./types.js').ProcessDecisionObservation={runId:run.runId,stepRunId:step.id,attemptId:attempt.id,
            eventSeq:event.seq,processHash:process.hash,edgeId:edge.id,actorId:this.principal.id,
            annotation:{nodeId:node.id,...(binding.round!==undefined?{round:binding.round}:{}),...(value?.route?{route:value.route}:{})},
            ...(binding.reason?{reason:binding.reason}:{})};
          await db.query('INSERT INTO ws_process_decisions(space_id,run_id,step_run_id,attempt_id,event_seq,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
            [spaceId,run.runId,step.id,attempt.id,event.seq,json(observation)]);
          return ledger.commitStepResult(commit);
        });
    });
  }
  async commitRuntimePublication(spaceId:string,contextId:string,runtimeCommit:StepResultCommit,commit:NodeCommit):Promise<StepResultReceipt> {
    await this.submitNode(spaceId,contextId,commit,runtimeCommit);
    // The preceding transaction committed the core receipt together with domain versions.
    return this.ledger(spaceId).commitStepResult(runtimeCommit);
  }
  async resolveRuntimeArtifact(spaceId:string,artifactId:string):Promise<AssetVersion> {
    await this.access(this.pool,spaceId);
    const row=await this.pool.query<{version_id:string}>('SELECT version_id FROM ws_runtime_artifacts WHERE space_id=$1 AND artifact_id=$2',[spaceId,artifactId]);
    if(!row.rows[0]) throw new Error('Runtime artifact has no domain publication');
    return this.asset(this.pool,spaceId,row.rows[0].version_id);
  }
  async runtimeContexts(spaceId:string,runId:string):Promise<NodeContext[]> {
    await this.access(this.pool,spaceId);
    return (await this.pool.query<{document:NodeContext}>('SELECT document FROM ws_contexts WHERE space_id=$1 AND run_id=$2',[spaceId,runId])).rows.map(r=>r.document);
  }
  async runtimeProcessContract(spaceId:string,runId:string):Promise<import('./process-contract.js').ProcessContract|undefined> {
    await this.access(this.pool,spaceId); const {run}=await this.runContract(this.pool,spaceId,runId);
    if(!run.process) return undefined;
    const workflow=await this.one<WorkflowVersion>(this.pool,'ws_workflows',spaceId,run.workflowVersionId);
    return clone(workflow.entrypoints[run.entrypoint]?.process);
  }
  /** Frozen method process, or a clearly marked deterministic retrospective explanation. */
  async process(spaceId:string,runId:string):Promise<ProcessView> {
    await this.access(this.pool,spaceId);
    const {run}=await this.runContract(this.pool,spaceId,runId);
    const workflow=await this.one<WorkflowVersion>(this.pool,'ws_workflows',spaceId,run.workflowVersionId);
    const entry=workflow.entrypoints[run.entrypoint];
    if(!entry) throw new Error('Frozen entrypoint missing');
    if(run.process && (!entry.process || run.process.hash!==entry.process.hash || run.process.revision!==entry.process.revision))
      throw new Error('Frozen run process binding mismatch');
    const ledger=this.ledger(spaceId);
    const [steps,contexts,events,recordedRelations]=await Promise.all([
      ledger.listSteps(runId),this.runtimeContexts(spaceId,runId),ledger.listEvents(runId),projectRunRelations(this.pool,spaceId,runId)]);
    const attempts=(await Promise.all(steps.map(step=>ledger.listAttempts(step.id)))).flat();
    for(const context of contexts) {
      const {id:_id,hash:contextHash,...body}=context;
      if(context.runId!==runId||context.spaceId!==spaceId||!steps.some(step=>step.id===context.stepRunId)||
        !attempts.some(attempt=>attempt.id===context.attemptId&&attempt.stepRunId===context.stepRunId)||await hash(body)!==contextHash) throw new Error('Process context integrity mismatch');
    }
    const decisions=(await this.pool.query<{document:import('./types.js').ProcessDecisionObservation}>('SELECT document FROM ws_process_decisions WHERE space_id=$1 AND run_id=$2 ORDER BY event_seq',[spaceId,runId])).rows.map(row=>row.document);
    for(const observation of decisions) {
      const step=steps.find(step=>step.id===observation.stepRunId),event=events.find(event=>event.seq===observation.eventSeq);
      const edge=entry.process?.edges.find(edge=>edge.id===observation.edgeId&&edge.from===observation.annotation.nodeId);
      const raw=event?.data as {decision?:unknown}|undefined;
      if(!run.process||run.process.hash!==observation.processHash||!edge||step?.kind!=='decision'||event?.type!=='decision.recorded'||event.stepRunId!==step.id||event.attemptId!==observation.attemptId||await hash(step.output)!==await hash(raw?.decision??raw)) throw new Error('Recorded process decision integrity mismatch');
    }
    const outputRows=await this.pool.query<{context_id:string;slot:string;version_id:string}>(
      `SELECT o.context_id,o.slot,o.version_id FROM ws_output_bindings o JOIN ws_contexts c
       ON c.space_id=o.space_id AND c.id=o.context_id WHERE c.space_id=$1 AND c.run_id=$2`,[spaceId,runId]);
    const outputs=outputRows.rows.map(row=>({contextId:row.context_id,slot:row.slot,versionId:row.version_id}));
    let resolver;
    let contract=run.process?entry.process:undefined;
    let contractSource:ProcessView['contractSource']=contract?'method':'unknown';
    {
      const deployed=this.presentationOptions.processResolvers?.[entry.workflowId];
      if(deployed) {
        resolver=await deployed({run,workflow,steps,contexts,events});
        required(resolver.resolverVersion,'Historical resolver version');
        const resolvedContract=await publishProcessContract(resolver.contract,entry.storageContract);
        if(contract && contract.hash!==resolvedContract.hash) throw new Error('Resolver contract differs from frozen method process');
        if(!contract) {contract=resolvedContract;contractSource='retrospective';}
        if(new Set(resolver.mappings.map(map=>map.stepRunId)).size!==resolver.mappings.length) throw new Error('Duplicate historical mapping');
        for(const map of resolver.mappings) {
          const step=steps.find(item=>item.id===map.stepRunId);
          const node=contract.nodes.find(item=>item.id===map.annotation.nodeId);
          if(!step||!node) throw new Error('Historical process mapping has invalid step or node');
          required(map.evidence,'Historical mapping evidence');
          const observed=decisions.find(item=>item.stepRunId===map.stepRunId);
          if(observed&&await hash(observed.annotation)!==await hash(map.annotation)) throw new Error('Historical mapping conflicts with recorded decision');
          if(map.annotation.round!==undefined&&(!Number.isInteger(map.annotation.round)||map.annotation.round<1)) throw new Error('Invalid historical business round');
          const bound=contexts.filter(context=>context.stepRunId===step.id);
          for(const context of bound) if(node.storageNodeId!==context.nodeId || (context.process && await hash(context.process)!==await hash(map.annotation))) throw new Error('Historical process mapping conflicts with observed node');
          if(map.annotation.branch&&!contract.edges.some(edge=>['fork','join'].includes(edge.kind)&&(edge.branch??edge.route)===map.annotation.branch&&(edge.from===node.id||edge.to===node.id))) throw new Error('Historical process branch is not declared');
          if(map.annotation.route&&!contract.edges.some(edge=>edge.from===node.id&&edge.route===map.annotation.route&&['condition','rework'].includes(edge.kind))) throw new Error('Historical process route is not declared');
        }
        for(const route of resolver.routes??[]) {
          const edge=contract.edges.find(edge=>edge.id===route.edgeId);
          const event=events.find(event=>event.seq===route.eventSeq&&event.type==='decision.recorded');
          const raw=event?.data as {decision?:unknown}|undefined;
          const data=(raw?.decision??raw) as {route?:string;round?:number}|undefined;
          const mapped=resolver.mappings.find(map=>map.stepRunId===event?.stepRunId);
          const sourceStep=steps.find(step=>step.id===event?.stepRunId);
          if(!edge||!event||!['condition','rework'].includes(edge.kind)||
            (route.observation?route.observation.route!==data?.route||route.observation.round!==data?.round||!route.reason:edge.route!==data?.route)||
            (route.round!==undefined&&route.round!==(mapped?.annotation.round??data?.round))||
            (sourceStep&&await hash(sourceStep.output)!==await hash(data))||
            (route.stepRunId!==undefined&&route.stepRunId!==event.stepRunId))
            throw new Error('Historical route lacks a matching recorded decision');
        }
      }
    }
    const ids=new Set<string>([
      ...outputs.map(output=>output.versionId),
      ...contexts.flatMap(context=>Object.values(context.inputs).map(input=>input.assetVersionId)),
      ...recordedRelations.flatMap(relation=>[relation.from.assetVersionId,relation.to.assetVersionId]),
      ...(resolver?.relations??[]).flatMap(relation=>[relation.from.assetVersionId,relation.to.assetVersionId]),
    ]);
    const assets=ids.size?(await this.pool.query<{document:AssetVersion}>(
      'SELECT document FROM ws_asset_versions WHERE space_id=$1 AND id=ANY($2::text[])',[spaceId,[...ids]])).rows.map(row=>row.document):[];
    const registry=await this.registry(this.pool,spaceId);
    for(const asset of assets) {if(await hash(asset.payload)!==asset.payloadHash) throw new Error('Process asset integrity mismatch');registry.validatePayload(asset.schema,asset.payload);}
    const assetById=new Map(assets.map(asset=>[asset.id,asset]));
    for(const relation of resolver?.relations??[]) {
      const type=contract?.relationTypes?.find(item=>item.id===relation.typeId);
      const from=assetById.get(relation.from.assetVersionId),to=assetById.get(relation.to.assetVersionId);
      if(!type||!from||!to||relation.provenance!=='retrospective') throw new Error('Invalid historical relation');
      validateRelationEvent(type,from,to,relation.from.pointer,relation.to.pointer);
      if(relation.evidence.resolverVersion!==resolver!.resolverVersion || relation.evidence.runId!==runId) throw new Error('Historical relation lacks exact resolver/run evidence');
      // The relation may only describe exact assets bound to this run or its frozen inputs.
      const boundIds=new Set([...outputs.map(output=>output.versionId),...contexts.flatMap(context=>Object.values(context.inputs).map(input=>input.assetVersionId))]);
      if(!boundIds.has(from.id)||!boundIds.has(to.id)) throw new Error('Historical relation endpoint was not bound to the run');
    }
    return projectProcess({run,contract,contractSource,resolver,steps,attempts,contexts,outputs,assets,
      relations:await queryRelationFacts(this.pool,spaceId,{runId,extra:resolver?.relations}),events,decisions});
  }
  /** Append a human declaration, optionally replacing one previous fact without deleting history. */
  async recordRelation(spaceId:string,input:{runId:string;typeId:string;from:import('./types.js').RelationEndpoint;
    to:import('./types.js').RelationEndpoint;evidence:string;idempotencyKey:string;replacesId?:string}):Promise<ExplicitRelationEvent> {
    if(this.principal.kind!=='human') throw new Error('Human relation declaration required');
    return this.tx(async db=>{
      await this.access(db,spaceId,['owner','creator'],true);
      return this.idempotent(db,spaceId,'relation',input.idempotencyKey,input,async()=>{
        required(input.evidence,'Relation evidence');
        const {run}=await this.runContract(db,spaceId,input.runId);
        const workflow=await this.one<WorkflowVersion>(db,'ws_workflows',spaceId,run.workflowVersionId);
        const type=workflow.entrypoints[run.entrypoint]?.process?.relationTypes?.find(type=>type.id===input.typeId);
        if(!run.process||!type) throw new Error('Run has no frozen relation type');
        if(input.replacesId) await this.appendRetraction(db,spaceId,run,input.replacesId,input.evidence);
        const from=await this.asset(db,spaceId,input.from.assetVersionId),to=await this.asset(db,spaceId,input.to.assetVersionId);
        await validateStoredRelation(db,spaceId,run,type,from,to,input.from.pointer,input.to.pointer);
        const value:ExplicitRelationEvent={id:randomUUID(),typeId:type.id,typeRevision:type.revision,from:clone(input.from),to:clone(input.to),
          provenance:'recorded',action:'declare',...(input.replacesId?{previousId:input.replacesId}:{}),actorId:this.principal.id,createdAt:now(),
          evidence:{kind:'human-declaration',runId:run.runId,detail:input.evidence}};
        await persistRelation(db,spaceId,run,value); return value;
      });
    });
  }
  private async appendRetraction(db:PoolClient,spaceId:string,run:SpaceRun,relationId:string,evidence:string):Promise<ExplicitRelationEvent> {
    const previous=await this.one<ExplicitRelationEvent>(db,'ws_relation_events',spaceId,relationId);
    if(previous.action!=='declare'||previous.evidence.runId!==run.runId) throw new Error('Relation correction target mismatch');
    const retracted=await db.query('SELECT 1 FROM ws_relation_events WHERE space_id=$1 AND previous_id=$2 AND document->>\'action\'=\'retract\'',[spaceId,relationId]);
    if(retracted.rowCount) throw new Error('Relation already retracted');
    const value:ExplicitRelationEvent={...previous,id:randomUUID(),action:'retract',previousId:relationId,actorId:this.principal.id,createdAt:now(),
      evidence:{kind:'human-retraction',runId:run.runId,detail:evidence}};
    await persistRelation(db,spaceId,run,value);return value;
  }
  async retractRelation(spaceId:string,input:{runId:string;relationId:string;evidence:string;idempotencyKey:string}):Promise<ExplicitRelationEvent> {
    if(this.principal.kind!=='human') throw new Error('Human relation declaration required');
    return this.tx(async db=>{
      await this.access(db,spaceId,['owner','creator'],true);
      return this.idempotent(db,spaceId,'relation-retraction',input.idempotencyKey,input,async()=>{
        required(input.evidence,'Relation evidence'); const {run}=await this.runContract(db,spaceId,input.runId);
        return this.appendRetraction(db,spaceId,run,input.relationId,input.evidence);
      });
    });
  }
  async assetNeighborhood(spaceId:string,assetVersionId:string,options:{runId?:string;cursor?:number;limit?:number}={}):Promise<{items:RelationProjection[];nextCursor:number;hasMore:boolean}> {
    await this.access(this.pool,spaceId);
    await this.asset(this.pool,spaceId,assetVersionId);
    const cursor=options.cursor??0,limit=options.limit??50;
    if(!Number.isInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>100) throw new Error('Invalid relation page cursor or size');
    if(options.runId) await this.one<SpaceRun>(this.pool,'ws_runs',spaceId,options.runId,'run_id');
    const asset=await this.asset(this.pool,spaceId,assetVersionId);
    const runId=options.runId??(asset.source.kind==='node'?asset.source.runId:undefined);
    const extra=runId?(await this.process(spaceId,runId)).relations.filter(relation=>relation.provenance!=='recorded'):[];
    const items=await queryRelationFacts(this.pool,spaceId,{assetVersionId,runId:options.runId,cursor,limit:limit+1,extra});
    return {items:items.slice(0,limit),nextCursor:cursor+Math.min(items.length,limit),hasMore:items.length>limit};
  }
  async readManifest(spaceId:string,id:string):Promise<InputManifest> {
    await this.access(this.pool,spaceId); return this.one(this.pool,'ws_manifests',spaceId,id);
  }
  /** Narrow, principal-bound reads for one browser-visible subject. */
  async readRun(spaceId:string,runId:string):Promise<SpaceRun> {
    await this.access(this.pool,spaceId);return this.one(this.pool,'ws_runs',spaceId,runId,'run_id');
  }
  async readWorkflowVersion(spaceId:string,id:string):Promise<WorkflowVersion> {
    await this.access(this.pool,spaceId);return this.one(this.pool,'ws_workflows',spaceId,id);
  }
  async readCase(spaceId:string,id:string):Promise<SpaceCase> {
    await this.access(this.pool,spaceId);return this.one(this.pool,'ws_cases',spaceId,id);
  }
  async readReview(spaceId:string,id:string):Promise<Review> {
    await this.access(this.pool,spaceId);return this.one(this.pool,'ws_reviews',spaceId,id);
  }
  /** Small authenticated overview for polling; reads no asset payloads or history documents. */
  async spaceSummary(spaceId:string,scope:{workflowId:string;entrypoint:string;adoptionSlot?:string}):Promise<{
    space:WorkflowSpace;versionCount:number;caseCount:number;runCount:number;assetCount:number;latestVersionId:string|null;adoptedVersionId:string|null
  }> {
    const space=await this.access(this.pool,spaceId);
    required(scope.workflowId,'Workflow ID');required(scope.entrypoint,'Entrypoint');
    const result=await this.pool.query<{version_count:number;case_count:number;run_count:number;asset_count:number;latest_version_id:string|null;adopted_version_id:string|null}>(
      `WITH scoped_versions AS (
         SELECT id,document->>'createdAt' AS created_at FROM ws_workflows
         WHERE space_id=$1 AND archival IS NULL AND document->'entrypoints'->$2->>'workflowId'=$3
       )
       SELECT
         (SELECT count(*)::int FROM scoped_versions) AS version_count,
         (SELECT count(*)::int FROM ws_cases WHERE space_id=$1) AS case_count,
         (SELECT count(*)::int FROM ws_runs r JOIN scoped_versions v ON v.id=r.workflow_version_id
           WHERE r.space_id=$1 AND r.document->>'entrypoint'=$2) AS run_count,
         (SELECT count(*)::int FROM ws_asset_versions WHERE space_id=$1) AS asset_count,
         (SELECT id FROM scoped_versions ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_version_id,
         (SELECT a.target_workflow_id FROM ws_adoption_heads h
           JOIN ws_adoptions a ON a.space_id=h.space_id AND a.id=h.adoption_id
           JOIN scoped_versions v ON v.id=a.target_workflow_id
           WHERE h.space_id=$1 AND h.slot=$4::text) AS adopted_version_id`,
      [spaceId,scope.entrypoint,scope.workflowId,scope.adoptionSlot??null]);
    const row=result.rows[0]!;
    return {space,versionCount:row.version_count,caseCount:row.case_count,runCount:row.run_count,assetCount:row.asset_count,
      latestVersionId:row.latest_version_id,adoptedVersionId:row.adopted_version_id};
  }
  async versionIterationsPage(spaceId:string,versionId:string,after:string|undefined,limit:number):Promise<IterationDraft[]> {
    await this.access(this.pool,spaceId);
    await this.one<WorkflowVersion>(this.pool,'ws_workflows',spaceId,versionId);
    if(!Number.isSafeInteger(limit)||limit<1||limit>101)throw new Error('Invalid iteration page size');
    return (await this.pool.query<{document:IterationDraft}>(
      `SELECT document FROM ws_iterations WHERE space_id=$1 AND workflow_version_id=$2
       AND ($3::text IS NULL OR id COLLATE "C" > $3::text COLLATE "C")
       ORDER BY id COLLATE "C" LIMIT $4`,[spaceId,versionId,after??null,limit])).rows.map(row=>row.document);
  }
  async caseRunsPage(spaceId:string,caseId:string,workflowId:string,entrypoint:string,after:string|undefined,limit:number):Promise<SpaceRun[]> {
    await this.access(this.pool,spaceId);
    await this.one<SpaceCase>(this.pool,'ws_cases',spaceId,caseId);
    if(!Number.isSafeInteger(limit)||limit<1||limit>101)throw new Error('Invalid case run page size');
    return (await this.pool.query<{document:SpaceRun}>(
      `SELECT r.document FROM ws_runs r JOIN ws_workflows v ON v.space_id=r.space_id AND v.id=r.workflow_version_id
       WHERE r.space_id=$1 AND r.case_id=$2 AND r.document->>'entrypoint'=$4
         AND v.document->'entrypoints'->$4->>'workflowId'=$3
         AND ($5::text IS NULL OR r.run_id COLLATE "C" > $5::text COLLATE "C")
       ORDER BY r.run_id COLLATE "C" LIMIT $6`,
      [spaceId,caseId,workflowId,entrypoint,after??null,limit])).rows.map(row=>row.document);
  }
  async versionRunStats(spaceId:string,versionId:string,entrypoint:string,workflowId:string):Promise<{runCount:number;caseCount:number}> {
    await this.access(this.pool,spaceId);
    const version=await this.one<WorkflowVersion>(this.pool,'ws_workflows',spaceId,versionId);
    if(version.entrypoints[entrypoint]?.workflowId!==workflowId)throw new Error('Version entrypoint is outside authorized workflow scope');
    const row=(await this.pool.query<{run_count:number;case_count:number}>(
      `SELECT count(*)::int AS run_count,count(DISTINCT case_id)::int AS case_count
       FROM ws_runs WHERE space_id=$1 AND workflow_version_id=$2 AND document->>'entrypoint'=$3`,[spaceId,versionId,entrypoint])).rows[0]!;
    return {runCount:row.run_count,caseCount:row.case_count};
  }
  async readAssetsByIds(spaceId:string,ids:string[]):Promise<(AssetVersion&{state:string})[]> {
    await this.access(this.pool,spaceId);
    if(ids.length>1000||ids.some(id=>!id))throw new Error('Invalid exact asset set');
    const unique=[...new Set(ids)];if(!unique.length)return [];
    const rows=(await this.pool.query<{document:AssetVersion}>(
      'SELECT document FROM ws_asset_versions WHERE space_id=$1 AND id=ANY($2::text[])',[spaceId,unique])).rows;
    const byId=new Map(rows.map(row=>[row.document.id,row.document]));
    if(byId.size!==unique.length)throw new Error('Record not found in authorized space');
    const registry=await this.registry(this.pool,spaceId);
    const states=(await this.pool.query<{version_id:string;state:string}>(
      `SELECT DISTINCT ON (version_id) version_id,document->>'to' AS state FROM ws_transitions
       WHERE space_id=$1 AND version_id=ANY($2::text[]) ORDER BY version_id,ordinal DESC`,[spaceId,unique])).rows;
    const byState=new Map(states.map(row=>[row.version_id,row.state]));
    const result=[] as (AssetVersion&{state:string})[];
    for(const id of ids){const asset=byId.get(id)!;
      if(await hash(asset.payload)!==asset.payloadHash)throw new Error('Asset payload integrity check failed');
      registry.validatePayload(asset.schema,asset.payload);
      result.push({...asset,state:byState.get(id)??asset.initialState});
    }
    return result;
  }
  async runAssets(spaceId:string,runId:string):Promise<(AssetVersion&{state:string})[]> {
    await this.readRun(spaceId,runId);
    const ids=(await this.pool.query<{id:string}>('SELECT id FROM ws_asset_versions WHERE space_id=$1 AND run_id=$2 ORDER BY id COLLATE "C"',[spaceId,runId])).rows.map(row=>row.id);
    return this.readAssetsByIds(spaceId,ids);
  }
  /** Bounded read of imported domain records by schema and exact business ownership. */
  async importedAssetsBySchema(spaceId:string,namespace:string,filter:{caseId?:string;runId?:string;subjectAssetId?:string},limit=50):Promise<(AssetVersion&{state:string})[]> {
    await this.access(this.pool,spaceId);
    if(!namespace||namespace.length>240||!Object.values(filter).some(Boolean)||Object.values(filter).some(value=>value!==undefined&&(!value||value.length>240))||!Number.isSafeInteger(limit)||limit<1||limit>101)throw new Error('Invalid imported asset query');
    const ids=(await this.pool.query<{id:string}>(
      `SELECT id FROM ws_asset_versions
       WHERE space_id=$1 AND namespace=$2 AND document->'source'->>'kind'='import'
         AND ($3::text IS NULL OR document->'payload'->>'caseId'=$3)
         AND ($4::text IS NULL OR document->'payload'->>'runId'=$4)
         AND ($5::text IS NULL OR document->'payload'->>'subjectAssetId'=$5)
       ORDER BY id COLLATE "C" LIMIT $6`,
      [spaceId,namespace,filter.caseId??null,filter.runId??null,filter.subjectAssetId??null,limit])).rows.map(row=>row.id);
    return this.readAssetsByIds(spaceId,ids);
  }
  /** Exact candidate runs with a saved node input binding for this asset. */
  async assetConsumerRuns(spaceId:string,assetVersionId:string):Promise<SpaceRun[]> {
    await this.access(this.pool,spaceId);
    await this.asset(this.pool,spaceId,assetVersionId);
    return (await this.pool.query<{document:SpaceRun}>(
      `SELECT DISTINCT r.document FROM ws_context_inputs i
       JOIN ws_contexts c ON c.space_id=i.space_id AND c.id=i.context_id
       JOIN ws_runs r ON r.space_id=c.space_id AND r.run_id=c.run_id
       WHERE i.space_id=$1 AND i.version_id=$2`,[spaceId,assetVersionId])).rows.map(row=>row.document);
  }
  async reviewsForAsset(spaceId:string,assetVersionId:string):Promise<Review[]> {
    await this.access(this.pool,spaceId);
    await this.asset(this.pool,spaceId,assetVersionId);
    return (await this.pool.query<{document:Review}>(
      `SELECT r.document FROM ws_review_assets a JOIN ws_reviews r ON r.space_id=a.space_id AND r.id=a.review_id
       WHERE a.space_id=$1 AND a.version_id=$2 AND r.document->'assetVersionIds' ? $2::text
       ORDER BY r.id COLLATE "C"`,[spaceId,assetVersionId])).rows.map(row=>row.document);
  }
  async overview(spaceId: string): Promise<SpaceOverview> {
    const space=await this.access(this.pool,spaceId);
    const [workflows,cases,runs,rawAssets,reviews,comparisons,iterations,adoptions,sessions,knowledge] = await Promise.all([
      this.pool.query<{document:WorkflowVersion}>('SELECT document FROM ws_workflows WHERE space_id=$1 AND archival IS NULL',[spaceId]).then(result=>result.rows.map(row=>row.document)),this.list<SpaceCase>(this.pool,'ws_cases',spaceId),this.list<SpaceRun>(this.pool,'ws_runs',spaceId),this.list<AssetVersion>(this.pool,'ws_asset_versions',spaceId),this.list<Review>(this.pool,'ws_reviews',spaceId),this.list<Comparison>(this.pool,'ws_comparisons',spaceId),this.list<IterationDraft>(this.pool,'ws_iterations',spaceId),this.list<Adoption>(this.pool,'ws_adoptions',spaceId),this.list<SessionRecord>(this.pool,'ws_sessions',spaceId),this.list<KnowledgeRevision>(this.pool,'ws_knowledge',spaceId),
    ]);
    const assets=await Promise.all(rawAssets.map(async asset=>({...await this.asset(this.pool,spaceId,asset.id),state:await this.state(this.pool,spaceId,asset)})));
    const counters=await this.pool.query<{id:string;next_seq:number}>('SELECT id,next_seq FROM ws_sessions WHERE space_id=$1',[spaceId]);
    for(const session of sessions) session.nextSeq=counters.rows.find(r=>r.id===session.id)?.next_seq??session.nextSeq;
    return {space,workflows,cases,runs,assets,reviews,comparisons,iterations,adoptions,sessions,knowledge};
  }
}
