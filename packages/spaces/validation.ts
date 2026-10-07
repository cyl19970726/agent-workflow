import type {ValidationPlanDraft,ValidationEntry,ValidationEntryStatus} from './types.js';

export function validationEntries(draft:ValidationPlanDraft):ValidationEntry[] {
  const entries:ValidationEntry[]=[];
  for(const item of draft.cases) for(let repeat=1;repeat<=item.repeats;repeat++) for(const side of ['baseline','candidate'] as const) {
    const method=draft[side];
    const id=`${draft.id}:${side}:${item.caseId}:${repeat}`;
    const excludedReason=draft.excludedEntries?.find(exclusion=>exclusion.entryId===id)?.reason;
    entries.push({id,side,caseId:item.caseId,inputManifestId:item.inputManifestId,repeat,
      workflowVersionId:method.workflowVersionId,entrypoint:method.entrypoint,...(excludedReason?{excludedReason}:{})});
  }
  return entries;
}

export const validationStatuses:ValidationEntryStatus[]=['excluded','missing','pending','queued','running','cancel_requested','interrupted','completed','failed','canceled','needs_review','reviewed'];

export function sameJson(a:unknown,b:unknown):boolean {
  return JSON.stringify(sort(a))===JSON.stringify(sort(b));
}
function sort(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(sort);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sort(item)]));
  return value;
}
