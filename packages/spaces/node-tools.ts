import type { NodeClient, DeliveredInput } from './types.js';

/** Executor-neutral descriptors capturing one capability, never a service or database. */
export interface BoundNodeReadOptions { boundSlots: readonly string[] }
export interface BoundNodeReadDenial {
  ok:false;
  error:{code:'UNBOUND_INPUT_SLOT';message:string};
}
interface NodeReadTool<T> {name:string;description:string;parameters:Record<string,unknown>;execute(value:unknown):Promise<T>}
export interface BoundNodeReadContract {
  outputSchema:Record<string,unknown>;
  response: {
    success: { kind:'DeliveredInput'; fields:readonly string[]; source:'NodeClient.read' };
    denial: BoundNodeReadDenial;
    executionError: { kind:'throws'; source:'NodeClient.read'; normalized:false };
  };
  permissions: {
    operation:'read'; scope:'persisted-attempt-bound-input';
    allowedSlots:readonly string[]; deliveredView:'binding-defined';
    readFullMethodExposed:false; write:false; webResearch:false;
  };
}
interface BoundNodeReadTool extends NodeReadTool<DeliveredInput|BoundNodeReadDenial>, BoundNodeReadContract {}
export function nodeReadTools(client: NodeClient): [NodeReadTool<DeliveredInput>];
export function nodeReadTools(client: NodeClient, options: BoundNodeReadOptions): [BoundNodeReadTool];
export function nodeReadTools(client: NodeClient, options?: BoundNodeReadOptions): [NodeReadTool<DeliveredInput>|BoundNodeReadTool] {
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
  const string={type:'string'};
  const successSchema={type:'object',properties:{assetVersionId:string,stateAtBinding:string,payloadHash:string,
    schema:{type:'object',properties:{namespace:string,revision:string,hash:string},
      required:['namespace','revision','hash'],additionalProperties:false},viewVersion:string,
    deliveredHash:string,payload:{}},required:['assetVersionId','stateAtBinding','payloadHash','schema',
      'viewVersion','deliveredHash','payload'],additionalProperties:false};
  const denialSchema={type:'object',properties:{ok:{const:false},error:{type:'object',
    properties:{code:{const:'UNBOUND_INPUT_SLOT'},message:{const:denial().error.message}},
    required:['code','message'],additionalProperties:false}},required:['ok','error'],additionalProperties:false};
  return [{
    name:'read_bound_asset',
    description:`Read a bound input for this exact attempt. Available slots: ${slots.length?slots.join(', '):'(none)'}.`,
    parameters:{type:'object',properties:{slot:{type:'string',enum:slots,description:'Exact input slot bound to this attempt.'}},required:['slot'],additionalProperties:false},
    outputSchema:{oneOf:[successSchema,denialSchema]},
    response:{success:{kind:'DeliveredInput',fields:['assetVersionId','stateAtBinding','payloadHash','schema',
      'viewVersion','deliveredHash','payload'],source:'NodeClient.read'},denial:denial(),
      executionError:{kind:'throws',source:'NodeClient.read',normalized:false}},
    permissions:{operation:'read',scope:'persisted-attempt-bound-input',allowedSlots:slots,
      deliveredView:'binding-defined',readFullMethodExposed:false,write:false,webResearch:false},
    async execute(value: unknown): Promise<DeliveredInput|BoundNodeReadDenial> {
      if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || !Object.hasOwn(value,'slot') ||
        typeof (value as {slot?:unknown}).slot!=='string' || !allowed.has((value as {slot:string}).slot)) return denial();
      return client.read((value as {slot:string}).slot);
    },
  }];
}
