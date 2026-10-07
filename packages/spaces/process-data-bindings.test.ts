import { describe, it, expect } from 'vitest';
import { SchemaRegistry, publishStorageContract, JSON_SCHEMA_DIALECT, type SchemaRef } from '@signal-room/workflow-space-contracts';
import { publishProcessContract, type ProcessContractDraft, type ProcessDataBinding } from './process-contract.js';

const registry=new SchemaRegistry();
const makeRef=(namespace:string):SchemaRef=>{
  const value=registry.registerSchema({namespace,revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:{type:'string'}});
  return {namespace:value.namespace,revision:value.revision,hash:value.hash};
};
const draft=makeRef('test/draft'),material=makeRef('test/material');
const storage=publishStorageContract(registry,{workflowVersion:'v1',nodes:{
  writer:{actorKinds:['agent'],inputs:{previous:{schema:draft,states:['candidate'],optional:true},materials:{schema:material,states:['imported']}},
    outputs:{draft:{schema:draft,requiredInputs:['materials'],initialState:'candidate',appendVersions:true}},actions:['appendOutputVersion']},
  reviewer:{actorKinds:['agent'],inputs:{draft:{schema:draft,states:['candidate']}},outputs:{},actions:['readBoundInput']},
},stateRules:[]});
const binding:ProcessDataBinding={id:'review-target',from:{node:'writer',port:'draft'},to:{node:'reviewer',port:'draft'},selection:'current-business-round'};
const definition=():ProcessContractDraft=>({revision:'1',nodes:[
  {id:'writer',kind:'agent',storageNodeId:'writer',inputs:{previous:{slot:'previous'},materials:{slot:'materials'}},outputs:{draft:{slot:'draft'}}},
  {id:'reviewer',kind:'agent',storageNodeId:'reviewer',inputs:{draft:{slot:'draft'}}},
],edges:[{id:'review',from:'writer',to:'reviewer',kind:'sequence'}],results:[],runInputs:{materials:material,priorDraft:draft},dataBindings:[binding]});

describe('Declared method data bindings',()=>{
  it('freezes exact ports and first-round versus later-round sources into the process hash',async()=>{
    const first:ProcessDataBinding={id:'prior-import',from:{runInput:'priorDraft'},to:{node:'writer',port:'previous'},selection:'frozen-input',when:'initial-round'};
    const later:ProcessDataBinding={id:'prior-produced',from:{node:'writer',port:'draft'},to:{node:'writer',port:'previous'},selection:'previous-business-round',when:'later-rounds'};
    const contract=await publishProcessContract({...definition(),dataBindings:[binding,first,later]},storage);
    expect(contract.dataBindings).toEqual([binding,first,later]);
    expect(contract.hash).not.toBe((await publishProcessContract(definition(),storage)).hash);
    const legacy=definition();delete legacy.runInputs;delete legacy.dataBindings;
    expect((await publishProcessContract(legacy,storage)).dataBindings).toBeUndefined();
  });
  it('rejects wrong endpoints, equal-name incompatible schemas and undeclared frozen inputs',async()=>{
    for(const bad of [
      {...binding,from:{node:'writer',port:'missing'}},
      {...binding,to:{node:'reviewer',port:'missing'}},
      {...binding,from:{runInput:'materials'},selection:'frozen-input'},
      {...binding,from:{runInput:'unknown'},selection:'frozen-input'},
    ])await expect(publishProcessContract({...definition(),dataBindings:[bad as ProcessDataBinding]},storage)).rejects.toThrow(/endpoint|schema mismatch/);
  });
  it('rejects ambiguous overlapping selectors while keeping data flow separate from control cycles',async()=>{
    await expect(publishProcessContract({...definition(),dataBindings:[binding,{...binding,id:'another'}]},storage)).rejects.toThrow('overlapping');
    await expect(publishProcessContract({...definition(),dataBindings:[{...binding,selection:'frozen-input'}]},storage)).rejects.toThrow('node output');
    await expect(publishProcessContract({...definition(),dataBindings:[{...binding,from:{runInput:'priorDraft'}}]},storage)).rejects.toThrow('frozen-input');
    await expect(publishProcessContract({...definition(),dataBindings:[{...binding,to:{node:'writer',port:'previous'}}]},storage)).rejects.toThrow('self dependency');
    const previous={...binding,to:{node:'writer',port:'previous'},selection:'previous-business-round'} as ProcessDataBinding;
    expect((await publishProcessContract({...definition(),dataBindings:[previous]},storage)).edges).toEqual(definition().edges);
  });
});
