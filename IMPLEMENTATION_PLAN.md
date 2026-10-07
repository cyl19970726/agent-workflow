# Workflow Space storage — 2026-10-04

The user clarified the primary unit: a Workflow Space persists one business purpose, its workflow versions and iterations; the asset console is scoped to that space. Storage must support cross-stage asset collaboration, sessions, knowledge, provenance, version control and evaluation. `docs/workflow-spaces.md` is the domain design; `docs/postgres-sdk-plan.md` contains infrastructure details. Codex environment isolation and VM orchestration do not block this work.

## Current priority

- [x] Recover actual creation asset families and historical failure evidence; distinguish observed issues from design recommendations.
- [x] Document space ownership, workflow versions/entrypoints, cases, frozen contexts, asset versions and handoffs, session/knowledge history, reviews and iteration relationships.
- [x] Align shared product, architecture and roadmap with the user's clarified scope.
- [x] Clarify fixed system schemas vs workflow-defined asset payload schemas; diagram schema registration, workflow storage contracts, node capabilities and console reads using actual CONTENT / brief / B3 examples.
- [x] Implement schema registration/version pinning and workflow storage contracts, including field projections and service-enforced node operations, before treating arbitrary payload persistence as domain storage.
- [x] Implement the space domain contracts and PostgreSQL relations, including pre-run imports and role-scoped context access.
- [x] Connect node clients/harness and a subscription Responses runner to these contracts, then verify two workflow versions inside one space with exact outputs, history and independent reviews. General Agents SDK integration remains separate.

Do not treat the execution-ledger prototype below as completion of the product storage layer. No further generic store expansion should displace the space domain work.

## Deliverables

- [x] Add an optional core atomic step-result commit contract while preserving existing Memory/SQLite replay and APIs.
- [x] Add a technically workspace-scoped PostgreSQL RunStore with actual artifact payloads, verified reads, provenance checks and per-run event sequencing.
- [x] Commit publication, step/attempt completion and completion events together; repeated commits are idempotent and conflicting commits fail.
- [x] Provide a runnable database-backed example and workspace build wiring.
- [x] Verify with a dedicated real PostgreSQL instance, concurrent writes, rollback, re-open/read, and relevant legacy/core checks.

## Acceptance and limits

The example must persist real text/JSON data and run/step/attempt/event relationships, then read and verify them using a fresh database connection. Failed publication must leave no half-published result. No real model call is required for this storage milestone, and deterministic example output must never be presented as model-generated content.

This milestone does not claim the complete harness or production service exists: SDK/provider authentication, configuration/session services, durable detailed Agent trace collection, worker leases, object storage, review UI and actual creation quality validation remain separate work. PostgreSQL is a new explicit adapter; existing consumers are not forcibly migrated. No credential, private runtime data, trace, database or generated artifact is committed.

## Earlier execution-ledger milestone validation

- Node 24: consumer `pnpm build:workflow` passed.
- Node 24: isolated standalone npm installation of the checked-out shared sources passed build, example type checks, examples and 85 tests across 10 files, including 6 real PostgreSQL tests. Core has 28 runtime tests.
- PostgreSQL 17 dedicated fixture: example persisted/read payload after reconnect and replayed without new task execution; 11 events, zero model calls. The fixture server was stopped after verification.
- Consumer pnpm test invocation retains two previously documented installation-layout failures (Codex SDK version discovery and read-model SQLite package resolution). Standalone installation passes; this milestone did not change those unrelated paths.
- After the domain design updates, shared documentation link checking passed for 19 Markdown files, the consumer site built 50 pages, the new design page returned HTTP 200, and both repositories passed `git diff --check`.
- No SDK execution, object storage deployment, space-domain implementation or real creative-quality acceptance is claimed.

## Active implementation — space domain (2026-10-04)

This section supersedes the earlier “not implemented” status above while preserving the previous milestone evidence.

- [x] `space-contracts`: persisted JSON Schema 2020-12 definitions, hash-verified dependency closure, immutable workflow storage contracts, distinct Agent/persistent output validation, projections and actor/state rules.
- [x] `spaces`: PostgreSQL space/member/version/case/manifest relations, pre-run imports, immutable asset versions, CAS updates, managed blob byte integrity, sessions/context/message cursors, sourced knowledge, reviews/comparisons/iterations/adoption.
- [x] Node-bound client: exact slot reads, cold-reader projection, server-supplied provenance, atomic domain output + ledger completion and idempotent reconciliation.
- [x] Sixteen real PostgreSQL domain tests pass alongside six existing ledger tests. Independent schema and console tests pass. These are deterministic storage evidence, not model/creative quality evidence.
- [x] Generic read-only Space console: precise version bodies and side-by-side comparisons, sessions, knowledge and review history from the same service.
- [x] App-owned SIWC OAuth and bounded Responses runner with offline protocol checks and successful live subscription producer/independent-reviewer probes on synthetic material. This is not a verified OpenAI Agents SDK integration or creative-quality acceptance.
- [x] Integrate existing `runWorkflow`/creation CONTENT execution through the shared harness (preserve real stage orchestration). A real-PG regression covers external prior feedback plus internal rewrite with repeated reviewer outputs, resolving provenance by phase/round.
- [x] Complete and verify deterministic creation CONTENT → synthetic human acceptance → brief → independent B3 fixture asset → feedback/v2 comparison. The fixture stores actual source bytes; it does not claim a model, renderer or real creator approval.
- [x] Complete failure/recovery, runtime integration and consumer validation; update public status documentation and links.

## Final validation — Space storage slice

- Node 24 shared `npm run verify` from an isolated installation: 123 tests in 16 files, including 16 PostgreSQL Space tests and 6 PostgreSQL ledger tests; build, documentation links, example type checks and offline examples passed.
- Consumer `pnpm build:workflow` and all three workbench builds passed. Research's 35 tests and analysis's 640 tests passed with no changes in either workbench. Creation's final full suite passed 124 tests in 18 files, including the PostgreSQL rewrite regression with external feedback and identical independent-reviewer payloads in separate rounds.
- App-owned official ChatGPT subscription authorization completed. Two bounded `gpt-6-astra` roles independently produced and reviewed synthetic material, recording actual bound reads, observable messages/tool traces and raw review answers. No Codex credential copying or Platform API billing fallback was used.
- The deterministic creation demo completed two workflow versions, an accepted-brief handoff, a separate B3 fixture, actual managed attachment bytes, feedback/reviews, comparison, iteration and sourced knowledge. Synthetic human decisions are explicitly labeled; B3 build/render checks are explicitly recorded as not run.
- The dedicated PostgreSQL server was actually stopped and restarted. A fresh process in an empty working directory read the live probe and creation demo back with identical hashes: 21 asset versions, 27 sessions/contexts, 3 reviews, a comparison, sourced knowledge and an attachment. An ignored local database backup was retained.
- The read-only console was visually checked for exact-version comparison and the creation reader. The documentation site builds 51 pages with checked internal links. No commit or push was performed.
- The known pnpm source-layout failures for Codex SDK version discovery and read-model SQLite package resolution remain distinct from the passing standalone shared verification. General Agents SDK integration, production authorization/deployment, a cloud BlobStore, native SDK session resume and real creative/full-media acceptance remain outside the completed slice.

Acceptance remains the business-space closure in `docs/workflow-spaces.md`. Do not mark live model quality, cloud object storage, full B3 rendering, production authorization/worker deployment or native resume complete based on offline fixtures. No automatic commit/push is authorized.
