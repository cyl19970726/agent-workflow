import {describe,expect,it} from 'vitest';
import {collectRunEvidence,type RunEvidenceOptions} from './operator-evidence.js';

const asset=(id:string,source:'node'|'import'='node')=>({id,title:id,kind:'draft',state:'candidate',createdAt:'now',schema:{namespace:'draft',revision:'1',hash:'schema'},sourceKind:source,
  runId:source==='node'?'r':null,caseId:source==='node'?'c':'other-case',versionId:source==='node'?'v':null,nodeId:source==='node'?'author':null,occurrenceId:source==='node'?'o':null,round:null});
const run={id:'r',versionId:'v',caseId:'c',entrypoint:'content',executionMode:'research-trial',inputManifestId:'m',inputManifestHash:'h',label:'Run',state:'failed',taskState:'failed',reason:null,progress:null,startedAt:null,assetCount:0,draftCount:0,primaryAssetId:null,versionLabel:'1',caseTitle:'Case',configHash:'config',inputAssets:[asset('source','import')]};
const inputs={runId:'r',caseId:'c',versionId:'v',inputManifestId:'m',inputManifestHash:'h',slots:[{slot:'opportunity',asset:asset('source','import'),payloadHash:'p'}]};
const context=(id:string,producer:'agent'|'program',sessionId=id)=>({id,nodeId:'author',stepRunId:id,attemptId:id,sessionId,producer,model:producer==='agent'?'model':null,reasoningEffort:null,instructions:'SECRET PROMPT',effectiveConfig:{apiKey:'SECRET'}});
const occurrence={id:'o',nodeId:'author',label:'Author',round:null,branch:null,route:null,provenance:'observed',state:'failed',terminalFailure:null,inputs:[],outputs:[],contextIds:['a1','a2','p1'],sessionIds:['a1','a2','p1'],attemptCount:3,agentAttemptCount:2,technicalStepCount:0,technicalSteps:[],failureDetails:[],runId:'r',versionId:'v',contexts:[context('a1','agent'),context('a2','agent'),context('p1','program')]};
const process={runId:'r',versionId:'v',caseId:'c',contractSource:'method',coverage:'observed',unmappedStepIds:[],nodes:[],occurrences:[occurrence],graphUrl:null};
const project={run:(value:unknown)=>value as typeof run,inputs:(value:unknown)=>value as typeof inputs,process:(value:unknown)=>value as typeof process,
  occurrence:(value:unknown)=>value as typeof occurrence,asset:(value:unknown)=>value as ReturnType<typeof asset>};
function fixture(changes:Record<string,unknown>={},failure:Record<string,number>={}){
  const paths:string[]=[];
  const values:Record<string,unknown>={'/summary':{id:'s'},'/runs/r':run,'/runs/r/inputs':inputs,'/versions/v':{id:'v'},'/cases/c':{id:'c'},'/runs/r/process':process,'/runs/r/occurrences/o':occurrence,
    '/runs/r/occurrences/o/runtime?attemptId=a1&after=0&limit=100':{runId:'r',versionId:'v',occurrenceId:'o',attemptId:'a1',stepRunId:'a1',contextId:'a1',sessionId:'a1',sanitized:true,nextCursor:1,hasMore:false,scanComplete:true,events:[{attemptId:'a1',type:'siwc.started',body:'SECRET'}],calls:[]},
    '/runs/r/occurrences/o/runtime?attemptId=a2&after=0&limit=100':{runId:'r',versionId:'v',occurrenceId:'o',attemptId:'a2',stepRunId:'a2',contextId:'a2',sessionId:'a2',sanitized:true,nextCursor:0,hasMore:false,scanComplete:true,events:[],calls:[]},
    '/runs/r/sessions/a1/events?after=0&limit=1':{runId:'r',sessionId:'a1',nextCursor:1,hasMore:false,items:[{attemptId:'a1',body:'SECRET TRACE'}]},
    '/runs/r/sessions/a2/events?after=0&limit=1':{runId:'r',sessionId:'a2',nextCursor:0,hasMore:false,items:[]},...changes};
  const get=async(path:string)=>{paths.push(path);if(path in failure)throw Object.assign(Error(`HTTP ${failure[path]}`),{status:failure[path]});if(!(path in values))throw Error(`Unexpected GET ${path}`);return values[path];};
  const options:RunEvidenceOptions={get,spaceId:'s',runId:'r',project};
  return {paths,options};
}

