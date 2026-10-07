import { artifactPayloadSha256 } from '@signal-room/workflow';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SchemaRef } from '@signal-room/workflow-space-contracts';
import type { ProcessContract, RelationTypeContract } from './process-contract.js';
import type { AssetVersion, NodeContext, NodeRelationWrite, RelationEndpoint, SpaceRun } from './types.js';

type DB = Pool | PoolClient;
export interface RelationProjection {
  id: string; typeId: string; from: RelationEndpoint; to: RelationEndpoint;
  provenance: 'recorded' | 'derived' | 'retrospective';
  typeRevision?: string;
  relatedEntity?: {kind:'context'|'review'|'adoption';id:string;runId?:string;stepRunId?:string;sessionId?:string;slot?:string};
  evidence: {kind: string; runId?: string; contextId?: string; stepRunId?: string; mappingId?: string; resolverVersion?: string; detail?: string};
}
export interface ExplicitRelationEvent extends RelationProjection {
  action: 'declare' | 'retract'; previousId?: string; actorId: string; createdAt: string;
}

const sameSchema=(a:SchemaRef,b:SchemaRef):boolean=>a.namespace===b.namespace&&a.revision===b.revision&&a.hash===b.hash;
function pointerValue(payload: unknown,pointer:string):unknown {
  if(pointer==='') return payload;
  if(!pointer.startsWith('/')||!pointer.split('/').slice(1).every(part=>!/~(?![01])/.test(part))) throw new Error('Invalid JSON Pointer');
  let current:unknown=payload;
  for(const raw of pointer.slice(1).split('/')) {
    const key=raw.replace(/~1/g,'/').replace(/~0/g,'~');
    if(Array.isArray(current)) {
      if(!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('Invalid array pointer');
      current=current[Number(key)];
    } else if(current && typeof current==='object' && Object.hasOwn(current,key)) current=(current as Record<string,unknown>)[key];
    else throw new Error('Relation pointer does not exist in immutable asset');
  }
  if(current===undefined) throw new Error('Relation pointer does not exist in immutable asset');
  return current;
}
export function validateRelationEvent(type:RelationTypeContract,from:AssetVersion,to:AssetVersion,
  fromPointer?:string,toPointer?:string):void {
  if(!type.fromSchemas.some(ref=>sameSchema(ref,from.schema))||!type.toSchemas.some(ref=>sameSchema(ref,to.schema))) throw new Error('Relation endpoint schema mismatch');
  if(fromPointer!==undefined) {
    if(!type.allowFromPointer) throw new Error('Relation source pointer denied');
    pointerValue(from.payload,fromPointer);
  }
  if(toPointer!==undefined) {
    if(!type.allowToPointer) throw new Error('Relation target pointer denied');
    pointerValue(to.payload,toPointer);
  }
  if(!type.allowCycle && from.id===to.id) throw new Error('Relation self-cycle denied');
}
export async function persistRelation(db:PoolClient,spaceId:string,run:SpaceRun,relation:ExplicitRelationEvent):Promise<void> {
  await db.query('INSERT INTO ws_relation_events(space_id,id,run_id,case_id,from_version_id,to_version_id,previous_id,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [spaceId,relation.id,run.runId,run.caseId,relation.action==='declare'?relation.from.assetVersionId:null,
      relation.action==='declare'?relation.to.assetVersionId:null,relation.previousId??null,JSON.stringify(relation)]);
}

