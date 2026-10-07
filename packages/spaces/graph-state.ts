import { createHash } from 'node:crypto';
import type { ProcessView } from './process-projection.js';

/** A bounded display snapshot, never an instruction to execute the workflow. */
export interface WorkflowGraphState {
  schemaVersion: 1;
  spaceId: string; runId: string; versionId: string; digest: string;
  nodes: Array<{id:string;state:string;label:string;round:number|null;
    occurrences:Array<{id:string;branch:string|null;state:string;provenance:'observed'|'derived'|'unknown'}>}>;
  edges: Array<{id:string;state:'none'|'selected'|'traversed';round:number|null;provenance:'observed'|'derived'|null}>;
  truncated: boolean;
}

const labels: Record<string,string> = {succeeded:'成功',failed:'失败',running:'运行中',waiting:'等待',queued:'排队',blocked:'阻塞',needs_review:'待审核',canceled:'已取消',mixed:'状态不同',unknown:'状态未知',none:'无执行证据'};
const knownRound = (value:number|undefined):value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;

/** Each node shows its latest evidenced round. Earlier failures remain in the inspector. */
export function buildWorkflowGraphState(view: Pick<ProcessView,'run'|'occurrences'|'routes'> & {
  contract?: Pick<NonNullable<ProcessView['contract']>,'nodes'|'edges'>;
}): WorkflowGraphState | null {
  if (!view.contract) return null;
  let truncated = view.contract.nodes.length > 512 || view.contract.edges.length > 2048;
  const nodes = view.contract.nodes.slice(0,512).map(node => {
    const all = view.occurrences.filter(item => item.nodeId === node.id);
    const rounds = all.map(item => item.round).filter(knownRound);
    const round = rounds.length ? Math.max(...rounds) : null;
    const current = (round === null ? all : all.filter(item => item.round === round)).sort((a,b)=>a.id.localeCompare(b.id));
    const states = new Set(current.map(item=>item.state));
    const state = !current.length ? 'none' : states.size === 1 ? current[0]!.state : 'mixed';
    const branchCount = new Set(current.map(item=>item.branch ?? null)).size;
    const label = !current.length ? labels.none! : `${round === null ? '轮次未记录' : `第${round}轮`} · ${branchCount>1?`${branchCount}分支 · `:''}${labels[state] ?? labels.unknown}`;
    if (current.length > 64) truncated = true;
    return {id:node.id,state,label,round,occurrences:current.slice(0,64).map(item=>({id:item.id,branch:item.branch??null,state:item.state,provenance:item.provenance}))};
  });
  const routeRounds = view.routes.map(route=>route.round).filter(knownRound);
  const latestRouteRound = routeRounds.length ? Math.max(...routeRounds) : null;
  const currentRoutes = view.routes.filter(route=>latestRouteRound === null || route.round === latestRouteRound);
  const edges = view.contract.edges.slice(0,2048).map(edge => {
    const evidence = currentRoutes.filter(route=>route.edgeId === edge.id);
    // A decision selecting an edge does not prove that the edge was traversed.
    const traversal = evidence.find(route=>!route.selectionOnly && route.provenance==='observed') ?? evidence.find(route=>!route.selectionOnly);
    const selection = evidence.find(route=>route.selectionOnly);
    const route = traversal ?? selection;
    return {id:edge.id,state:traversal?'traversed' as const:selection?'selected' as const:'none' as const,
      round:route?.round??null,provenance:route?.provenance??null};
  });
  const snapshot = {schemaVersion:1 as const,spaceId:view.run.spaceId,runId:view.run.runId,versionId:view.run.workflowVersionId,nodes,edges,truncated};
  return {...snapshot,digest:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
}

const scriptJson = (value:unknown) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,character=>`\\u${character.charCodeAt(0).toString(16).padStart(4,'0')}`);

