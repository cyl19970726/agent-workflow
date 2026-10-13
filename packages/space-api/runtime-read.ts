import type {SessionEvent} from '@signal-room/workflow-spaces';

export type RuntimeEventType='siwc.started'|'siwc.tool_call'|'siwc.tool_result'|'siwc.tool_failed';
export interface RuntimeEventReading {
  id:string;seq:number;attemptId:string;createdAt:string;type:RuntimeEventType;
  turn:number|null;callId:string|null;name:string|null;
  providerInstructions:string|null;providerModel:string|null;
  providerToolProfileHash:string|null;argumentsHash:string|null;outputHash:string|null;
  toolDefinitions:{name:string;description:string;parameters:unknown;outputSchema:null;outputSchemaCoverage:'not-recorded'}[]|null;
  arguments?:unknown;output?:unknown;outcomeUnknown:boolean|null;
  bodyCoverage:'full'|'truncated';
}
export interface RuntimeCallReading {
  callId:string;name:string|null;turn:number|null;
  callEventId:string|null;callSeq:number|null;
  outcomeEventId:string|null;outcomeSeq:number|null;
  status:'returned'|'failed-outcome-unknown'|'pending-or-later-page'|'call-on-earlier-page';
}

const record=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text=(value:unknown):string|null=>typeof value==='string'?value:null;
const number=(value:unknown):number|null=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;
const truncated=(value:unknown,depth=0):boolean=>{
  if(depth>8)return true;
  if(typeof value==='string')return value.length>16_384;
  if(Array.isArray(value))return value.length>100||value.some(item=>truncated(item,depth+1));
  if(value&&typeof value==='object'){
    const entries=Object.entries(value);
    return entries.length>100||entries.some(([,item])=>truncated(item,depth+1));
  }
  return false;
};

/** Project only the four recorded runner event kinds; the caller supplies its established safe-body sanitizer. */
export function runtimeEventReadings(events:SessionEvent[],safeBody:(value:unknown)=>unknown):{events:RuntimeEventReading[];calls:RuntimeCallReading[]} {
  const readings:RuntimeEventReading[]=[];
  for(const event of events){
    const body=record(event.body),type=body?.type;
    if(!['siwc.started','siwc.tool_call','siwc.tool_result','siwc.tool_failed'].includes(String(type)))continue;
    const raw=record(body?.data),sanitized=record(safeBody(body?.data));
    const overBudget=sanitized!==null&&Buffer.byteLength(JSON.stringify(sanitized),'utf8')>65_536;
    const data=overBudget?{turn:sanitized?.turn,name:sanitized?.name,callId:sanitized?.callId,
      model:sanitized?.model,instructions:sanitized?.instructions,toolProfileHash:sanitized?.toolProfileHash}:sanitized;
    const rawDefinitions=raw?.toolDefinitions;
    const safeDefinitions=data?.toolDefinitions;
    const definitions=Array.isArray(rawDefinitions)&&Array.isArray(safeDefinitions)&&rawDefinitions.length===safeDefinitions.length&&
      safeDefinitions.every(item=>typeof record(item)?.name==='string'&&typeof record(item)?.description==='string')
      ?safeDefinitions.map(item=>({name:text(record(item)?.name)!,description:text(record(item)?.description)!,
        parameters:record(item)?.parameters??null,outputSchema:null as null,outputSchemaCoverage:'not-recorded' as const})):null;
    readings.push({id:event.id,seq:event.seq,attemptId:event.attemptId,createdAt:event.createdAt,type:type as RuntimeEventType,
      turn:number(data?.turn),callId:text(data?.callId),name:text(data?.name),
      providerInstructions:type==='siwc.started'?text(data?.instructions):null,
      providerModel:type==='siwc.started'?text(data?.model):null,
      providerToolProfileHash:type==='siwc.started'?text(data?.toolProfileHash):null,
      argumentsHash:type==='siwc.tool_call'?text(data?.argumentsHash):null,
      outputHash:type==='siwc.tool_result'?text(data?.outputHash):null,
      toolDefinitions:type==='siwc.started'?definitions:null,
      ...(type==='siwc.tool_call'?{arguments:data?.arguments??null}:{}),
      ...(type==='siwc.tool_result'?{output:data?.output??null}:{}),
      outcomeUnknown:type==='siwc.tool_failed'&&data?.outcomeUnknown===true?true:null,
      bodyCoverage:overBudget||truncated(body?.data)?'truncated':'full'});
  }
  const byId=new Map<string,RuntimeCallReading>();
  for(const event of readings){
    if(!event.callId||event.type==='siwc.started')continue;
    const prior:RuntimeCallReading=byId.get(event.callId)??{callId:event.callId,name:event.name,turn:event.turn,callEventId:null,callSeq:null,
      outcomeEventId:null,outcomeSeq:null,status:'call-on-earlier-page'};
    if(event.type==='siwc.tool_call'){
      prior.callEventId=event.id;prior.callSeq=event.seq;prior.name=event.name;prior.turn=event.turn;
      prior.status='pending-or-later-page';
    }else{
      prior.outcomeEventId=event.id;prior.outcomeSeq=event.seq;
      prior.status=event.type==='siwc.tool_result'?'returned':'failed-outcome-unknown';
    }
    byId.set(event.callId,prior);
  }
  return {events:readings,calls:[...byId.values()]};
}
