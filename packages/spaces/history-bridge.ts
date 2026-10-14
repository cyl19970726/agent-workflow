import type {PoolClient} from 'pg';
import type {ArtifactRef, AttemptRecord, RunRecord, StepRecord, WorkflowEvent} from '@signal-room/workflow';
import {artifactPayloadSha256} from '@signal-room/workflow';

export interface HistoricalRunSource {workspaceId:string;runId:string}
export interface HistoricalRunBindingInput {
  runId:string;workflowVersionId:string;entrypoint:string;inputManifestId:string;
  effectiveConfig?:Record<string,unknown>;
  /** A terminal program-only root that directly produced an exact input of an already bound external run. */
  supportingOf?:string;
}
export interface HistoricalRunImportInput {sourceWorkspaceId:string;runs:HistoricalRunBindingInput[]}
export interface ExternalRunSyncInput {sourceWorkspaceId:string;runs:HistoricalRunBindingInput[]}

/** A replay is valid only while both namespaces still contain the same immutable evidence snapshot. */
export async function verifyHistoricalRunSnapshot(db:PoolClient,targetWorkspaceId:string,source:HistoricalRunSource):Promise<void>{
  const tables:[string,string,string][]=[
    ['aw_runs','id','id,parent_run_id,next_event_seq,document'],
    ['aw_steps','run_id','run_id,id,document'],
    ['aw_attempts','run_id','run_id,step_run_id,id,document'],
    ['aw_events','run_id','run_id,seq,id,step_run_id,attempt_id,document'],
    ['aw_artifacts','run_id','run_id,step_run_id,attempt_id,id,document,payload'],
    ['aw_step_commits','run_id','run_id,step_run_id,attempt_id,idempotency_key,request_hash,receipt'],
  ];
  for(const [table,key,columns] of tables){
    // Table and column names come only from this closed internal list.
    const result=await db.query<{different:boolean}>(
      `SELECT EXISTS(
        (SELECT ${columns} FROM ${table} WHERE workspace_id=$1 AND ${key}=$3
         EXCEPT ALL SELECT ${columns} FROM ${table} WHERE workspace_id=$2 AND ${key}=$3)
        UNION ALL
        (SELECT ${columns} FROM ${table} WHERE workspace_id=$2 AND ${key}=$3
         EXCEPT ALL SELECT ${columns} FROM ${table} WHERE workspace_id=$1 AND ${key}=$3)
      ) AS different`,[source.workspaceId,targetWorkspaceId,source.runId]);
    if(result.rows[0]?.different)throw new Error('Imported ledger evidence differs from historical source');
  }
  const dependencies=await db.query<{different:boolean}>(
    `SELECT EXISTS(
      (SELECT x.artifact_id,x.dependency_id FROM aw_artifact_dependencies x JOIN aw_artifacts a
       ON a.workspace_id=x.workspace_id AND a.id=x.artifact_id WHERE x.workspace_id=$1 AND a.run_id=$3
       EXCEPT ALL SELECT x.artifact_id,x.dependency_id FROM aw_artifact_dependencies x JOIN aw_artifacts a
       ON a.workspace_id=x.workspace_id AND a.id=x.artifact_id WHERE x.workspace_id=$2 AND a.run_id=$3)
      UNION ALL
      (SELECT x.artifact_id,x.dependency_id FROM aw_artifact_dependencies x JOIN aw_artifacts a
       ON a.workspace_id=x.workspace_id AND a.id=x.artifact_id WHERE x.workspace_id=$2 AND a.run_id=$3
       EXCEPT ALL SELECT x.artifact_id,x.dependency_id FROM aw_artifact_dependencies x JOIN aw_artifacts a
       ON a.workspace_id=x.workspace_id AND a.id=x.artifact_id WHERE x.workspace_id=$1 AND a.run_id=$3)
    ) AS different`,[source.workspaceId,targetWorkspaceId,source.runId]);
  if(dependencies.rows[0]?.different)throw new Error('Imported artifact dependencies differ from historical source');
}