describe('bounded operator run evidence',()=>{
  it('uses exactly four reads by default and leaves attempt, runtime, trace and detail explicitly unloaded',async()=>{
    const {options,paths}=fixture({'/runs/r/process':{...process,coverage:'partial',unmappedStepIds:['unknown-1','unknown-2']}});
    const result=await collectRunEvidence(options);
    expect(paths).toEqual(['/summary','/runs/r','/runs/r/inputs','/runs/r/process']);
    expect(result.process).toMatchObject({coverage:'partial',unmappedStepIds:['unknown-1','unknown-2']});
    expect(result.coverage).toMatchObject({state:'partial',partial:['process coverage','unmapped process steps'],occurrenceDetail:'not-loaded',runtime:'not-loaded',trace:'not-loaded'});
    expect(result.occurrences).toMatchObject([{id:'o',detailLoaded:false,attempts:null,runtime:null,trace:null,
      attemptCount:3,agentAttemptCount:2,technicalStepCount:0,failureDetails:[],round:null,branch:null,route:null,
      read:{evidence:['workflow-space-operator','run-evidence','r','--occurrence','o'],occurrence:['workflow-space-operator','occurrence','r','o']}}]);
    expect(result.version).toMatchObject({id:'v',detailLoaded:false});
    expect(result.case).toMatchObject({id:'c',detailLoaded:false});
    expect(result.inputManifest).toMatchObject({slots:[{read:{asset:['workflow-space-operator','asset','source']}}]});
    expect(result.read).toMatchObject({reviewSubjects:['workflow-space-operator','review-subjects','r'],reviews:['workflow-space-operator','reviews','r'],
      dispositions:['workflow-space-operator','dispositions','r'],diagnosis:['workflow-space-operator','diagnosis','r']});
  });
  it('keeps attempts separate, accepts imported inputs from another Case, and excludes bodies and prompts',async()=>{
    const {paths,options}=fixture();
    const result=await collectRunEvidence({...options,occurrenceId:'o'}),items=result.occurrences as Record<string,unknown>[];
    const attempts=items[0]!.attempts as Record<string,unknown>[];
    expect(attempts).toMatchObject([{attemptId:'a1',producer:'agent',runtime:{state:'saved',observedEvents:1},trace:{state:'saved'}},
      {attemptId:'a2',producer:'agent',runtime:{state:'saved',observedEvents:0},trace:{state:'missing'}},
      {attemptId:'p1',producer:'program',runtime:{state:'not-applicable'},trace:{state:'not-applicable'}}]);
    expect(result.coverage).toMatchObject({state:'incomplete',missing:['trace:o:a2','output:o']});
    expect(result.inputManifest).toMatchObject({slots:[{asset:{caseId:'other-case'}}]});
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(paths).not.toContain('/runs/r/occurrences/o/runtime?attemptId=p1&after=0&limit=100');
    expect(attempts[0]?.read).toMatchObject({runtime:['workflow-space-operator','runtime','r','o','a1']});
    expect(items[0]).toMatchObject({agentAttemptCount:2,technicalStepCount:0,failureDetails:[],read:{evidence:['workflow-space-operator','run-evidence','r','--occurrence','o']}});
  });
  it('marks partial local failures and a bounded runtime scan without inventing completeness',async()=>{
    const next='/runs/r/occurrences/o/runtime?attemptId=a1&after=1&limit=100';
    const first='/runs/r/occurrences/o/runtime?attemptId=a1&after=0&limit=100';
    const {options}=fixture({[first]:{runId:'r',versionId:'v',occurrenceId:'o',attemptId:'a1',stepRunId:'a1',contextId:'a1',sessionId:'a1',sanitized:true,nextCursor:1,hasMore:true,scanComplete:false,events:[],calls:[]},
      [next]:{runId:'r',versionId:'v',occurrenceId:'o',attemptId:'a1',stepRunId:'a1',contextId:'a1',sessionId:'a1',sanitized:true,nextCursor:2,hasMore:true,scanComplete:false,events:[],calls:[]}},
      {'/runs/r/sessions/a2/events?after=0&limit=1':500});
    const result=await collectRunEvidence({...options,occurrenceId:'o'}),attempts=(result.occurrences as any[])[0].attempts;
    expect(attempts[0].runtime).toMatchObject({state:'truncated',hasMore:true,scanComplete:false,nextCursor:2});
    expect(attempts[1].trace).toMatchObject({state:'unavailable',httpStatus:500});
    expect(result.coverage).toMatchObject({state:'partial',truncated:['runtime:o:a1'],partial:['trace:o:a2']});
  });
  it('stops on authorization and relationship mismatches',async()=>{
    const auth=fixture({}, {'/runs/r/occurrences/o/runtime?attemptId=a1&after=0&limit=100':403});
    await expect(collectRunEvidence({...auth.options,occurrenceId:'o'})).rejects.toThrow('HTTP 403');
    expect(auth.paths).not.toContain('/runs/r/occurrences/o/runtime?attemptId=a2&after=0&limit=100');
    const mismatch=fixture({'/runs/r/occurrences/o':{...occurrence,outputs:[{...asset('draft'),runId:'other'}]}});
    await expect(collectRunEvidence({...mismatch.options,occurrenceId:'o'})).rejects.toThrow('relationship mismatch: output run');
    const wrongSummary=fixture({'/summary':{id:'other'}});
    await expect(collectRunEvidence(wrongSummary.options)).rejects.toThrow('relationship mismatch: Space');
    expect(wrongSummary.paths).toEqual(['/summary']);
  });
  it('bounds occurrence expansion and rejects repeated runtime cursors',async()=>{
    const second={...occurrence,id:'o2',nodeId:'other',contexts:[],outputs:[],state:'succeeded'};
    const {options,paths}=fixture({'/runs/r/process':{...process,occurrences:[occurrence,second]}});
    const result=await collectRunEvidence({...options,maxOccurrences:1});
    expect(result.coverage).toMatchObject({truncated:['occurrences'],occurrencesComplete:false,totalOccurrences:2});
    expect(paths).not.toContain('/runs/r/occurrences/o2');
    const invalid=fixture({'/runs/r/occurrences/o/runtime?attemptId=a1&after=0&limit=100':{runId:'r',versionId:'v',occurrenceId:'o',attemptId:'a1',stepRunId:'a1',contextId:'a1',sessionId:'a1',sanitized:true,nextCursor:0,hasMore:true,scanComplete:false,events:[],calls:[]}});
    await expect(collectRunEvidence({...invalid.options,occurrenceId:'o'})).rejects.toThrow('relationship mismatch: runtime cursor');
  });
  it('does not assign a shared session’s first trace event to a different attempt',async()=>{
    const selected={...occurrence,contexts:[context('a1','agent','shared'),context('a2','agent','shared')]};
    const runtime1={runId:'r',versionId:'v',occurrenceId:'o',attemptId:'a1',stepRunId:'a1',contextId:'a1',sessionId:'shared',sanitized:true,nextCursor:0,hasMore:false,scanComplete:true,events:[],calls:[]};
    const runtime2={...runtime1,attemptId:'a2',stepRunId:'a2',contextId:'a2'};
    const shared=fixture({'/runs/r/occurrences/o':selected,
      '/runs/r/occurrences/o/runtime?attemptId=a1&after=0&limit=100':runtime1,
      '/runs/r/occurrences/o/runtime?attemptId=a2&after=0&limit=100':runtime2,
      '/runs/r/sessions/shared/events?after=0&limit=1':{runId:'r',sessionId:'shared',nextCursor:1,hasMore:true,items:[{attemptId:'a1',body:'SECRET'}]}});
    const result=await collectRunEvidence({...shared.options,occurrenceId:'o'}),attempts=(result.occurrences as any[])[0].attempts;
    expect(attempts[0].trace).toMatchObject({state:'preview',sampledEvents:1,hasMore:true,scanComplete:false});
    expect(attempts[1].trace).toMatchObject({state:'unknown',sampledEvents:0,hasMore:true,scanComplete:false});
    expect(result.coverage).toMatchObject({state:'partial',partial:['trace preview:o:a1','trace preview:o:a2']});
  });
  it('rejects ambiguous occurrence, context and attempt identities before stitching evidence',async()=>{
    const duplicateOccurrence=fixture({'/runs/r/process':{...process,occurrences:[occurrence,{...occurrence}]}});
    await expect(collectRunEvidence(duplicateOccurrence.options)).rejects.toThrow('duplicate occurrence ID');
    expect(duplicateOccurrence.paths).toEqual(['/summary','/runs/r','/runs/r/inputs','/runs/r/process']);
    for(const contexts of [[context('a1','agent'),context('a1','program')],[context('a1','agent'),{...context('a2','program'),attemptId:'a1'}]]){
      const duplicate=fixture({'/runs/r/occurrences/o':{...occurrence,contexts}});
      await expect(collectRunEvidence({...duplicate.options,occurrenceId:'o'})).rejects.toThrow('duplicate context or attempt ID');
    }
  });
  it('provides exact asset commands for saved output summaries without loading their bodies',async()=>{
    const output=asset('draft');
    const selected={...occurrence,state:'succeeded',outputs:[output]};
    const values={'/runs/r/process':{...process,occurrences:[selected]},'/runs/r/occurrences/o':selected};
    const overview=fixture(values);
    const shallow=await collectRunEvidence(overview.options);
    expect((shallow.occurrences as any[])[0].outputs).toMatchObject([{id:'draft',read:{asset:['workflow-space-operator','asset','draft']}}]);
    expect(overview.paths).toHaveLength(4);
    const expanded=fixture(values);
    const full=await collectRunEvidence({...expanded.options,occurrenceId:'o'});
    expect((full.occurrences as any[])[0].outputs).toMatchObject([{id:'draft',read:{asset:['workflow-space-operator','asset','draft']}}]);
    expect(expanded.paths).not.toContain('/assets/draft');
  });
});