/** Sandboxed iframe: validate the parent, exact identity and IDs before patching SVG text/attributes. */
export function workflowGraphStateBridgeScript(initial:WorkflowGraphState):string {
  return `(function(){
    var initial=${scriptJson(initial)}, serial=0;
    var ids=new Set(initial.nodes.map(function(n){return n.id;}));
    var edgeIds=new Set(initial.edges.map(function(e){return e.id;}));
    var states=new Set(['none','unknown','mixed','succeeded','failed','running','waiting','queued','blocked','needs_review','canceled']);
    var svg=document.querySelector('.diagram-container svg');
    var nodes=new Map(),edges=new Map();
    if(!svg)return;
    svg.querySelectorAll('[data-node-id]').forEach(function(n){var id=n.getAttribute('data-node-id');if(ids.has(id))nodes.set(id,n);});
    svg.querySelectorAll('[data-edge-id]').forEach(function(e){var id=e.getAttribute('data-edge-id');if(edgeIds.has(id))edges.set(id,e);});
    function valid(s){
      if(!s||s.schemaVersion!==1||s.spaceId!==initial.spaceId||s.runId!==initial.runId||s.versionId!==initial.versionId||typeof s.digest!=='string'||! /^[a-f0-9]{64}$/.test(s.digest))return false;
      if(!Array.isArray(s.nodes)||s.nodes.length>512||!Array.isArray(s.edges)||s.edges.length>2048||typeof s.truncated!=='boolean')return false;
      var ns=new Set(),es=new Set();
      function round(r){return r===null||(Number.isSafeInteger(r)&&r>=0);}
      for(var n of s.nodes){if(!n||!ids.has(n.id)||ns.has(n.id)||!states.has(n.state)||typeof n.label!=='string'||n.label.length>200||!round(n.round)||!Array.isArray(n.occurrences)||n.occurrences.length>64)return false;
        for(var o of n.occurrences){if(!o||typeof o.id!=='string'||o.id.length>240||!states.has(o.state)||!(o.branch===null||(typeof o.branch==='string'&&o.branch.length<=240))||!['observed','derived','unknown'].includes(o.provenance))return false;}ns.add(n.id);}
      for(var e of s.edges){if(!e||!edgeIds.has(e.id)||es.has(e.id)||!round(e.round)||!['none','selected','traversed'].includes(e.state)||![null,'observed','derived'].includes(e.provenance))return false;es.add(e.id);}
      return ns.size===ids.size&&es.size===edgeIds.size;
    }
    function apply(s){
      if(!valid(s))return false;
      s.nodes.forEach(function(n){var g=nodes.get(n.id);if(!g)return;g.setAttribute('data-workflow-status',n.state);var tag=g.querySelector('text[data-detail="fine"]');if(tag){tag.textContent=n.label;tag.setAttribute('font-size','10');if(typeof tag.getComputedTextLength==='function'){var width=tag.getComputedTextLength();if(width>140)tag.setAttribute('font-size',String(Math.max(6,10*140/width)));}}g.setAttribute('data-workflow-round',n.round===null?'unknown':String(n.round));});
      s.edges.forEach(function(e){var g=edges.get(e.id);if(!g)return;g.setAttribute('data-workflow-route',e.state);g.setAttribute('data-workflow-route-evidence',e.provenance||'none');g.setAttribute('aria-label',e.state==='selected'?'已选择，尚无遍历证据':e.state==='traversed'?(e.provenance==='derived'?'回溯遍历证据':'实际遍历证据'):'无遍历证据');});
      svg.setAttribute('data-workflow-state-digest',s.digest);
      return true;
    }
    window.addEventListener('message',function(event){
      if(event.source!==window.parent)return;
      var m=event.data;
      if(!m||m.type!=='space-graph-state'||!Number.isSafeInteger(m.serial)||m.serial<=serial)return;
      if(apply(m.state))serial=m.serial;
    });
    function ready(){window.parent.postMessage({type:'space-graph-ready',spaceId:initial.spaceId,runId:initial.runId,versionId:initial.versionId},'*');}
    apply(initial);ready();window.addEventListener('load',ready);
  })();`;
}
