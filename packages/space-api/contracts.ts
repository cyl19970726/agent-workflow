/** Browser-safe contract: no imports of Node, pg, runners, service or business source. */
import { z } from 'zod';
export const API_VERSION = 'v1' as const;
const id = z.string().min(1).max(240);
const nullable = z.string().nullable();
const strings = z.array(z.string());
const counts = z.record(z.string(), z.number().int().nonnegative());
export const ErrorSchema=z.object({error:z.object({code:z.string(),message:z.string(),requestId:z.string(),details:z.record(z.string(),z.unknown()).optional()})});
export type ApiError=z.infer<typeof ErrorSchema>;
export const SubjectSchema=z.object({id,cacheScope:id,kind:z.enum(['human','service']).optional(),externalAgent:z.object({id,sessionId:id,role:z.enum(['design','observer']).optional()}).optional()});
export type SubjectDto=z.infer<typeof SubjectSchema>;
const businessCount=z.number().int().nonnegative();
export const DesignSpaceCountsSchema=z.object({workflowVersions:businessCount,understandingRevisions:businessCount,methodDesignRevisions:businessCount,cases:businessCount,runs:businessCount,businessAssets:businessCount,assetVersions:businessCount,adoptions:businessCount}).strict();
export const BusinessStateSchema=DesignSpaceCountsSchema.extend({understandingRevisionId:nullable}).strict();
export type BusinessStateDto=z.infer<typeof BusinessStateSchema>;
export const DesignSpaceScopeSchema=z.object({workflowId:id,entrypoint:id}).strict();
const DesignSpaceAgentSchema=z.object({agentId:id,sessionId:id,principalId:id}).strict();
export const SpaceProvisionRequestSchema=z.object({id,purpose:z.string().trim().min(1).max(1000),scope:DesignSpaceScopeSchema,idempotencyKey:id}).strict();
export type SpaceProvisionRequestDto=z.infer<typeof SpaceProvisionRequestSchema>;
export const SpaceProvisionReceiptSchema=z.object({space:z.object({id,purpose:z.string(),owner:id,status:z.enum(['active','archived']),createdAt:z.string(),designScope:DesignSpaceScopeSchema.optional(),provisionedBy:DesignSpaceAgentSchema.optional()}),scope:DesignSpaceScopeSchema,createdBy:DesignSpaceAgentSchema,initialCounts:DesignSpaceCountsSchema}).strict();
export type SpaceProvisionReceiptDto=z.infer<typeof SpaceProvisionReceiptSchema>;
export const SpaceOnboardingSchema=z.object({subject:SubjectSchema,canCreateSpace:z.boolean(),allowedSpaceIds:z.array(id),spaces:z.array(z.object({id,purpose:z.string(),scope:DesignSpaceScopeSchema.optional(),businessState:BusinessStateSchema.optional()})),csrfToken:z.string().min(1)});
export type SpaceOnboardingDto=z.infer<typeof SpaceOnboardingSchema>;
export const SummarySchema=z.object({id,title:z.string(),purpose:z.string(),subject:SubjectSchema,methodScope:z.object({workflowId:id,entrypoint:id,adoptionSlot:nullable}),adoptedVersionId:nullable,latestVersionId:nullable,counts,businessState:BusinessStateSchema.optional(),capabilities:z.object({read:z.boolean(),write:z.boolean(),attachmentWrite:z.boolean().optional(),understandingWrite:z.boolean().optional(),methodCapabilityRead:z.boolean().optional(),methodCapabilityWrite:z.boolean().optional(),methodDesignRead:z.boolean().optional(),methodDesignWrite:z.boolean().optional(),methodPublish:z.boolean().optional(),methodExecutionRead:z.boolean().optional(),methodExecutionWrite:z.boolean().optional(),reviewRead:z.boolean().optional(),reviewWrite:z.boolean().optional(),observationRead:z.boolean().optional(),observationWrite:z.boolean().optional(),dispositionRead:z.boolean().optional(),dispositionWrite:z.boolean().optional(),diagnosisRead:z.boolean().optional(),diagnosisWrite:z.boolean().optional()}),csrfToken:z.string().nullable().optional(),snapshotAt:z.string()});
export type SpaceSummaryDto=z.infer<typeof SummarySchema>;
const understandingText=z.string().refine(value=>value.trim().length>0);
export const UnderstandingSourceSchema=z.object({kind:z.enum(['document','case','asset','user-request']),ref:understandingText,title:understandingText,excerpt:z.string().optional()}).strict();
export const UnderstandingAuthorshipSchema=z.object({kind:z.enum(['agent','human']),name:understandingText,sessionId:understandingText.optional()}).strict();
export const UnderstandingRevisionRequestSchema=z.object({expectedRevisionId:understandingText.nullable(),idempotencyKey:understandingText,title:understandingText,content:understandingText,sources:z.array(UnderstandingSourceSchema).min(1),authorship:UnderstandingAuthorshipSchema,changeReason:understandingText}).strict();
export type UnderstandingRevisionRequestDto=z.infer<typeof UnderstandingRevisionRequestSchema>;
export const UnderstandingRevisionSchema=z.object({id,assetId:id,revision:z.number().int().positive(),payloadHash:z.string(),createdAt:z.string(),previousRevisionId:nullable,changeReason:z.string(),title:z.string(),content:z.string(),sources:z.array(UnderstandingSourceSchema),authorship:UnderstandingAuthorshipSchema,recordedBy:z.string(),confirmation:z.literal('unconfirmed')});
export type UnderstandingRevisionDto=z.infer<typeof UnderstandingRevisionSchema>;
const RevisionRefSchema=z.object({revisionId:understandingText,payloadHash:understandingText}).strict();
const CapabilityContentSchema=z.object({content:understandingText,sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const MethodCapabilityRevisionRequestSchema=z.object({workflowId:understandingText,entrypoint:understandingText,understanding:RevisionRefSchema,
  provider:z.object({id:understandingText,contractRevision:understandingText}).strict(),nodes:z.record(understandingText,z.object({instructions:CapabilityContentSchema,outputSchema:CapabilityContentSchema,model:understandingText,reasoningEffort:understandingText}).strict()).refine(nodes=>Object.keys(nodes).length>0),
  validation:CapabilityContentSchema,predecessorVersionId:understandingText.nullable(),changeReason:understandingText,authorship:UnderstandingAuthorshipSchema,expectedRevisionId:understandingText.nullable(),idempotencyKey:understandingText}).strict();
export type MethodCapabilityRevisionRequestDto=z.infer<typeof MethodCapabilityRevisionRequestSchema>;
export const MethodCapabilityRevisionSchema=MethodCapabilityRevisionRequestSchema.omit({expectedRevisionId:true,idempotencyKey:true}).extend({id,assetId:id,revision:z.number().int().positive(),payloadHash:understandingText,createdAt:z.string(),previousRevisionId:nullable,recordedBy:id});
export type MethodCapabilityRevisionDto=z.infer<typeof MethodCapabilityRevisionSchema>;
export const MethodDesignRevisionRequestSchema=UnderstandingRevisionRequestSchema.extend({workflowId:understandingText,entrypoint:understandingText,understanding:RevisionRefSchema,capability:RevisionRefSchema.optional()}).strict();
export type MethodDesignRevisionRequestDto=z.infer<typeof MethodDesignRevisionRequestSchema>;
export const MethodDesignRevisionSchema=UnderstandingRevisionSchema.extend({workflowId:id,entrypoint:id,understanding:z.object({revisionId:id,payloadHash:z.string().min(1)}),capability:RevisionRefSchema.optional()});
export type MethodDesignRevisionDto=z.infer<typeof MethodDesignRevisionSchema>;
export const MethodDesignBasisSchema=z.object({design:MethodDesignRevisionSchema,understanding:UnderstandingRevisionSchema,capability:MethodCapabilityRevisionSchema.optional()});
export type MethodDesignBasisDto=z.infer<typeof MethodDesignBasisSchema>;
export const MethodExecutionCommandSchema=z.object({operation:z.enum(['case-create','inputs-freeze','release','start','dispatch']),input:z.record(z.string(),z.unknown())}).strict();
export type MethodExecutionCommandDto=z.infer<typeof MethodExecutionCommandSchema>;
export const MethodExecutionStateSchema=z.record(z.string(),z.unknown());
export type MethodExecutionStateDto=z.infer<typeof MethodExecutionStateSchema>;
export const MethodDesignPreviewSchema=z.object({versionId:id,workflowId:id,entrypoint:id,designRevisionId:id,designHash:z.string().min(1),understandingRevisionId:id,understandingHash:z.string().min(1),availability:z.enum(['available','unavailable','unknown']),blockers:z.array(z.string()).optional()});
export type MethodDesignPreviewDto=z.infer<typeof MethodDesignPreviewSchema>;
export const MethodDesignPublicationRequestSchema=z.object({designRevisionId:id,expectedCandidateId:id}).strict();
export type MethodDesignPublicationRequestDto=z.infer<typeof MethodDesignPublicationRequestSchema>;
export const MethodDesignPublicationReceiptSchema=z.object({versionId:id,designRevisionId:id,understandingRevisionId:id});
export type MethodDesignPublicationReceiptDto=z.infer<typeof MethodDesignPublicationReceiptSchema>;
export const AvailabilitySchema=z.object({state:z.enum(['available','unavailable','unknown']),reason:nullable});
export type AvailabilityDto=z.infer<typeof AvailabilitySchema>;
export const VersionSummarySchema=z.object({id,workflowId:id.optional(),methodKind:z.enum(['primary','auxiliary','historical-observation']).optional(),label:z.string(),labelSource:z.string(),revision:z.string(),createdAt:z.string(),changeReason:z.string(),predecessorId:nullable,entrypoint:id,definitionAvailability:z.enum(['recorded','missing']),availability:AvailabilitySchema,runCount:z.number().int().nonnegative(),caseCount:z.number().int().nonnegative(),planIds:strings});
export type VersionSummaryDto=z.infer<typeof VersionSummarySchema>;
export const SlotSchema=z.object({slot:id,schema:z.object({namespace:id,revision:id,hash:z.string()}),label:z.string(),optional:z.boolean().nullable(),states:strings,projection:z.object({version:z.string(),fields:strings}).nullable(),requiredInputs:strings,sources:z.array(z.object({kind:z.enum(['run-input','node']),source:id,port:nullable,selection:z.string(),when:z.enum(['initial-round','later-rounds']).nullable()}))});
export type SlotDto=z.infer<typeof SlotSchema>;
export const NodeSummarySchema=z.object({id,label:z.string(),kind:z.string(),definitionRecorded:z.boolean(),purpose:nullable,executor:z.object({family:z.string(),adapter:nullable}).nullable(),model:nullable,tools:strings.nullable(),inputs:z.array(SlotSchema),outputs:z.array(SlotSchema)});
export type NodeSummaryDto=z.infer<typeof NodeSummarySchema>;
/** Method expectations, not produced assets; derived only from frozen ports and bindings. */
const ExpectedSourceSchema=z.discriminatedUnion('kind',[z.object({kind:z.literal('run-input'),name:id}),z.object({kind:z.literal('node-output'),nodeId:id,port:id})]);
const ExpectedEndpointSchema=z.object({nodeId:id,port:id});
const ExpectedSelectionSchema=z.enum(['latest-successful-in-this-run','previous-business-round','current-business-round','frozen-input']);
const ExpectedWhenSchema=z.enum(['initial-round','later-rounds']).optional();
export const ExpectedAssetSchema=z.object({id:z.string().min(1),source:ExpectedSourceSchema,label:z.string(),schema:z.object({namespace:id,revision:id,hash:z.string()}).optional(),producer:ExpectedEndpointSchema.optional(),consumers:z.array(ExpectedEndpointSchema.extend({bindingId:id,selection:ExpectedSelectionSchema,when:ExpectedWhenSchema})),resultRoles:strings,purpose:z.object({resultRoles:strings,consumerNodeIds:strings}),missing:strings});
export type ExpectedAssetDto=z.infer<typeof ExpectedAssetSchema>;
export const ExpectedAssetProjectionSchema=z.object({assets:z.array(ExpectedAssetSchema),dependencies:z.array(z.object({id,assetId:z.string().min(1),to:ExpectedEndpointSchema,selection:ExpectedSelectionSchema,when:ExpectedWhenSchema})),gaps:z.array(z.object({code:z.string(),nodeId:id.optional(),port:id.optional(),bindingId:id.optional(),message:z.string()}))});
export type ExpectedAssetProjectionDto=z.infer<typeof ExpectedAssetProjectionSchema>;
export const MethodDesignDefinitionSchema=z.object({candidateId:id,workflowId:id,entrypoint:id,designRevisionId:id,designPayloadHash:understandingText,
  understandingRevisionId:id,understandingPayloadHash:understandingText,capabilityRevisionId:id,capabilityPayloadHash:understandingText,
  provider:z.object({id,contractRevision:id,fingerprint:understandingText}),version:z.record(z.string(),z.unknown()),schemas:z.array(z.record(z.string(),z.unknown())),
  presentation:z.record(z.string(),z.unknown()).nullable(),availability:z.object({state:z.enum(['available','unavailable','unknown']),reason:z.string().nullable()}),
  expectedAssets:ExpectedAssetProjectionSchema,diagramUrl:z.string().optional()});
export type MethodDesignDefinitionDto=z.infer<typeof MethodDesignDefinitionSchema>;
export const VersionDetailSchema=VersionSummarySchema.extend({hash:z.string(),purpose:nullable,nodes:z.array(NodeSummarySchema),graphUrl:nullable,expectedAssets:ExpectedAssetProjectionSchema,adoptionSlots:strings,adoptionStatus:z.enum(['recorded','unknown']),designBasis:z.object({designRevisionId:id,designPayloadHash:z.string(),understandingRevisionId:id,understandingPayloadHash:z.string()}).nullable().optional()});
export type VersionDetailDto=z.infer<typeof VersionDetailSchema>;
/** Saved iteration evidence; an iteration record does not establish adoption. */
export const IterationSchema=z.object({id,workflowVersionId:id,hypothesis:z.string(),reviewIds:strings,caseIds:strings,runIds:strings});
export type IterationDto=z.infer<typeof IterationSchema>;
const AgentDeclarationSchema=z.object({
  reasoningEffort:nullable,timeoutMs:z.number().nonnegative().nullable(),maxTurns:z.number().int().nonnegative().nullable(),
  maxToolCalls:z.number().int().nonnegative().nullable(),outputFormat:nullable,outputSchema:z.unknown().nullable(),
  skills:z.array(z.object({name:id,sourceRef:z.string(),revision:nullable})).nullable(),
  tools:z.array(z.object({name:id,description:nullable,parameters:z.unknown().nullable(),required:strings.nullable(),
    outputSchema:z.unknown().nullable(),coverage:z.enum(['recorded','name-only'])})).nullable(),
  permissions:z.object({revision:nullable,sandboxMode:nullable,approvalPolicy:nullable,webSearchMode:nullable,
    conditionalWebSearchMode:nullable,conditionalPermissionsRevision:nullable,additionalDirectoryCount:z.number().int().nonnegative().nullable()}).nullable(),
});
export const NodeDetailSchema=NodeSummarySchema.extend({versionId:id,instructions:nullable,configuration:z.record(z.string(),z.unknown()).nullable(),agentDeclaration:AgentDeclarationSchema.nullable(),agentDeclarationCoverage:z.enum(['full','truncated']).nullable()});
export type NodeDetailDto=z.infer<typeof NodeDetailSchema>;
export const CaseSummarySchema=z.object({id,title:z.string(),objective:z.string(),constraints:strings,runCount:z.number().int().nonnegative(),assetCount:z.number().int().nonnegative()});
export type CaseSummaryDto=z.infer<typeof CaseSummarySchema>;
export const AssetSummarySchema=z.object({id,title:z.string(),kind:z.string(),state:z.string(),createdAt:z.string(),schema:z.object({namespace:id,revision:id,hash:z.string()}),sourceKind:z.enum(['import','node','historical-artifact','external-artifact','transform']),runId:nullable,caseId:nullable,versionId:nullable,nodeId:nullable,occurrenceId:nullable,round:z.number().nullable()});
export type AssetSummaryDto=z.infer<typeof AssetSummarySchema>;
export const CaseFrozenInputsSchema=z.object({caseId:id,manifests:z.array(z.object({id,hash:z.string(),slots:z.array(z.object({slot:id,asset:AssetSummarySchema,payloadHash:z.string(),readingUrl:z.string()}))})),hasMore:z.boolean(),nextCursor:nullable,snapshotAt:z.string()});
export type CaseFrozenInputsDto=z.infer<typeof CaseFrozenInputsSchema>;
export const AttachmentSchema=z.object({id:id,sha256:z.string().regex(/^[a-f0-9]{64}$/u),size:z.number().int().nonnegative(),mediaType:id}).strict();
export type AttachmentDto=z.infer<typeof AttachmentSchema>;
export const AssetAttachmentsSchema=z.object({assetVersionId:id,assetId:id,version:z.number().int().positive(),items:z.array(AttachmentSchema)}).strict();
export type AssetAttachmentsDto=z.infer<typeof AssetAttachmentsSchema>;
export const AttachmentImportRequestSchema=z.object({assetId:id,expectedHead:id.nullable(),schema:z.object({namespace:id,revision:id,hash:id}).strict(),payload:z.unknown(),description:z.string().trim().min(1).max(1000),blobIds:z.array(id).min(1).max(100),dependencies:z.array(id).max(100).optional(),idempotencyKey:id}).strict();
export type AttachmentImportRequestDto=z.infer<typeof AttachmentImportRequestSchema>;
export const AttachmentImportReceiptSchema=z.object({assetVersionId:id,assetId:id,version:z.number().int().positive(),payloadHash:id,attachments:z.array(AttachmentSchema)}).strict();
export type AttachmentImportReceiptDto=z.infer<typeof AttachmentImportReceiptSchema>;
export const RunSummarySchema=z.object({id,label:z.string(),versionId:id,caseId:id,entrypoint:id,executionMode:z.string().nullable().optional(),state:z.string(),taskState:nullable,reason:nullable,progress:nullable.default(null),startedAt:nullable,assetCount:z.number().int().nonnegative(),draftCount:z.number().int().nonnegative(),primaryAssetId:nullable});
export type RunSummaryDto=z.infer<typeof RunSummarySchema>;
export const RunDetailSchema=RunSummarySchema.extend({inputManifestId:id,inputManifestHash:z.string(),configHash:z.string(),inputAssets:z.array(AssetSummarySchema),versionLabel:z.string(),caseTitle:z.string()});
export type RunDetailDto=z.infer<typeof RunDetailSchema>;
export const RunInputManifestSchema=z.object({runId:id,caseId:id,versionId:id,inputManifestId:id,inputManifestHash:z.string(),slots:z.array(z.object({slot:id,asset:AssetSummarySchema,payloadHash:z.string()}))});
export type RunInputManifestDto=z.infer<typeof RunInputManifestSchema>;
export const RunSessionEventsSchema=z.object({runId:id,sessionId:id,items:z.array(z.object({id,seq:z.number().int().positive(),attemptId:id,kind:z.enum(['message','tool','trace','error']),body:z.unknown(),createdAt:z.string()})),nextCursor:z.number().int().nonnegative(),hasMore:z.boolean(),snapshotAt:z.string()});
export type RunSessionEventsDto=z.infer<typeof RunSessionEventsSchema>;
const NativeEventSchema=z.object({id,seq:z.number().int().positive(),type:z.string(),timestamp:z.string(),stepRunId:nullable,attemptId:nullable,
  turn:z.number().int().nonnegative().nullable(),requestAttempt:z.number().int().nonnegative().nullable(),httpStatus:z.number().int().nonnegative().nullable(),
  transport:z.object({phase:nullable,errorName:nullable,causeCode:nullable,bytesRead:z.number().int().nonnegative().nullable(),retrying:z.boolean().nullable()}).nullable(),
  response:z.object({outputItems:z.number().int().nonnegative().nullable(),output:z.array(z.object({type:z.string(),name:nullable})),hasText:z.boolean(),hasFinalText:z.boolean(),textHash:nullable}).nullable(),
  tool:z.object({name:nullable,callId:nullable,status:nullable}).nullable()}).strict();
export const NativeRunEventsSchema=z.object({runId:id,executionMode:z.enum(['imported','external-host']),items:z.array(NativeEventSchema),
  nextCursor:z.number().int().nonnegative().nullable(),hasMore:z.boolean(),snapshotAt:z.string(),sanitized:z.literal(true),
  children:z.array(z.object({runId:id,workflowId:id,state:z.string(),parentStepRunId:nullable,binding:z.enum(['bound','pending'])}).strict()).max(32)}).strict();
export type NativeRunEventsDto=z.infer<typeof NativeRunEventsSchema>;
export const RuntimeEventSchema=z.object({id,seq:z.number().int().positive(),attemptId:id,createdAt:z.string(),type:z.enum(['siwc.started','siwc.tool_call','siwc.tool_result','siwc.tool_failed']),turn:z.number().int().nonnegative().nullable(),callId:nullable,name:nullable,providerInstructions:nullable,providerModel:nullable,providerToolProfileHash:nullable,argumentsHash:nullable,outputHash:nullable,
  toolDefinitions:z.array(z.object({name:id,description:z.string(),parameters:z.unknown(),outputSchema:z.null(),outputSchemaCoverage:z.literal('not-recorded')})).nullable(),arguments:z.unknown().optional(),output:z.unknown().optional(),outcomeUnknown:z.boolean().nullable(),bodyCoverage:z.enum(['full','truncated'])});
export const RuntimeCallSchema=z.object({callId:id,name:nullable,turn:z.number().int().nonnegative().nullable(),callEventId:nullable,callSeq:z.number().int().positive().nullable(),outcomeEventId:nullable,outcomeSeq:z.number().int().positive().nullable(),status:z.enum(['returned','failed-outcome-unknown','pending-or-later-page','call-on-earlier-page'])});
export const OccurrenceRuntimeSchema=z.object({runId:id,occurrenceId:id,versionId:id,stepRunId:id,attemptId:id,contextId:id,sessionId:id,frozenPrompt:nullable,frozenPromptCoverage:z.enum(['full','truncated','unrecorded']),contextInstructions:z.string(),contextInstructionsCoverage:z.enum(['full','truncated']),effectiveConfig:z.record(z.string(),z.unknown()),events:z.array(RuntimeEventSchema),calls:z.array(RuntimeCallSchema),nextCursor:z.number().int().nonnegative(),hasMore:z.boolean(),scanComplete:z.boolean(),observedCallCount:z.number().int().nonnegative().nullable(),bodyCoverage:z.enum(['full','truncated']),evidenceScope:z.literal('saved-runner-events-only'),snapshotAt:z.string(),sanitized:z.literal(true)});
export type OccurrenceRuntimeDto=z.infer<typeof OccurrenceRuntimeSchema>;
export const TechnicalStepSchema=z.object({id, key:z.string(),kind:z.string(),state:z.string(),error:nullable});
export const TerminalFailureSchema=z.object({state:z.literal('failed'),provenance:z.literal('derived'),failedAncestorStepId:id,failedAncestorStepKey:z.string(),error:z.string()});
export const OccurrenceSchema=z.object({id,nodeId:nullable,label:z.string(),round:z.number().nullable(),branch:nullable,route:nullable,provenance:z.enum(['observed','derived','unknown']),state:z.string(),terminalFailure:TerminalFailureSchema.nullable().default(null),inputs:z.array(AssetSummarySchema),outputs:z.array(AssetSummarySchema),contextIds:strings,sessionIds:strings,attemptCount:z.number().int().nonnegative(),agentAttemptCount:z.number().int().nonnegative().nullable(),technicalStepCount:z.number().int().nonnegative(),technicalSteps:z.array(TechnicalStepSchema),failureDetails:z.array(TechnicalStepSchema)});
export type OccurrenceDto=z.infer<typeof OccurrenceSchema>;
export const WorkflowGraphStateSchema=z.object({schemaVersion:z.literal(1),spaceId:id,runId:id,versionId:id,digest:z.string(),nodes:z.array(z.object({id,state:z.string(),label:z.string(),round:z.number().nullable(),occurrences:z.array(z.object({id,branch:nullable,state:z.string(),provenance:z.enum(['observed','derived','unknown'])}))})),edges:z.array(z.object({id,state:z.enum(['none','selected','traversed']),round:z.number().nullable(),provenance:z.enum(['observed','derived']).nullable()})),truncated:z.boolean()});
export type WorkflowGraphStateDto=z.infer<typeof WorkflowGraphStateSchema>;
export const ProcessSchema=z.object({runId:id,versionId:id,caseId:id,contractSource:z.enum(['method','retrospective','unknown']),coverage:z.enum(['observed','partial','unknown']),unmappedStepIds:strings,nodes:z.array(NodeSummarySchema),occurrences:z.array(OccurrenceSchema),graphAssetIds:strings,graphUrl:nullable,graphState:WorkflowGraphStateSchema.nullable().default(null)});
export type ProcessDto=z.infer<typeof ProcessSchema>;
export const ContextSchema=z.object({id,nodeId:id,stepRunId:id,attemptId:id,producer:z.enum(['agent','program']),instructions:z.string(),model:nullable,reasoningEffort:nullable,effectiveConfig:z.record(z.string(),z.unknown()),sessionId:id});
export const OccurrenceDetailSchema=OccurrenceSchema.extend({runId:id,versionId:id,contexts:z.array(ContextSchema)});
export type OccurrenceDetailDto=z.infer<typeof OccurrenceDetailSchema>;
export const ReadingSectionSchema=z.object({title:z.string(),text:z.string(),pointer:z.string().optional(),sourceRefs:strings.optional(),view:z.enum(['body','visual','evidence']).optional()});
export type ReadingSectionDto=z.infer<typeof ReadingSectionSchema>;
export const UnpublishedResponsesSchema=z.object({runId:id,occurrenceId:id,responses:z.array(z.object({stepRunId:id,attemptId:id,sessionId:id,eventId:id,eventSeq:z.number().int().positive(),publication:z.literal('unpublished'),output:z.string(),coverage:z.enum(['full','truncated']),reading:z.object({title:z.string(),sections:z.array(ReadingSectionSchema),readerStatus:z.enum(['registered','fallback']),reason:nullable})}))});
export type UnpublishedResponsesDto=z.infer<typeof UnpublishedResponsesSchema>;
export const AssetReadingSchema=z.object({asset:AssetSummarySchema,title:z.string(),sections:z.array(ReadingSectionSchema),readerStatus:z.enum(['registered','presentation','fallback']),sourceLinks:z.array(z.object({ref:z.string(),asset:AssetSummarySchema,pointer:nullable})),payloadHash:z.string()});
export type AssetReadingDto=z.infer<typeof AssetReadingSchema>;
export const ReviewSchema=z.object({id,runId:id,assetIds:strings,createdAt:z.string(),judge:z.object({kind:z.string(),id}),standard:z.object({id,revision:z.string()}),answers:z.object({good:z.string(),bad:z.string(),improvement:z.string(),unresolved:z.string()}),baselineReviewId:nullable});
export type ReviewDto=z.infer<typeof ReviewSchema>;
export const SavedResponseTargetSchema=z.object({runId:id,occurrenceId:id,stepRunId:id,attemptId:id,sessionId:id,eventId:id,eventSeq:z.number().int().positive(),outputHash:z.string().regex(/^[0-9a-f]{64}$/u)}).strict();
export type SavedResponseTargetDto=z.infer<typeof SavedResponseTargetSchema>;
export const PublishedAssetTargetSchema=z.object({runId:id,assetVersionId:id,payloadHash:z.string().regex(/^[0-9a-f]{64}$/u)}).strict();
export type PublishedAssetTargetDto=z.infer<typeof PublishedAssetTargetSchema>;
const NodeAssetSourceSchema=z.object({kind:z.literal('node'),runId:id,stepRunId:id,attemptId:id,nodeId:id,producer:z.enum(['agent','program']),sessionId:id,contextId:id,generatedByContextId:id.optional()});
const HistoricalArtifactSourceSchema=z.object({kind:z.literal('historical-artifact'),runId:id,stepRunId:id,attemptId:id,artifactId:id,sourceWorkspaceId:id,originalSha256:z.string().regex(/^[a-f0-9]{64}$/u),originalUri:z.string()});
const ExternalArtifactSourceSchema=z.object({kind:z.literal('external-artifact'),runId:id,stepRunId:id,attemptId:id,artifactId:id,sourceWorkspaceId:id,originalSha256:z.string().regex(/^[a-f0-9]{64}$/u),originalUri:z.string()});
export const ExternalAgentObservationReceiptSchema=z.object({id,assetId:id,payloadHash:z.string(),createdAt:z.string(),target:SavedResponseTargetSchema,observer:z.object({id,sessionId:id,servicePrincipalId:id}),producerNativeSessionId:id.optional(),delivery:z.literal('saved-response-read')});
export type ExternalAgentObservationReceiptDto=z.infer<typeof ExternalAgentObservationReceiptSchema>;
export const ExternalAgentAssetObservationReceiptSchema=z.object({id,assetId:id,payloadHash:z.string(),createdAt:z.string(),target:PublishedAssetTargetSchema,source:z.discriminatedUnion('kind',[NodeAssetSourceSchema,HistoricalArtifactSourceSchema,ExternalArtifactSourceSchema]),observer:z.object({id,sessionId:id,servicePrincipalId:id}),producerNativeSessionIds:strings,delivery:z.literal('published-asset-read')});
export type ExternalAgentAssetObservationReceiptDto=z.infer<typeof ExternalAgentAssetObservationReceiptSchema>;
export const ExternalAgentObservationReceiptUnionSchema=z.discriminatedUnion('delivery',[ExternalAgentObservationReceiptSchema,ExternalAgentAssetObservationReceiptSchema]);
export const ExternalAgentObservationRequestSchema=z.object({target:SavedResponseTargetSchema}).strict();
export type ExternalAgentObservationRequestDto=z.infer<typeof ExternalAgentObservationRequestSchema>;
export const ExternalAgentObservationSchema=z.object({receipt:ExternalAgentObservationReceiptSchema,response:z.object({publication:z.literal('unpublished'),output:z.string(),coverage:z.literal('full'),reading:z.object({title:z.string(),sections:z.array(ReadingSectionSchema),readerStatus:z.enum(['registered','fallback']),reason:nullable})})});
export type ExternalAgentObservationDto=z.infer<typeof ExternalAgentObservationSchema>;
export const ExternalAgentAssetObservationRequestSchema=z.object({target:PublishedAssetTargetSchema}).strict();
export type ExternalAgentAssetObservationRequestDto=z.infer<typeof ExternalAgentAssetObservationRequestSchema>;
export const ExternalAgentAssetObservationSchema=z.object({receipt:ExternalAgentAssetObservationReceiptSchema,asset:z.object({target:PublishedAssetTargetSchema,publication:z.literal('published'),payload:z.string(),coverage:z.literal('full'),reading:z.object({title:z.string(),sections:z.array(ReadingSectionSchema),readerStatus:z.enum(['registered','fallback']),reason:nullable})})});
export type ExternalAgentAssetObservationDto=z.infer<typeof ExternalAgentAssetObservationSchema>;
const ReviewAnswerSchema=z.object({good:understandingText,bad:understandingText,improvement:understandingText,unresolved:understandingText}).strict();
const ReviewStandardSchema=z.object({id,revision:id,content:understandingText}).strict();
export const RunReviewRequestSchema=z.object({id,runId:id,assetVersionIds:z.array(id),responseTarget:SavedResponseTargetSchema.optional(),observationReceiptId:id.optional(),baselineReviewId:id.optional(),standard:ReviewStandardSchema,judge:z.object({kind:z.enum(['human','agent']),id,sessionId:id.optional()}).strict(),evidence:z.array(id),evidencePointers:z.array(z.string()).optional(),answers:ReviewAnswerSchema}).strict().refine(value=>Boolean(value.responseTarget)!==(value.assetVersionIds.length>0),{message:'Exactly one review target form is required'});
export type RunReviewRequestDto=z.infer<typeof RunReviewRequestSchema>;
export const RunReviewSchema=z.object({id,spaceId:id,runId:id,assetVersionIds:z.array(id),responseTarget:SavedResponseTargetSchema.optional(),observationReceiptId:id.optional(),baselineReviewId:id.optional(),standard:ReviewStandardSchema,judge:z.object({kind:z.enum(['human','agent']),id,sessionId:id.optional()}),evidence:z.array(id),evidencePointers:z.array(z.string()).optional(),answers:ReviewAnswerSchema,createdAt:z.string()});
export type RunReviewDto=z.infer<typeof RunReviewSchema>;
export const ReviewSubjectsSchema=z.object({runId:id,caseId:id,versionId:id,standard:ReviewStandardSchema.nullable(),subjects:z.array(z.discriminatedUnion('kind',[z.object({kind:z.literal('asset'),asset:AssetSummarySchema,target:PublishedAssetTargetSchema,standard:ReviewStandardSchema.nullable().optional()}),z.object({kind:z.literal('response'),target:SavedResponseTargetSchema,occurrenceLabel:z.string(),standard:ReviewStandardSchema.nullable().optional()})])),failures:z.array(z.object({stepRunId:id,key:z.string(),error:z.string()}))});
export type ReviewSubjectsDto=z.infer<typeof ReviewSubjectsSchema>;
export const RunDispositionEvidenceRefSchema=z.discriminatedUnion('kind',[z.object({kind:z.literal('asset'),assetVersionId:id,pointer:z.string().optional()}).strict(),z.object({kind:z.literal('response'),target:SavedResponseTargetSchema,pointer:z.string().optional()}).strict(),z.object({kind:z.literal('run'),runId:id,stepRunId:id.optional()}).strict()]);
export const RunDispositionRequestSchema=z.object({runId:id,reviewIds:z.array(id).min(1),action:z.enum(['keep','revise','supplement','change-method','stop','defer']),reason:understandingText,unknowns:z.array(z.string()),evidenceRefs:z.array(RunDispositionEvidenceRefSchema),observationReceiptId:id.optional(),expectedRevisionId:id.nullable(),idempotencyKey:id}).strict();
export type RunDispositionRequestDto=z.infer<typeof RunDispositionRequestSchema>;
export const RunDispositionRevisionSchema=z.object({id,assetId:id,runId:id,revision:z.number().int().positive(),payloadHash:z.string(),createdAt:z.string(),previousRevisionId:nullable,recordedBy:id,author:z.discriminatedUnion('kind',[z.object({id,kind:z.literal('human')}),z.object({id,kind:z.literal('agent'),sessionId:id,servicePrincipalId:id})]),confirmation:z.literal('unconfirmed'),reviewIds:z.array(id),action:z.enum(['keep','revise','supplement','change-method','stop','defer']),reason:z.string(),unknowns:z.array(z.string()),evidenceRefs:z.array(RunDispositionEvidenceRefSchema),observationReceiptId:id.optional(),observationReceiptIds:strings.default([])});
export type RunDispositionRevisionDto=z.infer<typeof RunDispositionRevisionSchema>;
const diagnosisText=understandingText.max(20_000);
const diagnosisShort=understandingText.max(2_000);
export const RunDiagnosisRouteSchema=z.enum(['revise-work','supplement-input','calibrate-judge','change-method','dogfood-issue','design-method','defer','no-change']);
export const RunDiagnosisCategorySchema=z.enum(['input','responsibility','handoff','generation','validation-recovery','judge','harness','design-method','other']);
export const RunDiagnosisEvidenceRefSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('asset'),assetVersionId:id,payloadHash:id,pointer:z.string().max(2_000).optional()}).strict(),
  z.object({kind:z.literal('response'),target:SavedResponseTargetSchema,pointer:z.string().max(2_000).optional()}).strict(),
  z.object({kind:z.literal('review'),reviewId:id,pointer:z.string().max(2_000).optional()}).strict(),
  z.object({kind:z.literal('disposition'),revisionId:id,payloadHash:id,pointer:z.string().max(2_000).optional()}).strict(),
  z.object({kind:z.literal('inputs'),manifestId:id,payloadHash:id,pointer:z.string().max(2_000).optional()}).strict(),
  z.object({kind:z.literal('trace'),sessionId:id,eventId:id.optional(),eventSeq:z.number().int().positive().optional(),pointer:z.string().max(2_000).optional()}).strict(),
  z.object({kind:z.literal('run'),runId:id,stepRunId:id.optional()}).strict(),
]);
export const RunDiagnosisHypothesisSchema=z.object({id,category:RunDiagnosisCategorySchema,explanation:diagnosisText,supportRefs:z.array(RunDiagnosisEvidenceRefSchema).max(100),counterRefs:z.array(RunDiagnosisEvidenceRefSchema).max(100),unknowns:z.array(diagnosisShort).max(100),discriminatingCheck:diagnosisShort}).strict();
export const RunDiagnosisIssueSchema=z.object({id,title:diagnosisShort,expected:diagnosisText,observed:diagnosisText,evidenceRefs:z.array(RunDiagnosisEvidenceRefSchema).min(1).max(100),hypotheses:z.array(RunDiagnosisHypothesisSchema).min(1).max(20),unknowns:z.array(diagnosisShort).max(100),decision:z.object({route:RunDiagnosisRouteSchema,reason:diagnosisText,nextCheck:diagnosisShort.optional(),externalIssueRef:id.optional(),designSessionRef:id.optional()}).strict()}).strict();
export const RunDiagnosisCandidateDraftSchema=z.object({predecessorVersionId:id,issueIds:z.array(id).min(1).max(50),hypothesisIds:z.array(id).min(1).max(100),changes:z.array(z.object({target:diagnosisShort,before:diagnosisText,after:diagnosisText,reason:diagnosisText}).strict()).min(1).max(100),expectedBenefits:z.array(diagnosisShort).min(1).max(100),risks:z.array(diagnosisShort).min(1).max(100),validationPlan:diagnosisText,falsificationConditions:z.array(diagnosisShort).min(1).max(100),conditions:z.array(diagnosisShort).max(100)}).strict();
export const RunDiagnosisRequestSchema=z.object({runId:id,reviewIds:z.array(id).min(1).max(100),dispositionRevisionId:id,dispositionPayloadHash:id,issues:z.array(RunDiagnosisIssueSchema).min(1).max(50),candidateDraft:RunDiagnosisCandidateDraftSchema.optional(),expectedRevisionId:id.nullable(),idempotencyKey:id,observationReceiptId:id.optional()}).strict();
export type RunDiagnosisRequestDto=z.infer<typeof RunDiagnosisRequestSchema>;
export const RunDiagnosisRevisionSchema=RunDiagnosisRequestSchema.omit({expectedRevisionId:true,idempotencyKey:true}).extend({id,assetId:id,revision:z.number().int().positive(),payloadHash:z.string(),createdAt:z.string(),workflowVersionId:id,previousRevisionId:nullable,author:z.discriminatedUnion('kind',[z.object({id,kind:z.literal('human')}),z.object({id,kind:z.literal('agent'),sessionId:id,servicePrincipalId:id})]),recordedBy:id,confirmation:z.literal('unconfirmed'),candidateStatus:z.literal('unregistered-unvalidated-unadopted').optional()});
export type RunDiagnosisRevisionDto=z.infer<typeof RunDiagnosisRevisionSchema>;
export const ReviewReadingSchema=z.object({review:ReviewSchema,assets:z.array(AssetSummarySchema)});
export type ReviewReadingDto=z.infer<typeof ReviewReadingSchema>;
export const ConsumerSchema=z.object({runId:id,versionId:id,caseId:id,nodeId:nullable,nodeLabel:z.string(),occurrenceId:id,round:z.number().nullable(),state:z.string()});
export const AssetRelationsSchema=z.object({assetId:id,producer:z.object({runId:id,versionId:id,caseId:id,nodeId:nullable,nodeLabel:z.string(),occurrenceId:nullable,round:z.number().nullable()}).nullable(),dependencies:z.array(AssetSummarySchema),previousDraft:AssetSummarySchema.nullable(),assessments:z.array(AssetSummarySchema),consumers:z.array(ConsumerSchema),reviews:z.array(ReviewSchema),nextCursor:nullable,snapshotAt:z.string()});
export type AssetRelationsDto=z.infer<typeof AssetRelationsSchema>;
export const PlanSummarySchema=z.object({id,question:z.string(),hypothesis:z.string(),status:z.string(),baselineVersionId:id,candidateVersionId:id,createdAt:z.string(),totals:counts});
export type PlanSummaryDto=z.infer<typeof PlanSummarySchema>;
export const PlanDetailSchema=PlanSummarySchema.extend({entries:z.array(z.object({id,side:z.string(),caseId:id,status:z.string(),runIds:strings})),standard:z.object({id,revision:z.string(),content:z.string()}),expectedVariables:strings});
export type PlanDetailDto=z.infer<typeof PlanDetailSchema>;
/** Plan commands expose only selected frozen relationships, never provider or DB configuration. */
export const EntryActionsSchema=z.object({start:z.boolean(),resume:z.boolean(),reason:nullable,resumeTarget:z.object({attempt:z.number().int().positive(),runId:id}).nullable()});
export type EntryActionsDto=z.infer<typeof EntryActionsSchema>;
export const JudgeEvidenceSchema=z.object({reviewId:id,verified:z.boolean(),expectedProfileHash:nullable,observedProfileHash:nullable,differences:z.record(z.string(),z.object({expected:z.unknown(),observed:z.unknown()}))});
export const PlanAttemptSchema=z.object({attempt:z.number().int().positive(),runId:id,status:z.string(),task:z.object({status:z.string(),error:nullable}).nullable(),run:z.object({state:z.string(),error:nullable}).nullable(),reviews:z.array(ReviewSchema.extend({evidence:strings})),judgeEvidence:z.array(JudgeEvidenceSchema)});
export type PlanAttemptDto=z.infer<typeof PlanAttemptSchema>;
export const QueueTaskSchema=z.object({runId:id,versionId:id,caseId:id,inputManifestId:id,executorKey:id,status:z.string(),planId:nullable,entryId:nullable});
export const PlanEntrySchema=z.object({planId:id,entryId:id,side:z.enum(['baseline','candidate']),repeat:z.number().int().positive(),caseId:id,caseTitle:z.string(),versionId:id,entrypoint:id,planStatus:z.string(),status:z.string(),availability:AvailabilitySchema,manifest:z.object({id,hash:z.string(),caseId:id,slots:z.array(z.object({slot:id,asset:AssetSummarySchema,payloadHash:z.string()}))}),inputSections:z.array(ReadingSectionSchema),inputSummary:strings.default([]),standard:z.object({id,revision:z.string(),content:z.string()}),requiredJudgeCoverage:z.array(z.object({kind:z.enum(['agent','human']),id,reviewIds:strings,unverifiedReviewIds:strings})),attempts:z.array(PlanAttemptSchema),attemptsTruncated:z.boolean(),nextAttempt:z.number().int().positive(),queue:z.array(QueueTaskSchema),queueTruncated:z.boolean(),actions:EntryActionsSchema,snapshotAt:z.string()});
export type PlanEntryDto=z.infer<typeof PlanEntrySchema>;
export const PlanComparisonSchema=z.object({id,baselineEntryId:id,candidateEntryId:id,baselineReviewId:id,candidateReviewId:id,conclusion:z.string(),changedConditions:z.record(z.string(),z.object({baseline:z.unknown(),candidate:z.unknown()}))});
export type PlanComparisonDto=z.infer<typeof PlanComparisonSchema>;
export const ComparisonSubjectSchema=z.object({side:z.enum(['baseline','candidate']),entryId:id,attempt:z.number().int().positive(),runId:id,versionId:id,versionLabel:z.string(),caseId:id,caseTitle:z.string(),inputManifestId:id,inputManifestHash:z.string(),review:ReviewSchema,asset:AssetSummarySchema});
export type ComparisonSubjectDto=z.infer<typeof ComparisonSubjectSchema>;
export const ComparisonReadingSchema=z.object({id,planId:id,status:z.enum(['ready','unavailable']),reason:nullable,conclusion:z.string(),baseline:ComparisonSubjectSchema.nullable(),candidate:ComparisonSubjectSchema.nullable()});
export type ComparisonReadingDto=z.infer<typeof ComparisonReadingSchema>;
export const PlanIssueSchema=z.object({id,kind:z.enum(['observation','cause-hypothesis']),category:z.string(),text:z.string(),nextHypothesis:nullable,evidence:z.array(z.object({entryId:id,caseId:id,runId:nullable,nodeId:nullable})),createdAt:z.string()});
export type PlanIssueDto=z.infer<typeof PlanIssueSchema>;
export const PlanStartRequestSchema=z.object({inputManifestId:id}).strict();
export const PlanDispatchRequestSchema=z.object({}).strict();
export const PlanCommandReceiptSchema=z.object({requestId:id,planId:id,entryId:id,attempt:z.number().int().positive(),runId:id,caseId:id,versionId:id,inputManifestId:id,inputManifestHash:z.string(),status:z.string(),dispatched:z.boolean(),dispatchError:nullable});
export type PlanCommandReceiptDto=z.infer<typeof PlanCommandReceiptSchema>;
/** Ordinary business commands are independent of validation plans. */
export const BusinessFormSchema=z.object({title:z.string(),description:z.string(),fields:z.array(z.object({key:id,label:z.string(),kind:z.enum(['text','multiline','lines','materials']),required:z.boolean(),help:z.string().optional(),defaultValue:z.unknown().optional()})),conditions:strings});
export type BusinessFormDto=z.infer<typeof BusinessFormSchema>;
export const BusinessPrepareRequestSchema=z.object({key:id,versionId:id,values:z.record(z.string(),z.unknown())}).strict();
export type BusinessPrepareRequestDto=z.infer<typeof BusinessPrepareRequestSchema>;
export const BusinessPreparationInputSchema=AssetSummarySchema.extend({payloadHash:z.string()});
export const BusinessPreparationSchema=z.object({caseId:id,caseTitle:z.string(),objective:z.string(),versionId:id,versionLabel:z.string(),inputManifestId:id,inputManifestHash:z.string(),inputs:z.array(BusinessPreparationInputSchema),sections:z.array(ReadingSectionSchema),conditions:strings,runs:z.array(RunSummarySchema),actions:z.object({start:z.boolean(),dispatch:z.boolean(),reason:nullable})});
export type BusinessPreparationDto=z.infer<typeof BusinessPreparationSchema>;
export const BusinessStartRequestSchema=z.object({versionId:id,inputManifestId:id,key:id}).strict();
export const BusinessDispatchRequestSchema=z.object({versionId:id,inputManifestId:id}).strict();
export const BusinessCommandReceiptSchema=z.object({requestId:id,caseId:id,versionId:id,inputManifestId:id,inputManifestHash:z.string(),runId:id,status:z.string(),dispatched:z.boolean(),dispatchError:nullable});
export type BusinessCommandReceiptDto=z.infer<typeof BusinessCommandReceiptSchema>;
export const HandlingNoteRequestSchema=z.object({key:id,author:z.object({kind:z.literal('external-agent'),name:z.string().min(1),threadId:id}).strict(),answers:z.object({good:z.string(),bad:z.string(),improvement:z.string(),unresolved:z.string()}).strict(),recommendation:z.enum(['needs_revision','pending_human_review','defer']),nextStep:z.string().min(1),referencedAssetIds:z.array(id).max(50)}).strict();
export type HandlingNoteRequestDto=z.infer<typeof HandlingNoteRequestSchema>;
export const HandlingNoteSchema=HandlingNoteRequestSchema.omit({key:true}).extend({id,caseId:id,runId:id,subjectAssetId:id,createdAt:z.string(),importedBy:id,verification:z.literal('declared-external')});
export type HandlingNoteDto=z.infer<typeof HandlingNoteSchema>;
export const HandlingNoteListSchema=z.object({items:z.array(HandlingNoteSchema).max(100),truncated:z.boolean(),nextCursor:z.null(),snapshotAt:z.string()});
export type HandlingNoteListDto=z.infer<typeof HandlingNoteListSchema>;
export function listSchema<T extends z.ZodType>(item:T){return z.object({items:z.array(item),nextCursor:nullable,snapshotAt:z.string()});}
export const UnderstandingRevisionListSchema=listSchema(UnderstandingRevisionSchema);
export const MethodDesignRevisionListSchema=listSchema(MethodDesignRevisionSchema);
export const MethodCapabilityRevisionListSchema=listSchema(MethodCapabilityRevisionSchema);
export const RunDiagnosisRevisionListSchema=listSchema(RunDiagnosisRevisionSchema);
export interface CursorList<T>{items:T[];nextCursor:string|null;snapshotAt:string}
export type ApiSchema = z.ZodType;
/** Validate unknown HTTP data at the browser boundary, before storing it in the query cache. */
export function parseDto<T>(schema:z.ZodType<T>,value:unknown):T{return schema.parse(value);}
