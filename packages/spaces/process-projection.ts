import type { AttemptRecord, StepRecord, WorkflowEvent } from '@signal-room/workflow';
import type { ProcessContract, ProcessContractDraft } from './process-contract.js';
import type { AssetVersion, NodeContext, NodeOccurrenceAnnotation, SpaceRun, WorkflowVersion, ProcessDecisionObservation } from './types.js';
import type { RelationProjection } from './relation.js';
import { validateRelationEvent } from './relation.js';

export interface HistoricalProcessResolverInput {
  run: SpaceRun; workflow: WorkflowVersion; steps: StepRecord[]; contexts: NodeContext[]; events: WorkflowEvent[];
}
export interface HistoricalProcessResolution {
  resolverVersion: string;
  contract: ProcessContractDraft;
  mappings: Array<{stepRunId: string; annotation: NodeOccurrenceAnnotation; evidence: string}>;
  routes?: Array<{edgeId: string; eventSeq: number; stepRunId?: string; round?: number; reason?: string; observation?: {route:string;round?:number}}>;
  /** Explanatory exact-version links. The shared service validates schemas, pointers and case scope. */
  relations?: RelationProjection[];
}
/** Registered by executable workflow ID on the trusted host, never by a browser caller. */
export type HistoricalProcessResolver = (input: HistoricalProcessResolverInput) => HistoricalProcessResolution | Promise<HistoricalProcessResolution>;
export interface ProcessOccurrence {
  id: string; nodeId?: string; round?: number; branch?: string; route?: string;
  provenance: 'observed' | 'derived' | 'unknown'; evidence?: string;
  stepRunIds: string[]; contextIds: string[]; attemptIds: string[];
  attemptRecords: AttemptRecord[];
  technicalSteps: Array<Pick<StepRecord,'id'|'key'|'kind'|'state'|'error'>>;
  sessionIds: string[];
  lifecycleEvidence: Array<Pick<WorkflowEvent,'id'|'seq'|'type'|'timestamp'|'stepRunId'|'attemptId'> & {error?:string;summary?:string}>;
  inputBindings: Array<{contextId:string;slot:string;assetVersionId:string}>;
  outputBindings: Array<{contextId:string;slot:string;assetVersionId:string}>;
  state: StepRecord['state']; phasePath?: readonly string[];
  inputs: Record<string,string>; outputs: Record<string,string[]>;
  generatedByOccurrenceId?: string;
}
export interface ProcessView {
  run: SpaceRun;
  contract?: ProcessContract;
  contractSource: 'method' | 'retrospective' | 'unknown';
  resolverVersion?: string;
  occurrences: ProcessOccurrence[];
  routes: Array<{edgeId: string; eventSeq?: number; stepRunId?: string; round?: number; reason?: string; selectionOnly?:boolean; provenance:'observed'|'derived'}>;
  relations: RelationProjection[];
  unmappedStepIds: string[];
  coverage: 'observed' | 'partial' | 'unknown';
}

/** A business occurrence can span retries and a separate publication step. */
function occurrenceState(occurrence: ProcessOccurrence, node: ProcessContract['nodes'][number] | undefined,
  contract: ProcessContract | undefined, contextSteps: Map<string,StepRecord>): StepRecord['state'] {
  const states=occurrence.technicalSteps.map(step=>step.state);
  // An unfinished part of the occurrence prevents a completion claim.
  for(const state of ['waiting','running','queued'] as const) if(states.includes(state))return state;
  for(const state of ['blocked','needs_review','canceled'] as const) if(states.includes(state))return state;

  const ports=Object.entries(node?.outputs??{});
  const resultPorts=new Set(contract?.results.filter(result=>result.nodeId===node?.id).map(result=>result.outputPort));
  // An omitted minimum has unknown cardinality unless a result role makes the
  // port obligatory. Never infer recovery from one arbitrary output in that case.
  const knownOutputs=ports.length>0&&ports.every(([name,port])=>port.min!==undefined||resultPorts.has(name));
  const hasRequiredOutput=ports.some(([name,port])=>(port.min??0)>0||resultPorts.has(name));
  const completeOutputs=knownOutputs&&hasRequiredOutput&&ports.every(([name,port])=>{
    const required=Math.max(port.min??0,resultPorts.has(name)?1:0);
    const versions=new Set(occurrence.outputBindings.filter(binding=>binding.slot===port.slot&&
      contextSteps.get(binding.contextId)?.state==='succeeded').map(binding=>binding.assetVersionId));
    return versions.size>=required;
  });
  if(completeOutputs&&states.includes('succeeded'))return 'succeeded';
  if(states.every(state=>state==='succeeded'))return knownOutputs&&hasRequiredOutput&&!completeOutputs?'needs_review':'succeeded';
  if(states.includes('failed'))return 'failed';
  return 'failed';
}

