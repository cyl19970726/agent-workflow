/** Bounded, read-only evidence index for one authenticated Space run. The caller owns HTTP authentication and safe projections. */
type Row=Record<string,unknown>;
type Projector=(raw:unknown)=>Row;
export interface RunEvidenceOptions {
  get:(path:string)=>Promise<unknown>;
  spaceId:string;
  runId:string;
  occurrenceId?:string;
  maxPages?:number;
  maxOccurrences?:number;
  project:{run:Projector;inputs:Projector;process:Projector;occurrence:Projector;asset:Projector};
}

const row=(value:unknown,name:string):Row=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`Invalid ${name}`);return value as Row;};
const str=(value:unknown,name:string):string=>{if(typeof value!=='string'||!value)throw Error(`Invalid ${name}`);return value;};
const array=(value:unknown,name:string):unknown[]=>{if(!Array.isArray(value))throw Error(`Invalid ${name}`);return value;};
const same=(value:unknown,expected:string,name:string)=>{if(value!==expected)throw Error(`Run evidence relationship mismatch: ${name}`);};
const code=(value:string)=>encodeURIComponent(value);
const apiStatus=(error:unknown):number|null=>{
  const value=error as {status?:unknown;response?:{status?:unknown}};
  const status=value?.status??value?.response?.status;
  if(typeof status==='number')return status;
  const match=error instanceof Error?/HTTP\s+(\d{3})/u.exec(error.message):null;
  return match?Number(match[1]):null;
};
const optionalFailure=(error:unknown):boolean=>{const status=apiStatus(error);return status===404||status!==null&&status>=500;};
const argv=(...args:string[])=>['workflow-space-operator',...args];

