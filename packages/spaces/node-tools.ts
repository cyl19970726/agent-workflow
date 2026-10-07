import type { NodeClient, DeliveredInput } from './types.js';

/** Executor-neutral descriptors capturing one capability, never a service or database. */
export interface BoundNodeReadOptions { boundSlots: readonly string[] }
export interface BoundNodeReadDenial {
  ok:false;
  error:{code:'UNBOUND_INPUT_SLOT';message:string};
}
interface NodeReadTool<T> {name:string;description:string;parameters:Record<string,unknown>;execute(value:unknown):Promise<T>}
export function nodeReadTools(client: NodeClient): [NodeReadTool<DeliveredInput>];
export function nodeReadTools(client: NodeClient, options: BoundNodeReadOptions): [NodeReadTool<DeliveredInput|BoundNodeReadDenial>];
export function nodeReadTools(client: NodeClient, options?: BoundNodeReadOptions): [NodeReadTool<DeliveredInput|BoundNodeReadDenial>] {
  // Preserve the historical descriptor and thrown-error behavior for existing callers.
  if(options===undefined) return [{
    name:'read_bound_asset',
    description:'Read the exact asset version and role view bound to an input slot for this attempt.',
    parameters:{type:'object',properties:{slot:{type:'string'}},required:['slot'],additionalProperties:false},
    async execute(value: unknown): Promise<DeliveredInput> {
      if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>key!=='slot') || typeof (value as {slot?:unknown}).slot!=='string') throw new Error('Expected one bound input slot; other capabilities are not accepted');
      return client.read((value as {slot:string}).slot);
    },
  }];
  const slots=[...new Set(options.boundSlots)].sort();
  if(slots.some(slot=>typeof slot!=='string'||!slot.trim())) throw new Error('Bound input slot names must be nonempty strings');
  const allowed=new Set(slots);
  const denial=():BoundNodeReadDenial=>({ok:false,error:{code:'UNBOUND_INPUT_SLOT',
    message:'This input slot is not bound to the current attempt. Choose a slot from the tool schema.'}});
  return [{
    name:'read_bound_asset',
    description:`Read a bound input for this exact attempt. Available slots: ${slots.length?slots.join(', '):'(none)'}.`,
    parameters:{type:'object',properties:{slot:{type:'string',enum:slots,description:'Exact input slot bound to this attempt.'}},required:['slot'],additionalProperties:false},
    async execute(value: unknown): Promise<DeliveredInput|BoundNodeReadDenial> {
      if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || !Object.hasOwn(value,'slot') ||
        typeof (value as {slot?:unknown}).slot!=='string' || !allowed.has((value as {slot:string}).slot)) return denial();
      return client.read((value as {slot:string}).slot);
    },
  }];
}
