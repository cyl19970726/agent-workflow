import {describe,expect,it} from 'vitest';
import type {SessionEvent} from '@signal-room/workflow-spaces';
import {runtimeEventReadings} from './runtime-read.js';

const event=(seq:number,type:string,data:unknown,attemptId='attempt-1'):SessionEvent=>({id:`event-${seq}`,sessionId:'session-1',attemptId,seq,kind:'trace',
  body:{type,data},createdAt:`2026-10-10T00:00:${String(seq).padStart(2,'0')}Z`});

describe('bounded runner evidence projection',()=>{
  it('retains actual provider tool definitions and pairs repeated tool names by call ID',()=>{
    const readings=runtimeEventReadings([
      event(1,'siwc.started',{model:'model',instructions:'Provider instructions',toolDefinitions:[{name:'read_bound_asset',description:'Read allowed slot',parameters:{type:'object',properties:{slot:{enum:['materials','opportunity','research']}}}}]}),
      event(2,'siwc.tool_call',{turn:1,name:'read_bound_asset',callId:'call-a',arguments:{slot:'materials'}}),
      event(3,'siwc.tool_result',{turn:1,name:'read_bound_asset',callId:'call-a',output:{title:'Material'}}),
      event(4,'siwc.tool_call',{turn:2,name:'read_bound_asset',callId:'call-b',arguments:{slot:'research'}}),
      event(5,'siwc.tool_failed',{turn:2,name:'read_bound_asset',callId:'call-b',outcomeUnknown:true}),
    ],value=>value);
    expect(readings.events[0]).toMatchObject({providerInstructions:'Provider instructions',providerModel:'model',toolDefinitions:[{description:'Read allowed slot',parameters:{properties:{slot:{enum:['materials','opportunity','research']}}},outputSchema:null,outputSchemaCoverage:'not-recorded'}]});
    expect(readings.calls).toEqual([
      {callId:'call-a',name:'read_bound_asset',turn:1,callEventId:'event-2',callSeq:2,outcomeEventId:'event-3',outcomeSeq:3,status:'returned'},
      {callId:'call-b',name:'read_bound_asset',turn:2,callEventId:'event-4',callSeq:4,outcomeEventId:'event-5',outcomeSeq:5,status:'failed-outcome-unknown'},
    ]);
    expect(readings.events.at(-1)).toMatchObject({outcomeUnknown:true});
  });
  it('marks missing cross-page partners and truncation without inventing a failed call',()=>{
    const call=runtimeEventReadings([event(6,'siwc.tool_call',{turn:1,name:'read_bound_asset',callId:'shared',arguments:{text:'large'}})],value=>value);
    const result=runtimeEventReadings([event(7,'siwc.tool_result',{turn:1,name:'read_bound_asset',callId:'shared',output:{text:'large'}})],value=>value);
    expect(call.calls[0]).toMatchObject({status:'pending-or-later-page',outcomeEventId:null});
    expect(result.calls[0]).toMatchObject({status:'returned',callEventId:null});
    expect(runtimeEventReadings([event(8,'siwc.started',{instructions:'x'.repeat(16_385),toolDefinitions:[]})],value=>({...(value as object),instructions:'x'.repeat(16_384)})).events[0]?.bodyCoverage).toBe('truncated');
    expect(runtimeEventReadings([event(10,'siwc.tool_result',{callId:'large',name:'read_bound_asset',output:{text:'x'.repeat(80_000)}})],value=>value).events[0]).toMatchObject({bodyCoverage:'truncated',output:null});
    expect(runtimeEventReadings([event(9,'siwc.response_delta',{text:'private'})],value=>value).events).toEqual([]);
  });
});
