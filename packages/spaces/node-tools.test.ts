import {describe,expect,it,vi} from 'vitest';
import type {NodeClient} from './types.js';
import {nodeReadTools} from './node-tools.js';

const delivered={assetVersionId:'asset-1',stateAtBinding:'imported',payloadHash:'hash',
 schema:{namespace:'test',revision:'1',hash:'hash'},viewVersion:'full',deliveredHash:'hash',payload:{secret:'payload'}};
const client=(read:ReturnType<typeof vi.fn>)=>({read} as unknown as NodeClient);

describe('attempt-bound node reads',()=>{
 it('keeps the historical default descriptor and malformed-call behavior',async()=>{
  const read=vi.fn(async()=>delivered);
  const [tool]=nodeReadTools(client(read));
  expect({name:tool.name,description:tool.description,parameters:tool.parameters}).toEqual({
   name:'read_bound_asset',description:'Read the exact asset version and role view bound to an input slot for this attempt.',
   parameters:{type:'object',properties:{slot:{type:'string'}},required:['slot'],additionalProperties:false}});
  await expect(tool.execute({slot:'manuscript'})).resolves.toEqual(delivered);
  await expect(tool.execute({slot:'manuscript',other:true})).rejects.toThrow('Expected one bound input slot');
  expect(read).toHaveBeenCalledTimes(1);
 });

 it('lists only supplied attempt slots, denies invalid requests without reading, and propagates read failures',async()=>{
  const read=vi.fn(async()=>delivered);
  const [tool]=nodeReadTools(client(read),{boundSlots:['manuscript','audienceProfile','manuscript']});
  expect(tool.parameters).toEqual({type:'object',properties:{slot:{type:'string',enum:['audienceProfile','manuscript'],
   description:'Exact input slot bound to this attempt.'}},required:['slot'],additionalProperties:false});
  expect(tool.description).toContain('audienceProfile, manuscript');
  for(const value of [{slot:'draft'},{slot:'title'},{slot:'manuscript',extra:true},{slot:4},{}]){
   expect(await tool.execute(value)).toEqual({ok:false,error:{code:'UNBOUND_INPUT_SLOT',
    message:'This input slot is not bound to the current attempt. Choose a slot from the tool schema.'}});
  }
  expect(read).not.toHaveBeenCalled();
  await expect(tool.execute({slot:'manuscript'})).resolves.toEqual(delivered);
  expect(read).toHaveBeenCalledExactlyOnceWith('manuscript');
  read.mockRejectedValueOnce(new Error('Delivered context integrity check failed'));
  await expect(tool.execute({slot:'audienceProfile'})).rejects.toThrow('Delivered context integrity check failed');
 });
});