export async function collectRunEvidence(options:RunEvidenceOptions):Promise<Record<string,unknown>>{
  const {get,spaceId,runId,project}=options;
  const maxPages=options.maxPages??2,maxOccurrences=options.maxOccurrences??10;
  if(!spaceId||!runId||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>10||!Number.isSafeInteger(maxOccurrences)||maxOccurrences<1||maxOccurrences>50)
    throw Error('Invalid run evidence scope or bounds');
  const summary=row(await get('/summary'),'Space summary');same(summary.id,spaceId,'Space');
  const run=project.run(await get(`/runs/${code(runId)}`));same(run.id,runId,'run');
  const versionId=str(run.versionId,'run.versionId'),caseId=str(run.caseId,'run.caseId');
  const inputs=project.inputs(await get(`/runs/${code(runId)}/inputs`));
  same(inputs.runId,runId,'input run');same(inputs.versionId,versionId,'input version');same(inputs.caseId,caseId,'input Case');
  same(inputs.inputManifestId,str(run.inputManifestId,'run.inputManifestId'),'input manifest');same(inputs.inputManifestHash,str(run.inputManifestHash,'run.inputManifestHash'),'input manifest hash');
  const process=project.process(await get(`/runs/${code(runId)}/process`));
  same(process.runId,runId,'process run');same(process.versionId,versionId,'process version');same(process.caseId,caseId,'process Case');
  const inputSlots=array(inputs.slots,'input slots').map(value=>{
    const selected=row(value,'input slot'),asset=project.asset(row(selected.asset,'input asset'));
    same(asset.id,row(selected.asset,'input asset').id as string,'input asset');
    return {slot:str(selected.slot,'input slot name'),asset,payloadHash:str(selected.payloadHash,'input payload hash'),read:{asset:argv('asset',str(asset.id,'input asset ID'))}};
  });
  const allOccurrences=array(process.occurrences,'process occurrences').map(value=>row(value,'process occurrence'));
  const occurrenceIds=new Set<string>();
  for(const item of allOccurrences){const selectedId=str(item.id,'occurrence ID');if(occurrenceIds.has(selectedId))throw Error('Run evidence relationship mismatch: duplicate occurrence ID');occurrenceIds.add(selectedId);}
  const selected=options.occurrenceId?allOccurrences.filter(value=>value.id===options.occurrenceId):allOccurrences.slice(0,maxOccurrences);
  if(options.occurrenceId&&selected.length!==1)throw Error('Run evidence relationship mismatch: occurrence ID');
  const truncatedOccurrences=!options.occurrenceId&&allOccurrences.length>selected.length;
  const missing:string[]=[],partial:string[]=[],truncated:string[]=[];
  if(truncatedOccurrences)truncated.push('occurrences');
  if(process.coverage!=='observed')partial.push('process coverage');
  if(array(process.unmappedStepIds??[],'unmapped steps').length)partial.push('unmapped process steps');
  const occurrences:Row[]=[];
  for(const item of selected){
    const occurrenceId=str(item.id,'occurrence ID');
    if(!options.occurrenceId){
      const outputs=array(item.outputs,'occurrence outputs').map(value=>{
        const asset=project.asset(value);
        same(asset.runId,runId,'output run');same(asset.versionId,versionId,'output version');same(asset.caseId,caseId,'output Case');same(asset.occurrenceId,occurrenceId,'output occurrence');
        if(item.nodeId!==null)same(asset.nodeId,str(item.nodeId,'occurrence node'),'output node');
        return {...asset,read:{asset:argv('asset',str(asset.id,'output asset ID'))}};
      });
      if(!outputs.length&&item.state==='failed')missing.push(`output:${occurrenceId}`);
      occurrences.push({id:occurrenceId,nodeId:item.nodeId,label:item.label,provenance:item.provenance,state:item.state,
        round:item.round??null,branch:item.branch??null,route:item.route??null,
        terminalFailure:item.terminalFailure??null,technicalSteps:item.technicalSteps,failureDetails:item.failureDetails,
        attemptCount:item.attemptCount,agentAttemptCount:item.agentAttemptCount??null,technicalStepCount:item.technicalStepCount,
        outputs,detailLoaded:false,attempts:null,runtime:null,trace:null,
        read:{evidence:argv('run-evidence',runId,'--occurrence',occurrenceId),occurrence:argv('occurrence',runId,occurrenceId),responses:argv('occurrence-responses',runId,occurrenceId)}});
      continue;
    }
    const detail=project.occurrence(await get(`/runs/${code(runId)}/occurrences/${code(occurrenceId)}`));
    same(detail.id,occurrenceId,'occurrence');same(detail.runId,runId,'occurrence run');same(detail.versionId,versionId,'occurrence version');
    if(item.nodeId!==detail.nodeId)throw Error('Run evidence relationship mismatch: occurrence node');
    const outputs=array(detail.outputs,'occurrence outputs').map(value=>{
      const asset=project.asset(value);
      same(asset.runId,runId,'output run');same(asset.versionId,versionId,'output version');same(asset.caseId,caseId,'output Case');same(asset.occurrenceId,occurrenceId,'output occurrence');
      if(detail.nodeId!==null)same(asset.nodeId,detail.nodeId as string,'output node');
      return {...asset,read:{asset:argv('asset',str(asset.id,'output asset ID'))}};
    });
    const contexts=array(detail.contexts,'occurrence contexts');
    const contextIds=new Set<string>(),attemptIds=new Set<string>();
    for(const value of contexts){const context=row(value,'context'),contextId=str(context.id,'context ID'),attemptId=str(context.attemptId,'attempt ID');
      if(contextIds.has(contextId)||attemptIds.has(attemptId))throw Error('Run evidence relationship mismatch: duplicate context or attempt ID');
      contextIds.add(contextId);attemptIds.add(attemptId);
    }
    const attempts:Row[]=[];
    for(const value of contexts){
      const context=row(value,'context'),attemptId=str(context.attemptId,'attempt ID'),sessionId=str(context.sessionId,'session ID');
      const contextId=str(context.id,'context ID'),stepRunId=str(context.stepRunId,'step run ID'),producer=str(context.producer,'producer');
      if(producer!=='agent'&&producer!=='program')throw Error('Invalid context producer');
      if(detail.nodeId!==null)same(context.nodeId,detail.nodeId as string,'context node');
      let runtime:Row={state:producer==='program'?'not-applicable':'unknown',observedEvents:0,observedCalls:0,scanComplete:false,hasMore:false};
      let trace:Row={state:producer==='program'?'not-applicable':'unknown',sampledEvents:0};
      if(producer==='agent'){
        let after=0,hasMore=true,first:Row|undefined,eventCount=0,callIds=new Set<string>(),bodyTruncated=false;
        try{
          for(let pageNumber=0;hasMore&&pageNumber<maxPages;pageNumber++){
            const response=row(await get(`/runs/${code(runId)}/occurrences/${code(occurrenceId)}/runtime?attemptId=${code(attemptId)}&after=${after}&limit=100`),'runtime page');
            same(response.runId,runId,'runtime run');same(response.versionId,versionId,'runtime version');same(response.occurrenceId,occurrenceId,'runtime occurrence');
            same(response.attemptId,attemptId,'runtime attempt');same(response.stepRunId,stepRunId,'runtime step');
            same(response.contextId,contextId,'runtime context');same(response.sessionId,sessionId,'runtime session');
            if(response.sanitized!==true)throw Error('Run evidence relationship mismatch: unsanitized runtime');
            if(first&&['runId','versionId','occurrenceId','attemptId','stepRunId','contextId','sessionId'].some(key=>response[key]!==first![key]))throw Error('Run evidence relationship mismatch: runtime page identity');
            first??=response;
            const next=response.nextCursor;
            if(!Number.isSafeInteger(next)||Number(next)<after||typeof response.hasMore!=='boolean'||response.scanComplete!==!response.hasMore||response.hasMore&&Number(next)<=after)
              throw Error('Run evidence relationship mismatch: runtime cursor');
            for(const event of array(response.events,'runtime events')){
              const record=row(event,'runtime event');same(record.attemptId,attemptId,'runtime event attempt');
              if(record.bodyCoverage==='truncated')bodyTruncated=true;
              eventCount++;
            }
            for(const call of array(response.calls,'runtime calls'))callIds.add(str(row(call,'runtime call').callId,'runtime call ID'));
            after=Number(next);hasMore=response.hasMore as boolean;
          }
          runtime={state:hasMore?'truncated':first?'saved':'missing',observedEvents:eventCount,observedCalls:callIds.size,scanComplete:!hasMore,hasMore,nextCursor:after,bodyCoverage:bodyTruncated?'truncated':'unknown'};
          if(hasMore)truncated.push(`runtime:${occurrenceId}:${attemptId}`);
          if(bodyTruncated)partial.push(`runtime bodies:${occurrenceId}:${attemptId}`);
          if(!first)missing.push(`runtime:${occurrenceId}:${attemptId}`);
        }catch(error){if(!optionalFailure(error))throw error;runtime={state:'unavailable',observedEvents:eventCount,observedCalls:callIds.size,scanComplete:false,hasMore:false,httpStatus:apiStatus(error)};partial.push(`runtime:${occurrenceId}:${attemptId}`);}
        try{
          const response=row(await get(`/runs/${code(runId)}/sessions/${code(sessionId)}/events?after=0&limit=1`),'trace page');
          same(response.runId,runId,'trace run');same(response.sessionId,sessionId,'trace session');
          const events=array(response.items,'trace items');
          const matching=events.filter(event=>row(event,'trace event').attemptId===attemptId);
          const next=response.nextCursor;
          if(!Number.isSafeInteger(next)||Number(next)<0||typeof response.hasMore!=='boolean'||response.hasMore&&Number(next)<=0)
            throw Error('Run evidence relationship mismatch: trace cursor');
          trace={state:response.hasMore?matching.length?'preview':'unknown':matching.length?'saved':'missing',sampledEvents:matching.length,hasMore:response.hasMore,scanComplete:!response.hasMore};
          if(response.hasMore)partial.push(`trace preview:${occurrenceId}:${attemptId}`);
          else if(!matching.length)missing.push(`trace:${occurrenceId}:${attemptId}`);
        }catch(error){if(!optionalFailure(error))throw error;trace={state:'unavailable',sampledEvents:0,httpStatus:apiStatus(error)};partial.push(`trace:${occurrenceId}:${attemptId}`);}
      }
      attempts.push({contextId,stepRunId,attemptId,sessionId,producer,nodeId:context.nodeId,
        model:producer==='agent'?context.model??null:null,reasoningEffort:producer==='agent'?context.reasoningEffort??null:null,
        runtime,trace,read:{occurrence:argv('occurrence',runId,occurrenceId),...(producer==='agent'?{runtime:argv('runtime',runId,occurrenceId,attemptId),trace:argv('run-trace',runId,sessionId)}:{})}});
    }
    if(!outputs.length&&detail.state==='failed')missing.push(`output:${occurrenceId}`);
    occurrences.push({id:occurrenceId,nodeId:detail.nodeId,label:detail.label,provenance:detail.provenance,state:detail.state,
      round:detail.round??null,branch:detail.branch??null,route:detail.route??null,
      terminalFailure:detail.terminalFailure??null,technicalSteps:detail.technicalSteps,failureDetails:detail.failureDetails,
      attemptCount:detail.attemptCount,agentAttemptCount:detail.agentAttemptCount??null,technicalStepCount:detail.technicalStepCount,
      outputs,detailLoaded:true,attempts,read:{evidence:argv('run-evidence',runId,'--occurrence',occurrenceId),occurrence:argv('occurrence',runId,occurrenceId),responses:argv('occurrence-responses',runId,occurrenceId)}});
  }
  const coverage={state:partial.length||truncated.length?'partial':missing.length?'incomplete':'bounded',missing,partial,truncated,
    selectedOccurrences:occurrences.length,totalOccurrences:allOccurrences.length,occurrencesComplete:!truncatedOccurrences,
    occurrenceDetail:options.occurrenceId?'selected-only':'not-loaded',runtime:options.occurrenceId?'selected-only':'not-loaded',trace:options.occurrenceId?'selected-only':'not-loaded'};
  return {spaceId,runId,run,version:{id:versionId,label:run.versionLabel??null,detailLoaded:false},case:{id:caseId,title:run.caseTitle??null,detailLoaded:false},inputManifest:{id:inputs.inputManifestId,hash:inputs.inputManifestHash,slots:inputSlots},
    process:{contractSource:process.contractSource,coverage:process.coverage,unmappedStepIds:process.unmappedStepIds},occurrences,coverage,
    read:{run:argv('run',runId),inputs:argv('run-inputs',runId),process:argv('process',runId),version:argv('version',versionId),case:argv('case',caseId),
      reviewSubjects:argv('review-subjects',runId),reviews:argv('reviews',runId),dispositions:argv('dispositions',runId),diagnosis:argv('diagnosis',runId)}};
}