export function projectProcess(input: {
  run: SpaceRun; contract?: ProcessContract; contractSource: ProcessView['contractSource']; resolver?: HistoricalProcessResolution;
  steps: StepRecord[]; attempts: AttemptRecord[]; contexts: NodeContext[]; outputs: Array<{contextId:string;slot:string;versionId:string}>;
  assets: AssetVersion[]; relations: RelationProjection[]; events?: WorkflowEvent[]; decisions?:ProcessDecisionObservation[];
}): ProcessView {
  const {run,contract,contractSource,resolver,steps,attempts,contexts,outputs,assets}=input;
  const events=input.events??[];
  const byStep=new Map<string,ProcessOccurrence>();
  const mapping=new Map(resolver?.mappings.map(item=>[item.stepRunId,item])??[]);
  const nodes=new Map(contract?.nodes.map(node=>[node.id,node])??[]);
  for(const step of steps) {
    const matching=contexts.filter(context=>context.stepRunId===step.id);
    const decision=input.decisions?.find(item=>item.stepRunId===step.id);
    const recorded=matching.find(context=>context.process)?.process??decision?.annotation;
    const derived=mapping.get(step.id);
    const annotation=recorded??derived?.annotation;
    const valid=annotation && nodes.get(annotation.nodeId) && matching.every(context=>
      context.nodeId===nodes.get(annotation.nodeId)?.storageNodeId && (!context.process || JSON.stringify(context.process)===JSON.stringify(annotation)));
    const occurrence:ProcessOccurrence={id:step.id,...(valid?{nodeId:annotation.nodeId,round:annotation.round,branch:annotation.branch,route:annotation.route}:{}),
      provenance:valid?(recorded?'observed':'derived'):'unknown',...(valid&&derived&&!recorded?{evidence:derived.evidence}:{}),
      stepRunIds:[step.id],contextIds:matching.map(context=>context.id),
      attemptIds:attempts.filter(attempt=>attempt.stepRunId===step.id).map(attempt=>attempt.id),
      attemptRecords:attempts.filter(attempt=>attempt.stepRunId===step.id),
      technicalSteps:[{id:step.id,key:step.key,kind:step.kind,state:step.state,...(step.error?{error:step.error}:{})}],
      sessionIds:[...new Set(matching.map(context=>context.sessionId))],
      lifecycleEvidence:events.filter(event=>event.stepRunId===step.id && /(?:failed|error|recover|retry|completed|succeeded|decision\.recorded)/.test(event.type)).map(event=>{
        const data=event.data as {error?:unknown;reason?:unknown}|undefined;
        return {id:event.id,seq:event.seq,type:event.type,timestamp:event.timestamp,stepRunId:event.stepRunId,attemptId:event.attemptId,
          ...(typeof data?.error==='string'?{error:data.error}:{}),...(typeof data?.reason==='string'?{summary:data.reason}:{})};
      }),
      inputBindings:matching.flatMap(context=>Object.entries(context.inputs).map(([slot,input])=>({contextId:context.id,slot,assetVersionId:input.assetVersionId}))),
      outputBindings:outputs.filter(output=>matching.some(context=>context.id===output.contextId)).map(output=>({contextId:output.contextId,slot:output.slot,assetVersionId:output.versionId})),
      state:step.state,...(step.phasePath?{phasePath:step.phasePath}:{}),inputs:{},outputs:{}};
    for(const context of matching) for(const [slot,bound] of Object.entries(context.inputs)) occurrence.inputs[slot]=bound.assetVersionId;
    for(const output of outputs.filter(output=>matching.some(context=>context.id===output.contextId)))
      occurrence.outputs[output.slot]=[...(occurrence.outputs[output.slot]??[]),output.versionId];
    byStep.set(step.id,occurrence);
  }
  // Program publication records can have their own technical step. The observed
  // origin context proves which Agent occurrence generated them.
  const merged=new Set<string>();
  for(const context of contexts) {
    if(!context.generatedByContextId) continue;
    const origin=contexts.find(item=>item.id===context.generatedByContextId);
    if(!origin) continue;
    const target=byStep.get(origin.stepRunId),source=byStep.get(context.stepRunId);
    if(!target||!source||target===source) continue;
    target.stepRunIds.push(...source.stepRunIds);
    target.contextIds.push(...source.contextIds);
    target.attemptIds.push(...source.attemptIds);
    target.attemptRecords.push(...source.attemptRecords); target.technicalSteps.push(...source.technicalSteps);
    target.sessionIds=[...new Set([...target.sessionIds,...source.sessionIds])];
    target.lifecycleEvidence.push(...source.lifecycleEvidence);
    target.inputBindings.push(...source.inputBindings);target.outputBindings.push(...source.outputBindings);
    source.generatedByOccurrenceId=target.id;
    for(const [slot,ids] of Object.entries(source.outputs)) target.outputs[slot]=[...(target.outputs[slot]??[]),...ids];
    merged.add(source.id);
  }
  // Several real technical steps may implement one explicitly annotated business round.
  const business=new Map<string,ProcessOccurrence>();
  for(const item of byStep.values()) {
    if(merged.has(item.id)||!item.nodeId||item.round===undefined) continue;
    const key=JSON.stringify([item.nodeId,item.round,item.branch??null]);
    const target=business.get(key);
    if(!target) {business.set(key,item);continue;}
    target.stepRunIds.push(...item.stepRunIds);target.contextIds.push(...item.contextIds);target.attemptIds.push(...item.attemptIds);
    target.attemptRecords.push(...item.attemptRecords);target.technicalSteps.push(...item.technicalSteps);
    target.sessionIds=[...new Set([...target.sessionIds,...item.sessionIds])];target.lifecycleEvidence.push(...item.lifecycleEvidence);
    target.inputBindings.push(...item.inputBindings);target.outputBindings.push(...item.outputBindings);
    Object.assign(target.inputs,item.inputs);
    for(const [slot,ids] of Object.entries(item.outputs))target.outputs[slot]=[...(target.outputs[slot]??[]),...ids];
    merged.add(item.id);
  }
  const occurrences=[...byStep.values()].filter(item=>!merged.has(item.id));
  const stepById=new Map(steps.map(step=>[step.id,step]));
  const contextSteps=new Map(contexts.flatMap(context=>{
    const step=stepById.get(context.stepRunId);
    return step?[[context.id,step] as const]:[];
  }));
  for(const occurrence of occurrences) occurrence.state=occurrenceState(occurrence,nodes.get(occurrence.nodeId??''),contract,contextSteps);
  const relations=[...input.relations];
  const assetById=new Map(assets.map(asset=>[asset.id,asset]));
  for(const occurrence of occurrences) {
    const node=nodes.get(occurrence.nodeId??'');
    for(const map of contract?.relationMappings??[]) {
      if(run.process || map.nodeId!==node?.id || map.policy==='explicit') continue;
      const type=contract?.relationTypes?.find(item=>item.id===map.typeId);
      const outputSlot=node.outputs?.[map.outputPort]?.slot,inputSlot=map.inputPort?node.inputs?.[map.inputPort]?.slot:undefined;
      if(!type||!outputSlot||!inputSlot) continue;
      const targetId=occurrence.inputs[inputSlot];
      const target=targetId?assetById.get(targetId):undefined;
      for(const fromId of occurrence.outputs[outputSlot]??[]) {
        const from=assetById.get(fromId);
        if(!from||!target) continue;
        try {validateRelationEvent(type,from,target);} catch {continue;}
        if(relations.some(relation=>relation.typeId===map.typeId&&relation.from.assetVersionId===fromId&&relation.to.assetVersionId===targetId)) continue;
        relations.push({id:`derived:${map.id}:${fromId}:${target.id}`,typeId:map.typeId,from:{assetVersionId:fromId},to:{assetVersionId:target.id},
          provenance:occurrence.provenance==='observed'?'derived':'retrospective',
          evidence:{kind:'validated-port-binding',runId:run.runId,stepRunId:occurrence.id,mappingId:map.id,...(resolver?{resolverVersion:resolver.resolverVersion}:{})}});
      }
    }
  }
  const observedRoutes=contexts.flatMap(context=>{
    const edge=contract?.edges.find(item=>item.from===context.process?.nodeId&&item.route===context.process?.route);
    const event=events.find(item=>item.seq===context.process?.decisionEventSeq && item.type==='decision.recorded');
    const raw=event?.data as {route?:string;round?:number;decision?:unknown}|undefined;
    const data=(raw?.decision??raw) as {route?:string;round?:number}|undefined;
    return edge&&event&&data?.route===edge.route&&(!context.process?.round||data?.round===context.process.round)?[{edgeId:edge.id,eventSeq:event.seq,stepRunId:context.stepRunId,
      ...(context.process?.round?{round:context.process.round}:{}),provenance:'observed' as const}]:[];
  });
  const selections=(input.decisions??[]).map(item=>({edgeId:item.edgeId,eventSeq:item.eventSeq,stepRunId:item.stepRunId,round:item.annotation.round,reason:item.reason,selectionOnly:true,provenance:'observed' as const}));
  for(const selection of selections) {
    const explanation=resolver?.routes?.find(route=>route.eventSeq===selection.eventSeq&&route.edgeId===selection.edgeId&&route.round===selection.round);
    if(explanation?.reason)selection.reason=explanation.reason;
  }
  const routes=[...observedRoutes,...selections,...(resolver?.routes??[]).filter(route=>
    !selections.some(item=>item.eventSeq===route.eventSeq&&item.edgeId===route.edgeId&&item.round===route.round)&&
    contract?.edges.some(edge=>edge.id===route.edgeId)).map(route=>({...route,provenance:'derived' as const}))];
  const unmappedStepIds=occurrences.filter(item=>!item.nodeId).flatMap(item=>item.stepRunIds);
  return {run,contract,contractSource,...(resolver?{resolverVersion:resolver.resolverVersion}:{}),occurrences,routes,relations,
    unmappedStepIds,coverage:!contract?'unknown':unmappedStepIds.length?'partial':occurrences.some(item=>item.provenance==='derived')?'partial':'observed'};
}