/** A bounded, explicit producer/child set. No run outside runIds is copied. */
export async function copyHistoricalRunSet(db:PoolClient,targetWorkspaceId:string,sourceWorkspaceId:string,runIds:readonly string[]):Promise<RunRecord[]>{
  return copyRunSet(db,targetWorkspaceId,sourceWorkspaceId,runIds,false);
}

/** Copy an explicit set of still-running external runs, then advance it from the native source on later calls. */
export async function syncExternalRunSet(db:PoolClient,targetWorkspaceId:string,sourceWorkspaceId:string,runIds:readonly string[]):Promise<RunRecord[]>{
  return copyRunSet(db,targetWorkspaceId,sourceWorkspaceId,runIds,true);
}

async function copyRunSet(db:PoolClient,targetWorkspaceId:string,sourceWorkspaceId:string,runIds:readonly string[],live:boolean):Promise<RunRecord[]>{
  if(!runIds.length||runIds.length>32||new Set(runIds).size!==runIds.length||runIds.some(id=>!id.trim()))
    throw new Error('Historical import requires 1–32 distinct run IDs');
  const runs=(await db.query<{id:string;parent_run_id:string|null}>(
    'SELECT id,parent_run_id FROM aw_runs WHERE workspace_id=$1 AND id=ANY($2::text[])',
    [sourceWorkspaceId,runIds])).rows;
  if(runs.length!==runIds.length)throw new Error('Historical run set includes an unknown source run');
  const parents=new Map(runs.map(row=>[row.id,row.parent_run_id]));
  const edges=(await db.query<{artifact_run_id:string;dependency_run_id:string}>(
    `SELECT DISTINCT a.run_id AS artifact_run_id,d.run_id AS dependency_run_id
     FROM aw_artifact_dependencies x JOIN aw_artifacts a ON a.workspace_id=x.workspace_id AND a.id=x.artifact_id
     JOIN aw_artifacts d ON d.workspace_id=x.workspace_id AND d.id=x.dependency_id
     WHERE x.workspace_id=$1 AND a.run_id=ANY($2::text[]) AND a.run_id<>d.run_id`,
    [sourceWorkspaceId,runIds])).rows;
  const pending=new Set(runIds),ordered:string[]=[];
  while(pending.size){
    const ready=[...pending].find(id=>!pending.has(parents.get(id)??'')&&
      edges.every(edge=>edge.artifact_run_id!==id||!pending.has(edge.dependency_run_id)));
    if(!ready)throw new Error('Historical run set has cyclic parent or artifact dependencies');
    ordered.push(ready);pending.delete(ready);
  }
  // A dependency run omitted from the explicit set is accepted only when the exact dependency artifact
  // already exists in the target namespace; copyHistoricalRun checks its document and payload.
  const copied:RunRecord[]=[];
  for(const runId of ordered)copied.push(await copyHistoricalRun(db,targetWorkspaceId,{workspaceId:sourceWorkspaceId,runId},{live}));
  return copied;
}

type RunRow={id:string;parent_run_id:string|null;next_event_seq:string;document:RunRecord};
type StepRow={id:string;run_id:string;document:StepRecord};
type AttemptRow={id:string;run_id:string;step_run_id:string;document:AttemptRecord};
type EventRow={id:string;run_id:string;seq:string;step_run_id:string|null;attempt_id:string|null;document:WorkflowEvent};
type ArtifactRow={id:string;run_id:string;step_run_id:string;attempt_id:string;document:ArtifactRef;payload:unknown};
type DependencyRow={artifact_id:string;dependency_id:string};
type CommitRow={run_id:string;step_run_id:string;attempt_id:string;idempotency_key:string;request_hash:string;receipt:unknown};
const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
const stableRun=(run:RunRecord)=>{const {state:_state,output:_output,error:_error,...identity}=run;return identity;};
const stableStep=(step:StepRecord)=>{const {state:_state,validation:_validation,output:_output,error:_error,artifactBindings:_bindings,...identity}=step;return identity;};
const stableAttempt=(attempt:AttemptRecord)=>{const {state:_state,error:_error,...identity}=attempt;return identity;};

