import {createHash} from 'node:crypto';
import type {AssetReader} from './console.js';
import {methodCapabilityRevision} from './method-capability.js';

/** Read exact saved capability bytes. All returned strings are untrusted text, never markup. */
export const methodCapabilityAssetReader:AssetReader=asset=>{
  const revision=methodCapabilityRevision(asset);
  const checked=(part:{content:string;sha256:string},label:string,shape?:'object'|'json'):string=>{
    if(!part||typeof part.content!=='string'||!part.content.trim()||
      typeof part.sha256!=='string'||createHash('sha256').update(part.content,'utf8').digest('hex')!==part.sha256)
      throw new Error(`${label} content/hash mismatch`);
    if(shape){
      let parsed:unknown;
      try{parsed=JSON.parse(part.content);}catch{throw new Error(`${label} is not valid JSON`);}
      if(shape==='object'&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed)))
        throw new Error(`${label} is not a JSON schema object`);
    }
    return part.content;
  };
  if(!revision.workflowId?.trim()||!revision.entrypoint?.trim()||!revision.understanding?.revisionId?.trim()||
    !revision.understanding.payloadHash?.trim()||!revision.provider?.id?.trim()||
    !revision.provider.contractRevision?.trim()||!revision.nodes||
    typeof revision.nodes!=='object'||Array.isArray(revision.nodes)||!Object.keys(revision.nodes).length||
    !revision.changeReason?.trim()||!revision.authorship?.name?.trim()||
    !['agent','human'].includes(revision.authorship.kind))
    throw new Error('Method capability shape is invalid');
  const sections:ReturnType<AssetReader>['sections']=[
    {title:'方法范围与理解依据',text:[`工作流：${revision.workflowId}`,`入口：${revision.entrypoint}`,
      `业务理解版本：${revision.understanding.revisionId}`,
      `业务理解哈希：${revision.understanding.payloadHash}`,
      `前序方法版本：${revision.predecessorVersionId??'无'}`].join('\n')},
    {title:'执行提供方',text:`标识：${revision.provider.id}\n契约版本：${revision.provider.contractRevision}`},
  ];
  for(const [key,node] of Object.entries(revision.nodes)){
    if(!key.trim()||!node?.model?.trim()||!node.reasoningEffort?.trim())
      throw new Error(`Method capability node ${key} is invalid`);
    const pointerKey=key.replaceAll('~','~0').replaceAll('/','~1');
    const instructions=checked(node.instructions,`${key} instructions`);
    const outputSchema=checked(node.outputSchema,`${key} output schema`,'object');
    sections.push({title:`${key} · 模型与思考强度`,text:`模型：${node.model}\n思考强度：${node.reasoningEffort}`},
      {title:`${key} · 完整指令`,text:`SHA-256：${node.instructions.sha256}\n\n${instructions}`,
        pointer:`/nodes/${pointerKey}/instructions/content`},
      {title:`${key} · 输出格式`,text:`SHA-256：${node.outputSchema.sha256}\n\n${outputSchema}`,
        pointer:`/nodes/${pointerKey}/outputSchema/content`});
  }
  const validation=checked(revision.validation,'Validation plan','json');
  sections.push({title:'验证计划',text:`SHA-256：${revision.validation.sha256}\n\n${validation}`,
    pointer:'/validation/content'},
    {title:'版本与作者',text:[`变更原因：${revision.changeReason}`,
      `作者：${revision.authorship.kind} · ${revision.authorship.name}`,
      `记录人：${revision.recordedBy}`,`修订号：${revision.revision}`,
      `资产版本：${revision.id}`,`载荷哈希：${revision.payloadHash}`].join('\n')});
  return {title:'不可变方法能力包',sections};
};
