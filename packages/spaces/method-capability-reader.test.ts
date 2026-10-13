import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {methodCapabilityAssetReader} from './method-capability-reader.js';
import {METHOD_CAPABILITY_SCHEMA_REF,methodCapabilityAssetId} from './method-capability.js';
import type {AssetVersion} from './types.js';

const bytes=(content:string)=>({content,sha256:createHash('sha256').update(content,'utf8').digest('hex')});
const asset=():AssetVersion=>({id:'capability-v1',spaceId:'space',assetId:methodCapabilityAssetId('workflow'),version:1,
  schema:METHOD_CAPABILITY_SCHEMA_REF,payload:{workflowId:'workflow',entrypoint:'content',
    understanding:{revisionId:'understanding-v1',payloadHash:'understanding-hash'},
    provider:{id:'provider',contractRevision:'1'},nodes:{researcher:{instructions:bytes('Full raw prompt <untrusted>'),
      outputSchema:bytes('{"type":"object"}'),model:'model',reasoningEffort:'high'}},
    validation:bytes('{"budget":{"maxCalls":15}}'),predecessorVersionId:null,
    changeReason:'Initial',authorship:{kind:'agent',name:'test-agent'},previousRevisionId:null},
  payloadHash:'payload-hash',source:{kind:'import',actorId:'designer',description:'fixture'},dependencies:[],
  attachments:[],initialState:'imported',createdAt:'2026-10-11T00:00:00Z'});

describe('frozen method capability reader',()=>{
  it('renders exact instructions, schemas, validation, model and basis as text',()=>{
    const reading=methodCapabilityAssetReader(asset());
    expect(reading.sections.map(section=>section.text).join('\n')).toContain('Full raw prompt <untrusted>');
    expect(reading.sections.map(section=>section.text).join('\n')).toContain('业务理解版本：understanding-v1');
    expect(reading.sections.map(section=>section.text).join('\n')).toContain('思考强度：high');
    expect(reading.sections.map(section=>section.text).join('\n')).toContain('{"budget":{"maxCalls":15}}');
    expect(reading.sections.find(section=>section.title==='researcher · 完整指令')?.text).toContain('Full raw prompt <untrusted>');
    expect(reading.sections.find(section=>section.title==='researcher · 完整指令')?.text).toContain(bytes('Full raw prompt <untrusted>').sha256);
  });
  it('rejects another frozen type, legacy shape, and changed bytes',()=>{
    const wrong=asset();wrong.schema={...wrong.schema,namespace:'workflow/method-design'};
    expect(()=>methodCapabilityAssetReader(wrong)).toThrow('not a method capability');
    const old=asset();delete (old.payload as Record<string,unknown>).nodes;
    expect(()=>methodCapabilityAssetReader(old)).toThrow('shape is invalid');
    const changed=asset();((changed.payload as Record<string,unknown>).nodes as Record<string,unknown>).researcher={
      instructions:{...bytes('Original'),content:'Changed'},outputSchema:bytes('{"type":"object"}'),
      model:'model',reasoningEffort:'high'};
    expect(()=>methodCapabilityAssetReader(changed)).toThrow('content/hash mismatch');
    const invalid=asset();((invalid.payload as Record<string,unknown>).nodes as Record<string,unknown>).researcher={
      instructions:bytes('Full raw prompt'),outputSchema:bytes('[]'),model:'model',reasoningEffort:'high'};
    expect(()=>methodCapabilityAssetReader(invalid)).toThrow('JSON schema object');
    const slashed=asset();const nodes=(slashed.payload as Record<string,unknown>).nodes as Record<string,unknown>;
    nodes['research/~check']=nodes.researcher;delete nodes.researcher;
    expect(methodCapabilityAssetReader(slashed).sections.find(section=>section.title==='research/~check · 完整指令')?.pointer)
      .toBe('/nodes/research~1~0check/instructions/content');
  });
});