/** The caller holds the Space write lock, making cardinality and cycle checks atomic. */
export async function validateStoredRelation(db:PoolClient,spaceId:string,run:SpaceRun,type:RelationTypeContract,
  from:AssetVersion,to:AssetVersion,fromPointer?:string,toPointer?:string):Promise<void> {
  validateRelationEvent(type,from,to,fromPointer,toPointer);
  const scope=type.scope??'case';
  for(const asset of [from,to]) {
    const bound=await db.query(`SELECT 1 FROM ws_runs r WHERE r.space_id=$1 AND
      ${scope==='run'?'r.run_id=$2':'r.case_id=$2'} AND (
      EXISTS(SELECT 1 FROM ws_manifest_assets m WHERE m.space_id=r.space_id AND m.manifest_id=r.manifest_id AND m.version_id=$3)
      OR EXISTS(SELECT 1 FROM ws_contexts c JOIN ws_output_bindings o ON o.space_id=c.space_id AND o.context_id=c.id
        WHERE c.space_id=r.space_id AND c.run_id=r.run_id AND o.version_id=$3)) LIMIT 1`,
      [spaceId,scope==='run'?run.runId:run.caseId,asset.id]);
    if(!bound.rowCount) throw new Error('Relation endpoint outside declared case/run scope');
  }
  const active=await db.query<{from_version_id:string;to_version_id:string}>(`SELECT e.from_version_id,e.to_version_id
    FROM ws_relation_events e WHERE e.space_id=$1 AND ${scope==='run'?'e.run_id=$2':'e.case_id=$2'}
    AND e.document->>'typeId'=$3 AND e.document->>'typeRevision'=$4 AND e.document->>'action'='declare'
    AND NOT EXISTS(SELECT 1 FROM ws_relation_events r WHERE r.space_id=e.space_id AND r.previous_id=e.id AND r.document->>'action'='retract')`,
    [spaceId,scope==='run'?run.runId:run.caseId,type.id,type.revision]);
  if(type.maxPerFrom!==undefined && active.rows.filter(row=>row.from_version_id===from.id).length>=type.maxPerFrom) throw new Error('Relation source cardinality exceeded');
  if(type.maxPerTo!==undefined && active.rows.filter(row=>row.to_version_id===to.id).length>=type.maxPerTo) throw new Error('Relation target cardinality exceeded');
  if(!type.allowCycle) {
    const seen=new Set<string>(),pending=[to.id];
    while(pending.length) {
      const id=pending.pop()!;
      if(id===from.id) throw new Error('Relation cycle denied');
      if(seen.has(id)) continue; seen.add(id);
      pending.push(...active.rows.filter(row=>row.from_version_id===id).map(row=>row.to_version_id));
    }
  }
}