/** Copy one terminal ledger run exactly, retaining IDs, documents and payloads. The caller owns the transaction and access check. */
export async function copyHistoricalRun(db:PoolClient,targetWorkspaceId:string,source:HistoricalRunSource,options:{live?:boolean}={}):Promise<RunRecord>{
  if(!source.workspaceId.trim()||!source.runId.trim()||source.workspaceId===targetWorkspaceId)
    throw new Error('Historical source must be a different workspace and identify a run');
  const sourceRun=(await db.query<RunRow>(
    'SELECT id,parent_run_id,next_event_seq::text,document FROM aw_runs WHERE workspace_id=$1 AND id=$2 FOR SHARE',
    [source.workspaceId,source.runId])).rows[0];
  if(!sourceRun||sourceRun.document.id!==source.runId)throw new Error('Historical source run not found or invalid');
  if(!options.live&&!['succeeded','failed','canceled','blocked','needs_review'].includes(sourceRun.document.state))
    throw new Error('Historical run must reach a terminal state before import');
  if(sourceRun.parent_run_id){
    const parent=(await db.query<{document:RunRecord}>('SELECT document FROM aw_runs WHERE workspace_id=$1 AND id=$2',
      [targetWorkspaceId,sourceRun.parent_run_id])).rows[0];
    const original=(await db.query<{document:RunRecord}>('SELECT document FROM aw_runs WHERE workspace_id=$1 AND id=$2',
      [source.workspaceId,sourceRun.parent_run_id])).rows[0];
    if(!parent||!original||JSON.stringify(parent.document)!==JSON.stringify(original.document))
      throw new Error('Import the historical parent run first');
  }
  const steps=await db.query<StepRow>('SELECT id,run_id,document FROM aw_steps WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at',[source.workspaceId,source.runId]);
  const attempts=await db.query<AttemptRow>('SELECT id,run_id,step_run_id,document FROM aw_attempts WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at',[source.workspaceId,source.runId]);
  const events=await db.query<EventRow>('SELECT id,run_id,seq::text,step_run_id,attempt_id,document FROM aw_events WHERE workspace_id=$1 AND run_id=$2 ORDER BY seq',[source.workspaceId,source.runId]);
  const artifacts=await db.query<ArtifactRow>('SELECT id,run_id,step_run_id,attempt_id,document,payload FROM aw_artifacts WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at',[source.workspaceId,source.runId]);
  const commits=await db.query<CommitRow>('SELECT run_id,step_run_id,attempt_id,idempotency_key,request_hash,receipt FROM aw_step_commits WHERE workspace_id=$1 AND run_id=$2 ORDER BY idempotency_key',[source.workspaceId,source.runId]);
  const stepIds=new Set(steps.rows.map(row=>row.id));
  const attemptIds=new Set(attempts.rows.map(row=>row.id));
  const artifactIds=new Set(artifacts.rows.map(row=>row.id));
  for(const row of steps.rows)if(row.run_id!==source.runId||row.document.id!==row.id||row.document.runId!==source.runId)
    throw new Error('Historical step identity mismatch');
  for(const row of attempts.rows)if(row.run_id!==source.runId||row.document.id!==row.id||row.document.runId!==source.runId||
    row.document.stepRunId!==row.step_run_id||!stepIds.has(row.step_run_id))throw new Error('Historical attempt identity mismatch');
  for(const row of events.rows)if(row.run_id!==source.runId||row.document.id!==row.id||row.document.runId!==source.runId||
    row.document.seq!==Number(row.seq)||row.document.stepRunId!==row.step_run_id&&row.step_run_id!==null||
    row.document.attemptId!==row.attempt_id&&row.attempt_id!==null||
    row.step_run_id!==null&&!stepIds.has(row.step_run_id)||row.attempt_id!==null&&!attemptIds.has(row.attempt_id))
    throw new Error('Historical event identity mismatch');
  for(const row of artifacts.rows)if(row.run_id!==source.runId||row.document.id!==row.id||
    row.document.producedBy.workflowRunId!==source.runId||row.document.producedBy.stepRunId!==row.step_run_id||
    row.document.producedBy.attemptId!==row.attempt_id||!attemptIds.has(row.attempt_id)||
    await artifactPayloadSha256(row.payload)!==row.document.sha256)throw new Error('Historical artifact provenance or hash mismatch');
  for(const row of commits.rows)if(row.run_id!==source.runId||!stepIds.has(row.step_run_id)||!attemptIds.has(row.attempt_id))
    throw new Error('Historical step commit provenance mismatch');
  const dependencyRows=artifactIds.size?(await db.query<DependencyRow>(
    'SELECT artifact_id,dependency_id FROM aw_artifact_dependencies WHERE workspace_id=$1 AND artifact_id=ANY($2::text[])',
    [source.workspaceId,[...artifactIds]])).rows:[];
  for(const dependency of dependencyRows){
    if(artifactIds.has(dependency.dependency_id))continue;
    const original=(await db.query<ArtifactRow>('SELECT document,payload FROM aw_artifacts WHERE workspace_id=$1 AND id=$2',
      [source.workspaceId,dependency.dependency_id])).rows[0];
    const available=(await db.query<ArtifactRow>('SELECT document,payload FROM aw_artifacts WHERE workspace_id=$1 AND id=$2',
      [targetWorkspaceId,dependency.dependency_id])).rows[0];
    if(!original||!available||JSON.stringify(original)!==JSON.stringify(available))
      throw new Error(`Historical dependency ${dependency.dependency_id} must be imported first`);
  }
  const existing=(await db.query<RunRow>('SELECT id,parent_run_id,next_event_seq::text,document FROM aw_runs WHERE workspace_id=$1 AND id=$2',
    [targetWorkspaceId,source.runId])).rows[0];
  if(existing){
    if(!options.live)throw new Error('Target ledger run already exists; historical import cannot overwrite it');
    if(existing.parent_run_id!==sourceRun.parent_run_id||!same(stableRun(existing.document),stableRun(sourceRun.document))||
      Number(existing.next_event_seq)>Number(sourceRun.next_event_seq)||
      ['succeeded','failed','canceled','blocked','needs_review'].includes(existing.document.state)&&
      !same(existing.document,sourceRun.document))throw new Error('External target run diverged from native source');
    const targetSteps=await db.query<StepRow>('SELECT id,run_id,document FROM aw_steps WHERE workspace_id=$1 AND run_id=$2',[targetWorkspaceId,source.runId]);
    const targetAttempts=await db.query<AttemptRow>('SELECT id,run_id,step_run_id,document FROM aw_attempts WHERE workspace_id=$1 AND run_id=$2',[targetWorkspaceId,source.runId]);
    const targetEvents=await db.query<EventRow>('SELECT id,run_id,seq::text,step_run_id,attempt_id,document FROM aw_events WHERE workspace_id=$1 AND run_id=$2',[targetWorkspaceId,source.runId]);
    const targetArtifacts=await db.query<ArtifactRow>('SELECT id,run_id,step_run_id,attempt_id,document,payload FROM aw_artifacts WHERE workspace_id=$1 AND run_id=$2',[targetWorkspaceId,source.runId]);
    const targetCommits=await db.query<CommitRow>('SELECT run_id,step_run_id,attempt_id,idempotency_key,request_hash,receipt FROM aw_step_commits WHERE workspace_id=$1 AND run_id=$2',[targetWorkspaceId,source.runId]);
    const targetDependencies=await db.query<DependencyRow>(
      `SELECT x.artifact_id,x.dependency_id FROM aw_artifact_dependencies x JOIN aw_artifacts a
       ON a.workspace_id=x.workspace_id AND a.id=x.artifact_id WHERE x.workspace_id=$1 AND a.run_id=$2`,
      [targetWorkspaceId,source.runId]);
    const byId=<T extends {id:string}>(rows:T[])=>new Map(rows.map(row=>[row.id,row]));
    const sourceSteps=byId(steps.rows),sourceAttempts=byId(attempts.rows),sourceEvents=byId(events.rows),sourceArtifacts=byId(artifacts.rows);
    if(targetSteps.rows.some(row=>!sourceSteps.has(row.id)||!same(stableStep(row.document),stableStep(sourceSteps.get(row.id)!.document)))||
      targetAttempts.rows.some(row=>!sourceAttempts.has(row.id)||!same(stableAttempt(row.document),stableAttempt(sourceAttempts.get(row.id)!.document)))||
      targetEvents.rows.some(row=>!same(row,sourceEvents.get(row.id)))||
      targetArtifacts.rows.some(row=>!same(row,sourceArtifacts.get(row.id)))||
      targetCommits.rows.some(row=>!commits.rows.some(item=>same(item,row)))||
      targetDependencies.rows.some(row=>!dependencyRows.some(item=>same(item,row))))
      throw new Error('External target ledger diverged from native source');
    await db.query('UPDATE aw_runs SET next_event_seq=$3,document=$4::jsonb WHERE workspace_id=$1 AND id=$2',
      [targetWorkspaceId,source.runId,sourceRun.next_event_seq,JSON.stringify(sourceRun.document)]);
  }else await db.query('INSERT INTO aw_runs(workspace_id,id,parent_run_id,next_event_seq,document) VALUES($1,$2,$3,$4,$5::jsonb)',
    [targetWorkspaceId,source.runId,sourceRun.parent_run_id,sourceRun.next_event_seq,JSON.stringify(sourceRun.document)]);
  for(const row of steps.rows)await db.query('INSERT INTO aw_steps(workspace_id,run_id,id,document) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(workspace_id,id) DO UPDATE SET document=EXCLUDED.document',
    [targetWorkspaceId,row.run_id,row.id,JSON.stringify(row.document)]);
  for(const row of attempts.rows)await db.query('INSERT INTO aw_attempts(workspace_id,run_id,step_run_id,id,document) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(workspace_id,id) DO UPDATE SET document=EXCLUDED.document',
    [targetWorkspaceId,row.run_id,row.step_run_id,row.id,JSON.stringify(row.document)]);
  for(const row of events.rows)await db.query('INSERT INTO aw_events(workspace_id,run_id,seq,id,step_run_id,attempt_id,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING',
    [targetWorkspaceId,row.run_id,row.seq,row.id,row.step_run_id,row.attempt_id,JSON.stringify(row.document)]);
  for(const row of artifacts.rows)await db.query('INSERT INTO aw_artifacts(workspace_id,run_id,step_run_id,attempt_id,id,document,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING',
    [targetWorkspaceId,row.run_id,row.step_run_id,row.attempt_id,row.id,JSON.stringify(row.document),JSON.stringify(row.payload)]);
  for(const row of dependencyRows)await db.query('INSERT INTO aw_artifact_dependencies(workspace_id,artifact_id,dependency_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [targetWorkspaceId,row.artifact_id,row.dependency_id]);
  for(const row of commits.rows)await db.query(
    'INSERT INTO aw_step_commits(workspace_id,run_id,step_run_id,attempt_id,idempotency_key,request_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',
    [targetWorkspaceId,row.run_id,row.step_run_id,row.attempt_id,row.idempotency_key,row.request_hash,JSON.stringify(row.receipt)]);
  return sourceRun.document;
}
