import type {WorkflowSpaceService,SpacePrincipal} from '@signal-room/workflow-spaces';
import {createBusinessUnderstandingStore,createMethodCapabilityStore,createMethodDesignStore} from '@signal-room/workflow-spaces';
import {SpaceProvisionRequestSchema} from './contracts.js';
import {createSpaceWorkbenchApp,type SpaceCredential} from './workbench-server.js';
import type {SpaceApiHost} from './server.js';

export interface DesignCredential extends SpaceCredential {spaceIds:readonly string[]}
export interface DesignWorkbenchOptions {
  ownerService:WorkflowSpaceService;
  serviceFor:(principal:SpacePrincipal)=>WorkflowSpaceService;
  ownerPrincipal:SpacePrincipal;
  credentials:readonly DesignCredential[];
  allowedSpaceIds:readonly string[];
  webRoot:string;
  publicOrigin:string;
  methodHostFor?:(input:{service:WorkflowSpaceService;ownerService:WorkflowSpaceService;principal:SpacePrincipal;spaceId:string;scope:{workflowId:string;entrypoint:string};canWrite:boolean})=>Pick<SpaceApiHost,'methodDesign'|'methodExecution'|'business'|'readers'|'adapter'|'availability'|'reviewStandard'|'unpublishedResponseReader'|'runDisposition'|'runDiagnosis'|'runExecutionMode'>|Promise<Pick<SpaceApiHost,'methodDesign'|'methodExecution'|'business'|'readers'|'adapter'|'availability'|'reviewStandard'|'unpublishedResponseReader'|'runDisposition'|'runDiagnosis'|'runExecutionMode'>>;
}
const readMethods=new Set(['listSpaces','overview','spaceSummary','readAsset','readAssetHead','readAssetHistory','readBlob','readContext','process',
  'validationPlans','validationPlan','validationSummary','executionTasks','readManifest','resolvePresentation','adoptionHeads',
  'readRun','readWorkflowVersion','readCase','readReview','caseRunsPage','versionRunStats','versionIterationsPage','readAssetsByIds',
  'inputManifests','runAssets','assetConsumerRuns','reviewsForAsset','reviewsForRun','getExecutionTask','sessionEvents','runtimeEvents','designSpaceState',
  'readSavedResponseTarget','readPublishedAssetTarget','readExternalAgentObservation']);
