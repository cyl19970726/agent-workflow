# Workflow read model

For the complete transport, cursor, relation, and browser integration guide, see [Frontend integration](../../docs/frontend-integration.md). Run `node examples/read-model-web.mjs` after building to open a no-model browser example.

`@signal-room/workflow-read-model` projects a root run and its actual descendants into browser-safe run, phase, call, attempt, and artifact records. Import DTO types from `@signal-room/workflow-read-model/contracts`; import `createWorkflowReadService` on the server only. Authorize the viewer and the requested root before calling the service.

```ts
const reading = createWorkflowReadService({ store, adapters: {
  title: (kind, id, step) => safeTitles.get(id),
  purpose: step => safePurposes.get(step.id),
  error: (attemptId, rawError) => safeErrorSummaries.get(attemptId),
  readerUrl: artifact => authorizedReaderUrl(artifact),
  relations: async artifact => validatedDomainRelations(artifact),
  phaseFacts: async phase => validatedDomainPhaseFacts(phase),
  plan: root => ({ planned: undefined, closed: false }),
} });
const snapshot = await reading.getSnapshot({ rootRunId });
const update = await reading.getChanges({ rootRunId, cursor: snapshot.cursor });
```

The host owns authentication, access checks, business verification, and safe string callbacks. The service never sends raw run metadata, step outputs, errors, event data, artifact payloads, or storage URIs to the browser. Relation adapters must provide exact `{id, revision, sha256}` endpoints; the service marks missing or mismatched references and does not select the newest candidate. Direction is `review -> candidate` for `reviews`, `new candidate -> old candidate` for `revises` or `supersedes`, and `selection evidence -> chosen candidate` for `selected`. A `read-model.retry` event on the new step with `{retryOf: previousStepId, reason: rawReason}` records an explicit retry; `reason` is exposed only through the safe error callback. Old records without this event keep retry unknown.

An API may return the snapshot directly, then poll `getChanges` or push its response through SSE. `resetRequired` means the cursor expired or belongs to another root; fetch a fresh snapshot. Every changed response contains upsertable records, current progress, and the complete relation set (including removals). Stage IDs are unique control step IDs; `phaseKey` is the workflow definition key. `getStageDetails({rootRunId, phaseId: stage.id, cursor})` pages the call list. A host may choose a child run as its root for a narrower authorized view. A phase's absent plan total remains unknown; `required` expected artifacts report missing bindings without changing execution state.

Run `node examples/read-model.mjs` after `npm run build` for a no-model Reviewer failure, retry, and accepted receipt. The example asserts that private artifact locations stay out of the DTO.
