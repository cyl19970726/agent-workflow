import {describe,expect,it} from 'vitest';
import {projectNativeEvent} from './native-events.js';

describe('native event safe projection',()=>{
  const base={id:'event-1',runId:'run-1',seq:1,timestamp:'2026-10-14T00:00:00Z',stepRunId:'step-1',attemptId:'attempt-1'};
  it('keeps tool-call identity without treating HTTP 200 or function_call as final text',()=>{
    const result=projectNativeEvent({...base,type:'siwc.response',data:{turn:4,outputItems:1,requestId:'private-request',
      visibleOutput:[{type:'function_call',name:'review_tool',arguments:'private-arguments',callId:'private-call'}]}});
    expect(result.response).toEqual({outputItems:1,output:[{type:'function_call',name:'review_tool'}],hasText:false,hasFinalText:false,textHash:null});
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('shows a later transport error but excludes request IDs and error bodies',()=>{
    const result=projectNativeEvent({...base,type:'siwc.transport_error',data:{turn:5,requestAttempt:2,status:503,
      phase:'fetch',errorName:'TypeError',causeCode:'ECONNRESET',bytesRead:0,retrying:false,
      requestId:'private-request',headers:{authorization:'Bearer secret'},message:'private-body'}});
    expect(result).toMatchObject({turn:5,requestAttempt:2,httpStatus:503,
      transport:{phase:'fetch',errorName:'TypeError',causeCode:'ECONNRESET',bytesRead:0,retrying:false}});
    expect(JSON.stringify(result)).not.toMatch(/private-|Bearer secret/u);
  });
  it('marks nonempty message text as final only without a function call',()=>{
    const data={turn:3,visibleOutput:[{type:'message',content:[{type:'output_text',text:'Private final review'}]}]};
    expect(projectNativeEvent({...base,type:'siwc.response',data}).response?.hasFinalText).toBe(true);
    expect(projectNativeEvent({...base,type:'siwc.response',data:{...data,visibleOutput:[...data.visibleOutput,{type:'function_call',name:'next'}]}}).response?.hasFinalText).toBe(false);
  });
});
