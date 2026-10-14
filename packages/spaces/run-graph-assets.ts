import type {ProcessView} from './process-projection.js';
import type {AssetVersion, InputManifest} from './types.js';

export interface RunGraphAsset {
  id: string;
  kind: 'frozen-input' | 'published-output';
  slots: string[];
  schema: AssetVersion['schema'];
  producerNodeId?: string;
}
export interface RunGraphAssetRelation {
  assetId: string;
  nodeId: string;
  kind: 'produces' | 'consumes';
  occurrenceIds: string[];
}
export interface RunGraphAssets {
  assets: RunGraphAsset[];
  relations: RunGraphAssetRelation[];
  gaps: string[];
}

/** Only saved manifest and exact, provenance-checked runtime bindings enter the run graph. */
export function projectRunGraphAssets(view: ProcessView, manifest: InputManifest, versions: AssetVersion[]): RunGraphAssets {
  const run=view.run;
  if(manifest.spaceId!==run.spaceId||manifest.caseId!==run.caseId||manifest.id!==run.inputManifestId)
    throw new Error('Run graph input manifest does not match the run');
  const nodes=new Map(view.contract?.nodes.map(node=>[node.id,node])??[]);
  const assetById=new Map(versions.filter(asset=>asset.spaceId===run.spaceId).map(asset=>[asset.id,asset]));
  const inputSlots=new Map<string,string[]>();
  for(const [slot,id] of Object.entries(manifest.assets)) inputSlots.set(id,[...(inputSlots.get(id)??[]),slot]);
  const assets=new Map<string,RunGraphAsset>();
  const gaps:string[]=[];
  for(const [id,slots] of inputSlots) {
    const asset=assetById.get(id);
    if(!asset){gaps.push(`Frozen input ${slots.join(', ')} is unavailable`);continue;}
    if(nodes.has(id)){gaps.push(`Asset ID ${id} conflicts with a method node`);continue;}
    assets.set(id,{id,kind:'frozen-input',slots,schema:asset.schema});
  }
  const relations=new Map<string,RunGraphAssetRelation>();
  const link=(assetId:string,nodeId:string,kind:RunGraphAssetRelation['kind'],occurrenceId:string):void=>{
    const key=JSON.stringify([assetId,nodeId,kind]);
    const prior=relations.get(key);
    if(prior){if(!prior.occurrenceIds.includes(occurrenceId))prior.occurrenceIds.push(occurrenceId);}
    else relations.set(key,{assetId,nodeId,kind,occurrenceIds:[occurrenceId]});
  };
  for(const occurrence of view.occurrences) {
    const node=occurrence.nodeId?nodes.get(occurrence.nodeId):undefined;
    if(!node)continue;
    for(const asset of versions){
      if((asset.source.kind!=='historical-artifact'&&asset.source.kind!=='external-artifact')||asset.source.runId!==run.runId||
        !occurrence.stepRunIds.includes(asset.source.stepRunId))continue;
      if(nodes.has(asset.id)){gaps.push(`Asset ID ${asset.id} conflicts with a method node`);continue;}
      if(!assets.has(asset.id))assets.set(asset.id,{id:asset.id,kind:'published-output',slots:[],schema:asset.schema,producerNodeId:node.id});
      link(asset.id,node.id,'produces',occurrence.id);
    }
    for(const binding of occurrence.outputBindings){
      if(!occurrence.contextIds.includes(binding.contextId))continue;
      const asset=assetById.get(binding.assetVersionId);
      if(!asset||asset.source.kind!=='node'||asset.source.runId!==run.runId||
        asset.source.contextId!==binding.contextId||!occurrence.stepRunIds.includes(asset.source.stepRunId)||
        asset.source.nodeId!==(node.storageNodeId??node.id))continue;
      if(nodes.has(asset.id)){gaps.push(`Asset ID ${asset.id} conflicts with a method node`);continue;}
      // A manifest version remains an input even when a later node also binds it.
      if(!assets.has(asset.id))assets.set(asset.id,{id:asset.id,kind:'published-output',slots:[],schema:asset.schema,producerNodeId:node.id});
      const projected=assets.get(asset.id)!;
      if(projected.kind==='published-output'&&projected.producerNodeId===node.id){
        if(!projected.slots.includes(binding.slot))projected.slots.push(binding.slot);
        link(asset.id,node.id,'produces',occurrence.id);
      }
    }
  }
  for(const occurrence of view.occurrences){
    const node=occurrence.nodeId?nodes.get(occurrence.nodeId):undefined;
    if(!node)continue;
    for(const binding of occurrence.inputBindings){
      if(!occurrence.contextIds.includes(binding.contextId)||!assets.has(binding.assetVersionId))continue;
      link(binding.assetVersionId,node.id,'consumes',occurrence.id);
    }
  }
  return {assets:[...assets.values()],relations:[...relations.values()],gaps};
}
