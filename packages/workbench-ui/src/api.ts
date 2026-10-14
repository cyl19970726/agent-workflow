import {
  AssetReadingSchema, AssetRelationsSchema, AssetSummarySchema, CaseSummarySchema, CaseFrozenInputsSchema, ErrorSchema,
  AssetAttachmentsSchema,
  NodeDetailSchema, OccurrenceDetailSchema, PlanDetailSchema, ProcessSchema, RunDetailSchema,
  RunSummarySchema, SummarySchema, VersionDetailSchema, VersionSummarySchema, PlanSummarySchema,
  PlanEntrySchema, PlanAttemptSchema, PlanComparisonSchema, PlanIssueSchema, PlanCommandReceiptSchema,
  ComparisonReadingSchema, ReviewReadingSchema,
  BusinessFormSchema, BusinessPreparationSchema, BusinessCommandReceiptSchema, HandlingNoteSchema, HandlingNoteListSchema,
  IterationSchema,
  UnderstandingRevisionSchema, UnderstandingRevisionListSchema,
  MethodDesignRevisionSchema, MethodDesignRevisionListSchema, MethodDesignPreviewSchema, MethodDesignDefinitionSchema, MethodDesignPublicationReceiptSchema, MethodDesignBasisSchema,
  RunSessionEventsSchema, OccurrenceRuntimeSchema, NativeRunEventsSchema,
  RunInputManifestSchema,
  UnpublishedResponsesSchema,
  ReviewSubjectsSchema, RunReviewSchema, RunDispositionRevisionSchema,
  ExternalAgentObservationSchema, ExternalAgentObservationReceiptUnionSchema, ExternalAgentAssetObservationSchema,
  RunDiagnosisRevisionSchema, RunDiagnosisRevisionListSchema,
  listSchema, parseDto,
  type AssetReadingDto, type AssetRelationsDto, type AssetSummaryDto, type CaseSummaryDto, type CaseFrozenInputsDto,
  type AssetAttachmentsDto, type AttachmentDto,
  type CursorList, type NodeDetailDto, type OccurrenceDetailDto, type PlanDetailDto,
  type ProcessDto, type RunDetailDto, type RunSummaryDto, type SpaceSummaryDto, type OccurrenceRuntimeDto,
  type PlanSummaryDto, type PlanEntryDto, type PlanAttemptDto, type PlanComparisonDto,
  type PlanIssueDto, type PlanCommandReceiptDto,
  type ComparisonReadingDto, type ReviewReadingDto,
  type BusinessFormDto, type BusinessPreparationDto, type BusinessCommandReceiptDto, type HandlingNoteDto, type HandlingNoteRequestDto, type HandlingNoteListDto,
  type IterationDto,
  type UnderstandingRevisionDto, type UnderstandingRevisionRequestDto,
  type MethodDesignRevisionDto, type MethodDesignRevisionRequestDto, type MethodDesignPreviewDto, type MethodDesignDefinitionDto, type MethodDesignPublicationReceiptDto, type MethodDesignBasisDto,
  type RunSessionEventsDto, type NativeRunEventsDto,
  type RunInputManifestDto,
  type UnpublishedResponsesDto,
  type ReviewSubjectsDto, type RunReviewDto, type RunReviewRequestDto, type RunDispositionRevisionDto, type RunDispositionRequestDto,
  type ExternalAgentObservationDto, type ExternalAgentAssetObservationDto, type ExternalAgentObservationReceiptDto, type ExternalAgentAssetObservationReceiptDto, type PublishedAssetTargetDto, type SavedResponseTargetDto,
  type RunDiagnosisRevisionDto, type RunDiagnosisRequestDto,
  type VersionDetailDto, type VersionSummaryDto,
} from '@signal-room/workflow-space-api/contracts';
import type { z } from 'zod';
export type { UnderstandingRevisionDto, UnderstandingRevisionRequestDto } from '@signal-room/workflow-space-api/contracts';

export class SpaceApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function encoded(id: string): string { return encodeURIComponent(id); }

