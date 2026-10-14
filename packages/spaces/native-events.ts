import type {WorkflowEvent} from '@signal-room/workflow';

export interface NativeEventReading {
  id:string;seq:number;type:string;timestamp:string;stepRunId:string|null;attemptId:string|null;
  turn:number|null;requestAttempt:number|null;httpStatus:number|null;
  transport:{phase:string|null;errorName:string|null;causeCode:string|null;bytesRead:number|null;retrying:boolean|null}|null;
  response:{outputItems:number|null;output:Array<{type:string;name:string|null}>;hasText:boolean;hasFinalText:boolean;textHash:string|null}|null;
  tool:{name:string|null;callId:string|null;status:string|null}|null;
}
export interface NativeChildRunReading {runId:string;workflowId:string;state:string;parentStepRunId:string|null;binding:'bound'|'pending'}
export interface NativeRunEventsPage {
  runId:string;executionMode:'imported'|'external-host';items:NativeEventReading[];
  nextCursor:number|null;hasMore:boolean;snapshotAt:string;sanitized:true;children:NativeChildRunReading[];
}
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const label=(value:unknown):string|null=>typeof value==='string'&&value.length>0&&value.length<=120&&/^[\w.:-]+$/u.test(value)?value:null;
const integer=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const outputTypes=new Set(['message','function_call','reasoning','web_search_call','file_search_call','computer_call','custom_tool_call']);
const transportNames=new Set(['TypeError','Error','AbortError']);
const transportCodes=new Set(['UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ECONNRESET','ECONNREFUSED','EPIPE',
  'ETIMEDOUT','EAI_AGAIN','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','SIWC_HEADER_TIMEOUT','SIWC_STREAM_IDLE_TIMEOUT',
  'SIWC_STREAM_PREMATURE_EOF','ENOTFOUND','EHOSTUNREACH','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT']);

/** Whitelist only operational facts. Raw response text, tool arguments and request headers never leave this boundary. */
export function projectNativeEvent(event:WorkflowEvent):NativeEventReading{
  const data=object(event.data),visible=Array.isArray(data?.visibleOutput)?data.visibleOutput:[];
  const output=visible.slice(0,32).map(item=>object(item)).filter((item):item is Record<string,unknown>=>!!item)
    .map(item=>({type:typeof item.type==='string'&&outputTypes.has(item.type)?item.type:'other',name:label(item.name)}));
  const messages=visible.map(item=>object(item)).filter((item):item is Record<string,unknown>=>!!item&&item.type==='message');
  const hasText=messages.some(item=>Array.isArray(item.content)&&item.content.some(part=>{
    const value=object(part);return value?.type==='output_text'&&typeof value.text==='string'&&value.text.trim().length>0;
  }));
  const hasFunctionCall=visible.some(item=>object(item)?.type==='function_call');
  const response=event.type==='siwc.response'?{
    outputItems:integer(data?.outputItems),output,hasText,hasFinalText:hasText&&!hasFunctionCall,
    textHash:typeof data?.textHash==='string'&&/^[a-f0-9]{64}$/u.test(data.textHash)?data.textHash:null,
  }:null;
  const transport=event.type==='siwc.transport_error'?{
    phase:data?.phase==='fetch'||data?.phase==='stream'?data.phase:null,
    errorName:typeof data?.errorName==='string'&&transportNames.has(data.errorName)?data.errorName:null,
    causeCode:typeof data?.causeCode==='string'&&transportCodes.has(data.causeCode)?data.causeCode:null,
    bytesRead:integer(data?.bytesRead),retrying:typeof data?.retrying==='boolean'?data.retrying:null,
  }:null;
  const tool=event.type.startsWith('siwc.tool_')?{
    name:label(data?.name),callId:label(data?.callId),status:label(data?.status),
  }:null;
  return {id:event.id,seq:event.seq,type:event.type,timestamp:event.timestamp,stepRunId:event.stepRunId??null,
    attemptId:event.attemptId??null,turn:integer(data?.turn),requestAttempt:integer(data?.requestAttempt),
    httpStatus:['siwc.response_headers','siwc.transport_error'].includes(event.type)?integer(data?.status):null,
    transport,response,tool};
}
