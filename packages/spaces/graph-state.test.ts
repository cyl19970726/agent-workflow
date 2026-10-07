import { describe,expect,it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildWorkflowGraphState,workflowGraphStateBridgeScript } from './graph-state.js';
import type { ProcessView,ProcessOccurrence } from './process-projection.js';

const occurrence=(id:string,round:number,state:string,branch?:string)=>({id,nodeId:'author',round,state,branch,provenance:'observed'}) as ProcessOccurrence;
function view(occurrences:ProcessOccurrence[]=[],routes:ProcessView['routes']=[]):ProcessView {
  return {run:{spaceId:'s',runId:'r',workflowVersionId:'v'},contract:{nodes:[{id:'author'},{id:'review'}],edges:[{id:'write',from:'author',to:'review'},{id:'back',from:'review',to:'author'}]},occurrences,routes} as ProcessView;
}

describe('workflow display snapshots',()=>{
  it('shows the latest round without letting an old failure mask later success',()=>{
    const state=buildWorkflowGraphState(view([occurrence('failed-old',1,'failed'),occurrence('ok-new',2,'succeeded')]))!;
    expect(state.nodes[0]).toMatchObject({state:'succeeded',round:2,label:'第2轮 · 成功'});
    expect(state.nodes[0]!.occurrences.map(item=>item.id)).toEqual(['ok-new']);
    expect(state.nodes[1]).toMatchObject({state:'none',round:null});
    expect(buildWorkflowGraphState(view([occurrence('failed-old',1,'failed'),occurrence('ok-new',2,'succeeded')]))!.digest).toBe(state.digest);
  });
  it('preserves current parallel branch evidence and differentiates selection from traversal',()=>{
    const state=buildWorkflowGraphState(view([occurrence('b',2,'succeeded','right'),occurrence('a',2,'failed','left')],[
      {edgeId:'back',round:1,provenance:'observed'},
      {edgeId:'write',round:2,selectionOnly:true,provenance:'observed'},
    ]))!;
    expect(state.nodes[0]).toMatchObject({state:'mixed',label:'第2轮 · 2分支 · 状态不同'});
    expect(state.nodes[0]!.occurrences.map(item=>item.branch)).toEqual(['left','right']);
    expect(state.edges).toEqual([{id:'write',state:'selected',round:2,provenance:'observed'},{id:'back',state:'none',round:null,provenance:null}]);
    const traversed=buildWorkflowGraphState(view([], [{edgeId:'write',round:2,provenance:'derived'}]))!;
    expect(traversed.edges[0]).toMatchObject({state:'traversed',provenance:'derived'});
  });
  it('keeps missing-round history explicit instead of guessing the latest outcome',()=>{
    const state=buildWorkflowGraphState(view([{...occurrence('a',1,'failed'),round:undefined},{...occurrence('b',1,'succeeded'),round:undefined}]))!;
    expect(state.nodes[0]).toMatchObject({state:'mixed',round:null,label:'轮次未记录 · 状态不同'});
  });
  it('patches state in place, rejects another source/identity/stale/unknown ID, and keeps labels inert',()=>{
    const initial=buildWorkflowGraphState(view([occurrence('a',1,'queued')]))!;
    const listeners=new Map<string,(event:any)=>void>();
    const element=(id:string)=>({attrs:new Map<string,string>([['data-node-id',id],['data-edge-id',id]]),tag:{textContent:'',setAttribute(){}},getAttribute(key:string){return this.attrs.get(key);},setAttribute(key:string,value:string){this.attrs.set(key,value);},querySelector(){return this.tag;}});
    const nodes=[element('author'),element('review')],edges=[element('write'),element('back')];
    const svg={attrs:new Map([['viewBox','0 0 1000 600'],['data-focus-active','author']]),querySelectorAll(selector:string){return selector==='[data-node-id]'?nodes:edges;},setAttribute(key:string,value:string){this.attrs.set(key,value);}};
    const ready:any[]=[];const parent={postMessage(message:any){ready.push(message);}};
    const window={parent,addEventListener(type:string,handler:(event:any)=>void){listeners.set(type,handler);}};
    runInNewContext(workflowGraphStateBridgeScript(initial),{window,document:{querySelector:()=>svg}});
    expect(ready[0]).toMatchObject({type:'space-graph-ready',spaceId:'s',runId:'r',versionId:'v'});
    const next=buildWorkflowGraphState(view([occurrence('a',1,'succeeded')]))!;
    next.nodes[0]!.label='<script>globalThis.pwned=true</script>';
    const send=(state:any,serial:number,source:any=parent)=>listeners.get('message')!({source,data:{type:'space-graph-state',state,serial}});
    send(next,1,{});expect(nodes[0]!.attrs.get('data-workflow-status')).toBe('queued');
    send({...next,runId:'other'},1);expect(nodes[0]!.attrs.get('data-workflow-status')).toBe('queued');
    send({...next,nodes:[{...next.nodes[0],id:'unknown'},next.nodes[1]]},1);expect(nodes[0]!.attrs.get('data-workflow-status')).toBe('queued');
    send(next,1);expect(nodes[0]!.attrs.get('data-workflow-status')).toBe('succeeded');expect(nodes[0]!.tag.textContent).toBe(next.nodes[0]!.label);
    send(initial,1);expect(nodes[0]!.attrs.get('data-workflow-status')).toBe('succeeded');
    expect(svg.attrs.get('viewBox')).toBe('0 0 1000 600');expect(svg.attrs.get('data-focus-active')).toBe('author');
    send(buildWorkflowGraphState(view([occurrence('a',1,'failed')]))!,2);expect(nodes[0]!.attrs.get('data-workflow-status')).toBe('failed');
  });
});