export class SpaceApi {
  readonly root: string;
  constructor(apiBase: string, spaceId: string) {
    this.root = `${apiBase.replace(/\/$/, '')}/spaces/${encoded(spaceId)}`;
  }
  async get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.root}${path}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const error = ErrorSchema.safeParse(await response.json().catch(() => null));
      throw new SpaceApiError(error.success ? error.data.error.code : `HTTP_${response.status}`, error.success ? error.data.error.message : `请求失败 (${response.status})`, response.status);
    }
    return parseDto(schema, await response.json());
  }
  async post<T>(path: string, body: object, csrfToken: string, schema: z.ZodType<T>): Promise<T> {
    if (!csrfToken) throw new SpaceApiError('COMMAND_UNAVAILABLE', '当前宿主未开放此操作。', 403);
    const response = await fetch(`${this.root}${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-space-csrf': csrfToken }, body: JSON.stringify(body) });
    if (!response.ok) {
      const error = ErrorSchema.safeParse(await response.json().catch(() => null));
      throw new SpaceApiError(error.success ? error.data.error.code : `HTTP_${response.status}`, error.success ? error.data.error.message : `操作失败 (${response.status})`, response.status);
    }
    return parseDto(schema, await response.json());
  }
  summary(signal?: AbortSignal): Promise<SpaceSummaryDto> { return this.get('/summary', SummarySchema, signal); }
  understanding(revisionId?: string, signal?: AbortSignal): Promise<UnderstandingRevisionDto> { return this.get(`/understanding${revisionId ? `?revision=${encoded(revisionId)}` : ''}`, UnderstandingRevisionSchema, signal); }
  understandingRevisions(cursor?: string, signal?: AbortSignal): Promise<CursorList<UnderstandingRevisionDto>> { return this.get(`/understanding/revisions${cursor ? `?cursor=${encoded(cursor)}` : ''}`, UnderstandingRevisionListSchema, signal); }
  saveUnderstanding(input: UnderstandingRevisionRequestDto, csrfToken: string): Promise<UnderstandingRevisionDto> { return this.post('/understanding/revisions', input, csrfToken, UnderstandingRevisionSchema); }
  methodDesign(revisionId?: string, signal?: AbortSignal): Promise<MethodDesignRevisionDto> { return this.get(`/method-design${revisionId ? `?revision=${encoded(revisionId)}` : ''}`, MethodDesignRevisionSchema, signal); }
  methodDesignRevisions(cursor?: string, signal?: AbortSignal): Promise<CursorList<MethodDesignRevisionDto>> { return this.get(`/method-design/revisions${cursor ? `?cursor=${encoded(cursor)}` : ''}`, MethodDesignRevisionListSchema, signal); }
  saveMethodDesign(input: MethodDesignRevisionRequestDto, csrfToken: string): Promise<MethodDesignRevisionDto> { return this.post('/method-design/revisions', input, csrfToken, MethodDesignRevisionSchema); }
  methodDesignPreview(revisionId: string, signal?: AbortSignal): Promise<MethodDesignPreviewDto> { return this.get(`/method-design/preview?revision=${encoded(revisionId)}`, MethodDesignPreviewSchema, signal); }
  methodDesignDefinition(revisionId: string, signal?: AbortSignal): Promise<MethodDesignDefinitionDto> { return this.get(`/method-design/definition?revision=${encoded(revisionId)}`, MethodDesignDefinitionSchema, signal); }
  publishMethodDesign(designRevisionId: string, expectedCandidateId: string, csrfToken: string): Promise<MethodDesignPublicationReceiptDto> { return this.post('/method-design/publications', { designRevisionId, expectedCandidateId }, csrfToken, MethodDesignPublicationReceiptSchema); }
  versionDesignBasis(versionId: string, signal?: AbortSignal): Promise<MethodDesignBasisDto> { return this.get(`/versions/${encoded(versionId)}/design`, MethodDesignBasisSchema, signal); }
  versions(cursor?: string, signal?: AbortSignal): Promise<CursorList<VersionSummaryDto>> { return this.get(`/versions${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(VersionSummarySchema), signal); }
  version(id: string, signal?: AbortSignal): Promise<VersionDetailDto> { return this.get(`/versions/${encoded(id)}`, VersionDetailSchema, signal); }
  versionCases(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<CaseSummaryDto>> { return this.get(`/versions/${encoded(id)}/cases${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(CaseSummarySchema), signal); }
  versionIterations(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<IterationDto>> { return this.get(`/versions/${encoded(id)}/iterations${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(IterationSchema), signal); }
  node(versionId: string, nodeId: string, signal?: AbortSignal): Promise<NodeDetailDto> { return this.get(`/versions/${encoded(versionId)}/nodes/${encoded(nodeId)}`, NodeDetailSchema, signal); }
  cases(cursor?: string, signal?: AbortSignal): Promise<CursorList<CaseSummaryDto>> { return this.get(`/cases${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(CaseSummarySchema), signal); }
  case(id: string, signal?: AbortSignal): Promise<CaseSummaryDto> { return this.get(`/cases/${encoded(id)}`, CaseSummarySchema, signal); }
  caseFrozenInputs(id: string, options: { after?: string; manifestId?: string } = {}, signal?: AbortSignal): Promise<CaseFrozenInputsDto> {
    const query = new URLSearchParams();
    if (options.manifestId) query.set('manifestId', options.manifestId);
    else if (options.after) query.set('after', options.after);
    return this.get(`/cases/${encoded(id)}/inputs${query.size ? `?${query}` : ''}`, CaseFrozenInputsSchema, signal);
  }
  caseRuns(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<RunSummaryDto>> { return this.get(`/cases/${encoded(id)}/runs${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(RunSummarySchema), signal); }
  run(id: string, signal?: AbortSignal): Promise<RunDetailDto> { return this.get(`/runs/${encoded(id)}`, RunDetailSchema, signal); }
  runPublishedAssets(runId: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<AssetSummaryDto>> { return this.get(`/assets?runId=${encoded(runId)}${cursor ? `&cursor=${encoded(cursor)}` : ''}`, listSchema(AssetSummarySchema), signal); }
  runDiagnosis(runId: string, signal?: AbortSignal): Promise<RunDiagnosisRevisionDto | null> { return this.get(`/runs/${encoded(runId)}/diagnosis`, RunDiagnosisRevisionSchema.nullable(), signal); }
  runDiagnoses(runId: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<RunDiagnosisRevisionDto>> { return this.get(`/runs/${encoded(runId)}/diagnoses${cursor ? `?cursor=${encoded(cursor)}` : ''}`, RunDiagnosisRevisionListSchema, signal); }
  runDiagnosisRevision(runId: string, revisionId: string, signal?: AbortSignal): Promise<RunDiagnosisRevisionDto> { return this.get(`/runs/${encoded(runId)}/diagnoses/${encoded(revisionId)}`, RunDiagnosisRevisionSchema, signal); }
  saveRunDiagnosis(runId: string, input: RunDiagnosisRequestDto, csrfToken: string): Promise<RunDiagnosisRevisionDto> { return this.post(`/runs/${encoded(runId)}/diagnoses`, input, csrfToken, RunDiagnosisRevisionSchema); }
  runInputs(id: string, signal?: AbortSignal): Promise<RunInputManifestDto> { return this.get(`/runs/${encoded(id)}/inputs`, RunInputManifestSchema, signal); }
  runSessionEvents(runId: string, sessionId: string, after = 0, signal?: AbortSignal): Promise<RunSessionEventsDto> { return this.get(`/runs/${encoded(runId)}/sessions/${encoded(sessionId)}/events?after=${after}&limit=50`, RunSessionEventsSchema, signal); }
  nativeRunEvents(runId: string, after = 0, signal?: AbortSignal): Promise<NativeRunEventsDto> { return this.get(`/runs/${encoded(runId)}/native-events?after=${after}&limit=50`, NativeRunEventsSchema, signal); }
  process(id: string, signal?: AbortSignal): Promise<ProcessDto> { return this.get(`/runs/${encoded(id)}/process`, ProcessSchema, signal); }
  occurrence(runId: string, occurrenceId: string, signal?: AbortSignal): Promise<OccurrenceDetailDto> { return this.get(`/runs/${encoded(runId)}/occurrences/${encoded(occurrenceId)}`, OccurrenceDetailSchema, signal); }
  occurrenceRuntime(runId: string, occurrenceId: string, attemptId: string, after = 0, signal?: AbortSignal): Promise<OccurrenceRuntimeDto> { return this.get(`/runs/${encoded(runId)}/occurrences/${encoded(occurrenceId)}/runtime?attemptId=${encoded(attemptId)}&after=${after}&limit=100`, OccurrenceRuntimeSchema, signal); }
  unpublishedResponses(runId: string, occurrenceId: string, signal?: AbortSignal): Promise<UnpublishedResponsesDto> { return this.get(`/runs/${encoded(runId)}/occurrences/${encoded(occurrenceId)}/responses`, UnpublishedResponsesSchema, signal); }
  reviewSubjects(runId: string, signal?: AbortSignal): Promise<ReviewSubjectsDto> { return this.get(`/runs/${encoded(runId)}/review-subjects`, ReviewSubjectsSchema, signal); }
  observeSavedResponse(runId: string, target: SavedResponseTargetDto, csrfToken: string): Promise<ExternalAgentObservationDto> { return this.post(`/runs/${encoded(runId)}/review-observations`, { target }, csrfToken, ExternalAgentObservationSchema); }
  observePublishedAsset(runId: string, target: PublishedAssetTargetDto, csrfToken: string): Promise<ExternalAgentAssetObservationDto> { return this.post(`/runs/${encoded(runId)}/asset-observations`, { target }, csrfToken, ExternalAgentAssetObservationSchema); }
  reviewObservation(runId: string, receiptId: string, signal?: AbortSignal): Promise<ExternalAgentObservationReceiptDto | ExternalAgentAssetObservationReceiptDto> { return this.get(`/runs/${encoded(runId)}/review-observations/${encoded(receiptId)}`, ExternalAgentObservationReceiptUnionSchema, signal); }
  runReviews(runId: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<RunReviewDto>> { return this.get(`/runs/${encoded(runId)}/reviews${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(RunReviewSchema), signal); }
  saveRunReview(runId: string, input: RunReviewRequestDto, csrfToken: string): Promise<RunReviewDto> { return this.post(`/runs/${encoded(runId)}/reviews`, input, csrfToken, RunReviewSchema); }
  runReview(runId: string, reviewId: string, signal?: AbortSignal): Promise<RunReviewDto> { return this.get(`/runs/${encoded(runId)}/reviews/${encoded(reviewId)}`, RunReviewSchema, signal); }
  runDispositions(runId: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<RunDispositionRevisionDto>> { return this.get(`/runs/${encoded(runId)}/dispositions${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(RunDispositionRevisionSchema), signal); }
  saveRunDisposition(runId: string, input: RunDispositionRequestDto, csrfToken: string): Promise<RunDispositionRevisionDto> { return this.post(`/runs/${encoded(runId)}/dispositions`, input, csrfToken, RunDispositionRevisionSchema); }
  runDisposition(runId: string, dispositionId: string, signal?: AbortSignal): Promise<RunDispositionRevisionDto> { return this.get(`/runs/${encoded(runId)}/dispositions/${encoded(dispositionId)}`, RunDispositionRevisionSchema, signal); }
  assets(cursor?: string, search?: string, caseId?: string, signal?: AbortSignal): Promise<CursorList<AssetSummaryDto>> {
    const q = new URLSearchParams(); if (cursor) q.set('cursor', cursor); if (search) q.set('search', search); if (caseId) q.set('caseId', caseId);
    return this.get(`/assets${q.size ? `?${q}` : ''}`, listSchema(AssetSummarySchema), signal);
  }
  reading(id: string, signal?: AbortSignal): Promise<AssetReadingDto> { return this.get(`/assets/${encoded(id)}/reading`, AssetReadingSchema, signal); }
  assetAttachments(assetVersionId: string, signal?: AbortSignal): Promise<AssetAttachmentsDto> { return this.get(`/assets/${encoded(assetVersionId)}/attachments`, AssetAttachmentsSchema, signal); }
  async attachmentContent(assetVersionId: string, attachment: AttachmentDto, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(`${this.root}/assets/${encoded(assetVersionId)}/attachments/${encoded(attachment.id)}/content`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'application/octet-stream' } });
    if (!response.ok) {
      const error = ErrorSchema.safeParse(await response.json().catch(() => null));
      throw new SpaceApiError(error.success ? error.data.error.code : `HTTP_${response.status}`, error.success ? error.data.error.message : `附件读取失败 (${response.status})`, response.status);
    }
    if (response.headers.get('x-content-sha256') !== attachment.sha256) throw new Error('附件响应校验值与保存记录不一致。');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== attachment.size) throw new Error('附件响应字节数与保存记录不一致。');
    return response.arrayBuffer();
  }
  relations(id: string, cursor?: string, signal?: AbortSignal): Promise<AssetRelationsDto> { return this.get(`/assets/${encoded(id)}/relations${cursor ? `?cursor=${encoded(cursor)}` : ''}`, AssetRelationsSchema, signal); }
  plan(id: string, signal?: AbortSignal): Promise<PlanDetailDto> { return this.get(`/validation-plans/${encoded(id)}`, PlanDetailSchema, signal); }
  plans(cursor?: string, signal?: AbortSignal): Promise<CursorList<PlanSummaryDto>> { return this.get(`/validation-plans${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(PlanSummarySchema), signal); }
  planEntry(planId: string, entryId: string, signal?: AbortSignal): Promise<PlanEntryDto> { return this.get(`/validation-plans/${encoded(planId)}/entries/${encoded(entryId)}`, PlanEntrySchema, signal); }
  planAttempt(planId: string, entryId: string, attempt: number, signal?: AbortSignal): Promise<PlanAttemptDto> { return this.get(`/validation-plans/${encoded(planId)}/entries/${encoded(entryId)}/attempts/${attempt}`, PlanAttemptSchema, signal); }
  planComparisons(planId: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<PlanComparisonDto>> { return this.get(`/validation-plans/${encoded(planId)}/comparisons${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(PlanComparisonSchema), signal); }
  comparisonReading(planId: string, comparisonId: string, signal?: AbortSignal): Promise<ComparisonReadingDto> { return this.get(`/validation-plans/${encoded(planId)}/comparisons/${encoded(comparisonId)}/reading`, ComparisonReadingSchema, signal); }
  reviewReading(reviewId: string, signal?: AbortSignal): Promise<ReviewReadingDto> { return this.get(`/reviews/${encoded(reviewId)}`, ReviewReadingSchema, signal); }
  businessForm(signal?: AbortSignal): Promise<BusinessFormDto> { return this.get('/business/form', BusinessFormSchema, signal); }
  preparation(caseId: string, signal?: AbortSignal): Promise<BusinessPreparationDto> { return this.get(`/cases/${encoded(caseId)}/preparation`, BusinessPreparationSchema, signal); }
  prepareBusiness(versionId: string, values: Record<string, unknown>, key: string, csrfToken: string): Promise<BusinessPreparationDto> { return this.post('/business/preparations', { key, versionId, values }, csrfToken, BusinessPreparationSchema); }
  startBusiness(caseId: string, versionId: string, inputManifestId: string, key: string, csrfToken: string): Promise<BusinessCommandReceiptDto> { return this.post(`/cases/${encoded(caseId)}/runs`, { versionId, inputManifestId, key }, csrfToken, BusinessCommandReceiptSchema); }
  dispatchBusiness(caseId: string, runId: string, versionId: string, inputManifestId: string, csrfToken: string): Promise<BusinessCommandReceiptDto> { return this.post(`/cases/${encoded(caseId)}/runs/${encoded(runId)}/dispatch`, { versionId, inputManifestId }, csrfToken, BusinessCommandReceiptSchema); }
  handlingNotes(runId: string, assetId: string, signal?: AbortSignal): Promise<HandlingNoteListDto> { return this.get(`/runs/${encoded(runId)}/assets/${encoded(assetId)}/handling-notes`, HandlingNoteListSchema, signal); }
  addHandlingNote(runId: string, assetId: string, note: HandlingNoteRequestDto, csrfToken: string): Promise<HandlingNoteDto> { return this.post(`/runs/${encoded(runId)}/assets/${encoded(assetId)}/handling-notes`, note, csrfToken, HandlingNoteSchema); }
  planIssues(planId: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<PlanIssueDto>> { return this.get(`/validation-plans/${encoded(planId)}/issues${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(PlanIssueSchema), signal); }
  startPlanEntry(planId: string, entryId: string, attempt: number, inputManifestId: string, csrfToken: string): Promise<PlanCommandReceiptDto> {
    return this.post(`/validation-plans/${encoded(planId)}/entries/${encoded(entryId)}/attempts/${attempt}/start`, { inputManifestId }, csrfToken, PlanCommandReceiptSchema);
  }
  dispatchPlanRun(planId: string, entryId: string, attempt: number, runId: string, csrfToken: string): Promise<PlanCommandReceiptDto> {
    return this.post(`/validation-plans/${encoded(planId)}/entries/${encoded(entryId)}/attempts/${attempt}/runs/${encoded(runId)}/dispatch`, {}, csrfToken, PlanCommandReceiptSchema);
  }
}