/** Called inside the node publication transaction, before the core receipt is committed. */
export async function insertNodeRelations(db:PoolClient,spaceId:string,run:SpaceRun,context:NodeContext,
  process:ProcessContract,versions:AssetVersion[],writes:NodeRelationWrite[],actorId:string):Promise<void> {
  const processNode=process.nodes.find(node=>node.id===context.process?.nodeId && node.storageNodeId===context.nodeId);
  if(!processNode) {
    if(writes.length || process.relationMappings?.some(map=>map.required && process.nodes.find(node=>node.id===map.nodeId)?.storageNodeId===context.nodeId))
      throw new Error('Published node lacks a validated process occurrence');
    return;
  }
  const outputRows=await db.query<{slot:string;version_id:string}>('SELECT slot,version_id FROM ws_output_bindings WHERE space_id=$1 AND context_id=$2',[spaceId,context.id]);
  const outputs=new Map(outputRows.rows.map(row=>[row.slot,row.version_id]));
  const versionById=new Map(versions.map(version=>[version.id,version]));
  const types=new Map((process.relationTypes??[]).map(type=>[type.id,type]));
  const mappings=process.relationMappings??[];
  const records:NodeRelationWrite[]=[...writes];
  for(const mapping of mappings.filter(item=>item.nodeId===processNode.id && (item.required || item.policy!=='explicit'))) {
    const outputSlot=processNode.outputs?.[mapping.outputPort]?.slot;
    const inputSlot=mapping.inputPort?processNode.inputs?.[mapping.inputPort]?.slot:undefined;
    const targetOutputSlot=mapping.toOutputPort?processNode.outputs?.[mapping.toOutputPort]?.slot:undefined;
    if(!outputSlot||!outputs.has(outputSlot)||(!inputSlot&&!targetOutputSlot)||
      (inputSlot&&!context.inputs[inputSlot])||(targetOutputSlot&&!outputs.has(targetOutputSlot))) {
      if(mapping.required) throw new Error(`Required relation mapping ${mapping.id} missing output or input`);
      continue;
    }
    if(!records.some(write=>write.typeId===mapping.typeId&&write.from.outputSlot===outputSlot&&
      (inputSlot?write.to.inputSlot===inputSlot:write.to.outputSlot===targetOutputSlot))) {
      if(mapping.policy==='explicit') throw new Error(`Required explicit relation ${mapping.id} missing`);
      records.push({typeId:mapping.typeId,from:{outputSlot},to:inputSlot?{inputSlot}:{outputSlot:targetOutputSlot}});
    }
  }
  const identities=new Set<string>();
  for(const write of records) {
    const identity=JSON.stringify({typeId:write.typeId,from:write.from,to:write.to});
    if(identities.has(identity)) throw new Error('Duplicate node relation');
    identities.add(identity);
    const fromSlot=write.from.outputSlot, toSlot=write.to.inputSlot??write.to.outputSlot;
    if(!fromSlot||!toSlot||write.from.inputSlot||Boolean(write.to.inputSlot)===Boolean(write.to.outputSlot)) throw new Error('Node relation must connect output to one declared bound input/output');
    const mapping=mappings.find(item=>item.nodeId===processNode.id&&item.typeId===write.typeId&&
      processNode.outputs?.[item.outputPort]?.slot===fromSlot&&
      (item.inputPort?processNode.inputs?.[item.inputPort]?.slot===write.to.inputSlot:
        processNode.outputs?.[item.toOutputPort!]?.slot===write.to.outputSlot));
    const type=types.get(write.typeId);
    const fromId=outputs.get(fromSlot),toId=write.to.inputSlot?context.inputs[toSlot]?.assetVersionId:outputs.get(toSlot);
    const from=fromId?versionById.get(fromId):undefined;
    if(!mapping||!type||!from||!toId) throw new Error('Undeclared or unbound node relation');
    const toRow=await db.query<{document:AssetVersion}>('SELECT document FROM ws_asset_versions WHERE space_id=$1 AND id=$2',[spaceId,toId]);
    const to=toRow.rows[0]?.document;
    if(!to) throw new Error('Relation target missing');
    if(await artifactPayloadSha256(to.payload)!==to.payloadHash) throw new Error('Relation target immutable payload integrity mismatch');
    if(write.to.inputSlot&&write.to.pointer!==undefined) pointerValue(context.inputs[toSlot]!.payload,write.to.pointer);
    await validateStoredRelation(db,spaceId,run,type,from,to,write.from.pointer,write.to.pointer);
    const relation:ExplicitRelationEvent={id:randomUUID(),typeId:write.typeId,typeRevision:type.revision,
      from:{assetVersionId:from.id,...(write.from.pointer!==undefined?{pointer:write.from.pointer}:{})},
      to:{assetVersionId:to.id,...(write.to.pointer!==undefined?{pointer:write.to.pointer}:{})},
      provenance:'recorded',evidence:{kind:'node-port-binding',runId:run.runId,contextId:context.id,stepRunId:context.stepRunId,mappingId:mapping.id,
        ...(write.evidence?{detail:write.evidence}:{})},action:'declare',actorId,createdAt:new Date().toISOString()};
    await persistRelation(db,spaceId,run,relation);
  }
}

export async function projectAssetRelations(db:DB,spaceId:string,assetVersionId:string,runId?:string):Promise<RelationProjection[]> {
  const params=runId?[spaceId,assetVersionId,runId]:[spaceId,assetVersionId];
  const rows=await db.query<{document:ExplicitRelationEvent}>(`SELECT document FROM ws_relation_events
    WHERE space_id=$1 AND ((from_version_id=$2 OR to_version_id=$2) OR previous_id IN
      (SELECT id FROM ws_relation_events WHERE space_id=$1 AND (from_version_id=$2 OR to_version_id=$2)))
      ${runId?'AND run_id=$3':''} ORDER BY ordinal`,params);
  const events=rows.rows.map(row=>row.document);
  const retracted=new Set(events.filter(event=>event.action==='retract').map(event=>event.previousId));
  return events.filter(event=>event.action==='declare'&&!retracted.has(event.id)).map(({action,previousId,actorId,createdAt,...relation})=>relation);
}