const evaluationWriteMethods=new Set(['observeSavedResponseTarget','observePublishedAsset','recordReview']);
function scopedService(service:WorkflowSpaceService,canWrite:boolean):WorkflowSpaceService {
  return new Proxy(service,{get(target,key){if(typeof key!=='string'||!(readMethods.has(key)||canWrite&&evaluationWriteMethods.has(key)))return undefined;
    const value=target[key as keyof WorkflowSpaceService];return typeof value==='function'?value.bind(target):value;}});
}
export function createDesignWorkbench(options:DesignWorkbenchOptions){
  if(options.ownerPrincipal.kind!=='human'||options.ownerPrincipal.externalAgent)throw new Error('Design host requires a human owner');
  if(new Set(options.allowedSpaceIds).size!==options.allowedSpaceIds.length||options.allowedSpaceIds.some(id=>!id.trim()))throw new Error('Invalid allowed Space IDs');
  const byPrincipal=new Map<string,DesignCredential>();
  for(const credential of options.credentials){
    if(credential.principal.id===options.ownerPrincipal.id||byPrincipal.has(credential.principal.id)||credential.spaceIds.some(id=>!options.allowedSpaceIds.includes(id)))throw new Error('Invalid design credential scope');
    byPrincipal.set(credential.principal.id,credential);
  }
  const permitted=(principal:SpacePrincipal,id:string)=>options.allowedSpaceIds.includes(id)&&
    (principal.id===options.ownerPrincipal.id||!!byPrincipal.get(principal.id)?.spaceIds.includes(id));
  const canCreateSpace=(principal:SpacePrincipal)=>principal.kind==='service'&&principal.externalAgent?.role==='design'&&!!byPrincipal.get(principal.id)?.spaceIds.length;
  return createSpaceWorkbenchApp({principal:options.ownerPrincipal,publicOrigin:options.publicOrigin,webRoot:options.webRoot,
    trustedLoopback:true,credentials:[...options.credentials],allowedSpaceIds:options.allowedSpaceIds,
    listSpaces:async principal=>{
      const service=options.serviceFor(principal);
      return Promise.all((await service.listSpaces()).filter(space=>permitted(principal,space.id)&&space.designScope&&space.provisionedBy).map(async space=>{
        const state=await service.designSpaceState(space.id);
        return {id:space.id,purpose:space.purpose,scope:state.scope,businessState:{...state.counts,understandingRevisionId:state.understandingRevisionId}};
      }));
    },
    onboarding:{canCreateSpace,allowedSpaceIds:principal=>options.allowedSpaceIds.filter(id=>permitted(principal,id)),createSpace:async(input,principal)=>{
      const parsed=SpaceProvisionRequestSchema.parse(input);
      if(!canCreateSpace(principal)||!permitted(principal,parsed.id))throw new Error('Design Space creation is outside the credential scope');
      return options.ownerService.provisionDesignSpace(parsed,principal);
    }},
    hostFor:async(principal,spaceId)=>{
      if(!permitted(principal,spaceId))return null;
      const source=options.serviceFor(principal);
      const space=(await source.listSpaces()).find(value=>value.id===spaceId);
      if(!space?.designScope||!space.provisionedBy)return null;
      const scope=space.designScope;
      const understanding=createBusinessUnderstandingStore(source);
      const method=createMethodDesignStore(source);
      const capability=createMethodCapabilityStore(source);
      const canWrite=canCreateSpace(principal);
      const facade=await options.methodHostFor?.({service:source,ownerService:options.ownerService,principal,spaceId,scope,canWrite});
      return {service:scopedService(source,canWrite),scope,
        businessState:()=>source.designSpaceState(spaceId),
        understanding:{current:understanding.current,read:understanding.read,history:understanding.history,
          ...(canWrite?{save:understanding.save}:{})},
        methodCapability:{current:()=>capability.current(spaceId,scope.workflowId),read:capability.read,
          history:()=>capability.history(spaceId,scope.workflowId),
          ...(canWrite?{save:async(id:string,input:Parameters<typeof capability.save>[1])=>{
            await createBusinessUnderstandingStore(options.ownerService).ensure(id);
            await createMethodCapabilityStore(options.ownerService).ensure(id);
            return capability.save(id,input);
          }}:{})},
        methodDesign:facade?.methodDesign??{current:()=>method.current(spaceId,scope.workflowId),read:method.read,
          history:()=>method.history(spaceId,scope.workflowId),basis:method.readBasis,
          ...(canWrite?{save:async(id:string,input:Parameters<typeof method.save>[1])=>{
            await createMethodDesignStore(options.ownerService).ensure(id);
            return method.save(id,input);
          }}:{})},
        ...(facade?.methodExecution?{methodExecution:{status:facade.methodExecution.status,
          ...(canWrite&&facade.methodExecution.command?{command:facade.methodExecution.command}:{})}}:{}),
        ...(facade?.business?{business:facade.business}:{}),
        ...(facade?.readers?{readers:facade.readers}:{}),
        ...(facade?.adapter?{adapter:facade.adapter}:{}),
        ...(facade?.availability?{availability:facade.availability}:{}),
        ...(facade?.runExecutionMode?{runExecutionMode:facade.runExecutionMode}:{}),
        ...(facade?.reviewStandard?{reviewStandard:facade.reviewStandard}:{}),
        ...(facade?.unpublishedResponseReader?{unpublishedResponseReader:facade.unpublishedResponseReader}:{}),
        ...(facade?.runDisposition?{runDisposition:{current:facade.runDisposition.current,read:facade.runDisposition.read,list:facade.runDisposition.list,
          ...(canWrite&&facade.runDisposition.save?{save:facade.runDisposition.save}:{})}}:{}),
        ...(facade?.runDiagnosis?{runDiagnosis:{current:facade.runDiagnosis.current,read:facade.runDiagnosis.read,list:facade.runDiagnosis.list,
          ...(canWrite&&facade.runDiagnosis.save?{save:facade.runDiagnosis.save}:{})}}:{}),
      };
    }});
}
