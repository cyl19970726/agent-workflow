# Agent Workflow

Composable, resumable TypeScript workflows with named parallel branches, reader-facing phases, immutable artifact references, and an optional Codex SDK runner and SQLite ledger.

Extracted from self-media commit `c460d1cd2f6c5fb41585a5cf9ab701332ef979e8`. Research workflows, method skills, application UI, and job queues remain in the consuming project. This repository is execution infrastructure, not a new job scheduler.

## Packages

| Package | Responsibility |
| --- | --- |
| `@signal-room/workflow` | Provider-independent contracts, runtime, replay, phases, parallel branches, and in-memory store |
| `@signal-room/workflow-codex` | Codex SDK invocation, frozen skill snapshots, per-attempt private traces, and explicit model configuration |
| `@signal-room/workflow-sqlite` | Persistent execution records and artifacts using Node's SQLite API |

Node >=22.5 is required. The packages export built JavaScript and declarations. No global skill installation or credentials are needed for tests or the example.

```sh
npm ci
npm run verify
npm run example
```

See [core semantics](packages/core/README.md) and the [standalone example](examples/document-check.mjs).

## Consume as a Git submodule

```sh
git submodule add https://github.com/cyl19970726/agent-workflow.git vendor/agent-workflow
```

Include `vendor/agent-workflow/packages/*` in the consumer's npm workspaces and depend on the public packages at `0.1.0`. Build core, codex, then sqlite after installation and after source edits. Import package names, never paths into `vendor` or package internals.

```ts
import { workflow, runWorkflow } from '@signal-room/workflow';
import { CodexSdkRunner } from '@signal-room/workflow-codex';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
```

Use `@signal-room/workflow/contracts` for browser-safe contracts. The shared SDK runner accepts a factory, trace root, and optional runtime version lookup configuration (`packageRoot`, `cliBinary`). Inject project-specific paths and environment policy in your application. Never serve the raw trace directory publicly.

## Editing and upgrading shared source

The consumer records an exact commit. A change in one project does not silently update another project.

1. In the submodule, create a named branch before editing (fresh submodules may have detached HEAD).
2. Change source, run this repository's verification and the consumer's integration tests.
3. Commit and push this repository first.
4. Commit and push the consumer's updated submodule pointer.
5. In another consumer, fetch and explicitly select the desired commit, rebuild, test, and commit its pointer.

For a fresh consumer checkout, use `git clone --recurse-submodules` or `git submodule update --init --recursive`. Use the latter again after switching consumer branches. Do not configure automatic branch-following upgrades.

## Compatibility

`0.1.0` retains the original persisted run/step/attempt/artifact/event documents and tables. A compatibility fixture verifies old validated agent outputs are reused without invoking an agent again. Business metadata remains stored unchanged; query it through `listRuns({ metadata: { creatorRunId: '...' } })` rather than a domain-specific core field. Existing domain indexes can remain in an existing database.

Workflow replay depends on stable workflow revisions, node keys, and input/configuration fingerprints. Changing workflow implementations requires an explicit workflow revision change. A library release must document serialized-format changes and migration requirements; do not silently rewrite stored records. Cancellation propagation and durable queue dispatch remain the host's responsibilities. Replay is not an exactly-once guarantee for arbitrary external side effects.