export async function projectRunRelations(db:DB,spaceId:string,runId:string):Promise<RelationProjection[]> {
  const rows=await db.query<{document:ExplicitRelationEvent}>('SELECT document FROM ws_relation_events WHERE space_id=$1 AND run_id=$2 ORDER BY ordinal',[spaceId,runId]);
  const events=rows.rows.map(row=>row.document);
  const retracted=new Set(events.filter(event=>event.action==='retract').map(event=>event.previousId));
  return events.filter(event=>event.action==='declare'&&!retracted.has(event.id)).map(({action,previousId,actorId,createdAt,...relation})=>relation);
}

/** Query the existing fact sources, never copy production, dependency, review or adoption records. */
export async function queryRelationFacts(db:DB,spaceId:string,options:{assetVersionId?:string;runId?:string;cursor?:number;limit?:number;extra?:RelationProjection[]}={}):Promise<RelationProjection[]> {
  const rows=await db.query<{document:RelationProjection}>(`WITH eligible AS (
    SELECT o.version_id FROM ws_output_bindings o JOIN ws_contexts c ON c.space_id=o.space_id AND c.id=o.context_id
    WHERE o.space_id=$1 AND ($3::text IS NULL OR c.run_id=$3)
    UNION SELECT i.version_id FROM ws_context_inputs i JOIN ws_contexts c ON c.space_id=i.space_id AND c.id=i.context_id
    WHERE i.space_id=$1 AND ($3::text IS NULL OR c.run_id=$3)
    UNION SELECT m.version_id FROM ws_manifest_assets m JOIN ws_runs r ON r.space_id=m.space_id AND r.manifest_id=m.manifest_id
    WHERE m.space_id=$1 AND ($3::text IS NULL OR r.run_id=$3)
  ), facts AS (
    SELECT e.id,e.document - 'action' - 'previousId' - 'actorId' - 'createdAt' AS document,
      e.from_version_id AS src,e.to_version_id AS dst FROM ws_relation_events e
    WHERE e.space_id=$1 AND e.document->>'action'='declare' AND ($3::text IS NULL OR e.run_id=$3)
      AND NOT EXISTS(SELECT 1 FROM ws_relation_events r WHERE r.space_id=e.space_id AND r.previous_id=e.id AND r.document->>'action'='retract')
    UNION ALL
    SELECT 'depends-on:'||d.version_id||':'||d.dependency_id,
      jsonb_build_object('id','depends-on:'||d.version_id||':'||d.dependency_id,'typeId','depends-on',
        'from',jsonb_build_object('assetVersionId',d.version_id),'to',jsonb_build_object('assetVersionId',d.dependency_id),
        'provenance','derived','evidence',jsonb_build_object('kind','asset-dependency')),d.version_id,d.dependency_id
    FROM ws_asset_dependencies d WHERE d.space_id=$1 AND ($3::text IS NULL OR d.version_id IN(SELECT version_id FROM eligible))
    UNION ALL
    SELECT 'produced-by:'||o.version_id,
      jsonb_build_object('id','produced-by:'||o.version_id,'typeId','produced-by',
        'from',jsonb_build_object('assetVersionId',o.version_id),'to',jsonb_build_object('assetVersionId',o.version_id),
        'relatedEntity',jsonb_build_object('kind','context','id',COALESCE(c.document->>'generatedByContextId',c.id),
          'runId',c.run_id,'stepRunId',COALESCE(origin.step_run_id,c.step_run_id),'sessionId',COALESCE(origin.session_id,c.session_id),'slot',o.slot),
        'provenance','derived','evidence',jsonb_build_object('kind','node-output-binding','runId',c.run_id,
          'contextId',COALESCE(c.document->>'generatedByContextId',c.id),'stepRunId',COALESCE(origin.step_run_id,c.step_run_id))),o.version_id,o.version_id
    FROM ws_output_bindings o JOIN ws_contexts c ON c.space_id=o.space_id AND c.id=o.context_id
    LEFT JOIN ws_contexts origin ON origin.space_id=c.space_id AND origin.id=c.document->>'generatedByContextId'
    WHERE o.space_id=$1 AND ($3::text IS NULL OR c.run_id=$3)
    UNION ALL
    SELECT 'consumed-by:'||i.version_id||':'||COALESCE(c.document->>'generatedByContextId',c.id)||':'||i.slot,
      jsonb_build_object('id','consumed-by:'||i.version_id||':'||COALESCE(c.document->>'generatedByContextId',c.id)||':'||i.slot,'typeId','consumed-by',
        'from',jsonb_build_object('assetVersionId',i.version_id),'to',jsonb_build_object('assetVersionId',i.version_id),
        'relatedEntity',jsonb_build_object('kind','context','id',COALESCE(c.document->>'generatedByContextId',c.id),
          'runId',c.run_id,'stepRunId',COALESCE(origin.step_run_id,c.step_run_id),'sessionId',COALESCE(origin.session_id,c.session_id),'slot',i.slot),
        'provenance','derived','evidence',jsonb_build_object('kind','node-input-binding','runId',c.run_id,
          'contextId',COALESCE(c.document->>'generatedByContextId',c.id),'stepRunId',COALESCE(origin.step_run_id,c.step_run_id))),i.version_id,i.version_id
    FROM ws_context_inputs i JOIN ws_contexts c ON c.space_id=i.space_id AND c.id=i.context_id
    LEFT JOIN ws_contexts origin ON origin.space_id=c.space_id AND origin.id=c.document->>'generatedByContextId'
    WHERE i.space_id=$1 AND ($3::text IS NULL OR c.run_id=$3)
    UNION ALL
    SELECT 'review-assesses:'||a.review_id||':'||a.version_id,
      jsonb_build_object('id','review-assesses:'||a.review_id||':'||a.version_id,'typeId','assesses',
        'from',jsonb_build_object('assetVersionId',a.version_id),'to',jsonb_build_object('assetVersionId',a.version_id),
        'relatedEntity',jsonb_build_object('kind','review','id',a.review_id,'runId',r.run_id),
        'provenance','derived','evidence',jsonb_build_object('kind','review-target','runId',r.run_id)),a.version_id,a.version_id
    FROM ws_review_assets a JOIN ws_reviews r ON r.space_id=a.space_id AND r.id=a.review_id
    WHERE a.space_id=$1 AND ($3::text IS NULL OR r.run_id=$3)
    UNION ALL
    SELECT 'accepted-as:'||a.id,
      jsonb_build_object('id','accepted-as:'||a.id,'typeId','accepted-as',
        'from',jsonb_build_object('assetVersionId',a.target_asset_id),'to',jsonb_build_object('assetVersionId',a.target_asset_id),
        'relatedEntity',jsonb_build_object('kind','adoption','id',a.id,'slot',a.slot),
        'provenance','derived','evidence',jsonb_build_object('kind','adoption-record')),a.target_asset_id,a.target_asset_id
    FROM ws_adoptions a WHERE a.space_id=$1 AND a.target_asset_id IS NOT NULL AND ($3::text IS NULL OR a.target_asset_id IN(SELECT version_id FROM eligible))
    UNION ALL
    SELECT x->>'id',x,x->'from'->>'assetVersionId',x->'to'->>'assetVersionId' FROM jsonb_array_elements($4::jsonb) x
  ), unique_facts AS (
    SELECT DISTINCT ON(id) id,document FROM facts WHERE ($2::text IS NULL OR src=$2 OR dst=$2) ORDER BY id
  ) SELECT document FROM unique_facts ORDER BY id OFFSET $5 LIMIT $6`,
    [spaceId,options.assetVersionId??null,options.runId??null,JSON.stringify(options.extra??[]),options.cursor??0,options.limit??null]);
  return rows.rows.map(row=>row.document);
}
