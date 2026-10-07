import {
  AssetReadingSchema, AssetRelationsSchema, AssetSummarySchema, CaseSummarySchema, ErrorSchema,
  NodeDetailSchema, OccurrenceDetailSchema, PlanDetailSchema, ProcessSchema, RunDetailSchema,
  RunSummarySchema, SummarySchema, VersionDetailSchema, VersionSummarySchema, PlanSummarySchema,
  PlanEntrySchema, PlanAttemptSchema, PlanComparisonSchema, PlanIssueSchema, PlanCommandReceiptSchema,
  ComparisonReadingSchema, ReviewReadingSchema,
  BusinessFormSchema, BusinessPreparationSchema, BusinessCommandReceiptSchema, HandlingNoteSchema, HandlingNoteListSchema,
  IterationSchema,
  listSchema, parseDto,
  type AssetReadingDto, type AssetRelationsDto, type AssetSummaryDto, type CaseSummaryDto,
  type CursorList, type NodeDetailDto, type OccurrenceDetailDto, type PlanDetailDto,
  type ProcessDto, type RunDetailDto, type RunSummaryDto, type SpaceSummaryDto,
  type PlanSummaryDto, type PlanEntryDto, type PlanAttemptDto, type PlanComparisonDto,
  type PlanIssueDto, type PlanCommandReceiptDto,
  type ComparisonReadingDto, type ReviewReadingDto,
  type BusinessFormDto, type BusinessPreparationDto, type BusinessCommandReceiptDto, type HandlingNoteDto, type HandlingNoteRequestDto, type HandlingNoteListDto,
  type IterationDto,
  type VersionDetailDto, type VersionSummaryDto,
} from '@signal-room/workflow-space-api/contracts';
import type { z } from 'zod';

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
  versions(cursor?: string, signal?: AbortSignal): Promise<CursorList<VersionSummaryDto>> { return this.get(`/versions${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(VersionSummarySchema), signal); }
  version(id: string, signal?: AbortSignal): Promise<VersionDetailDto> { return this.get(`/versions/${encoded(id)}`, VersionDetailSchema, signal); }
  versionCases(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<CaseSummaryDto>> { return this.get(`/versions/${encoded(id)}/cases${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(CaseSummarySchema), signal); }
  versionIterations(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<IterationDto>> { return this.get(`/versions/${encoded(id)}/iterations${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(IterationSchema), signal); }
  node(versionId: string, nodeId: string, signal?: AbortSignal): Promise<NodeDetailDto> { return this.get(`/versions/${encoded(versionId)}/nodes/${encoded(nodeId)}`, NodeDetailSchema, signal); }
  cases(cursor?: string, signal?: AbortSignal): Promise<CursorList<CaseSummaryDto>> { return this.get(`/cases${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(CaseSummarySchema), signal); }
  case(id: string, signal?: AbortSignal): Promise<CaseSummaryDto> { return this.get(`/cases/${encoded(id)}`, CaseSummarySchema, signal); }
  caseRuns(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorList<RunSummaryDto>> { return this.get(`/cases/${encoded(id)}/runs${cursor ? `?cursor=${encoded(cursor)}` : ''}`, listSchema(RunSummarySchema), signal); }
  run(id: string, signal?: AbortSignal): Promise<RunDetailDto> { return this.get(`/runs/${encoded(id)}`, RunDetailSchema, signal); }
  process(id: string, signal?: AbortSignal): Promise<ProcessDto> { return this.get(`/runs/${encoded(id)}/process`, ProcessSchema, signal); }
  occurrence(runId: string, occurrenceId: string, signal?: AbortSignal): Promise<OccurrenceDetailDto> { return this.get(`/runs/${encoded(runId)}/occurrences/${encoded(occurrenceId)}`, OccurrenceDetailSchema, signal); }
  assets(cursor?: string, search?: string, caseId?: string, signal?: AbortSignal): Promise<CursorList<AssetSummaryDto>> {
    const q = new URLSearchParams(); if (cursor) q.set('cursor', cursor); if (search) q.set('search', search); if (caseId) q.set('caseId', caseId);
    return this.get(`/assets${q.size ? `?${q}` : ''}`, listSchema(AssetSummarySchema), signal);
  }
  reading(id: string, signal?: AbortSignal): Promise<AssetReadingDto> { return this.get(`/assets/${encoded(id)}/reading`, AssetReadingSchema, signal); }
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
