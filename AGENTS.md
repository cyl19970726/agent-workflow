# Agent workflow

Reusable execution infrastructure extracted from self-media. Keep domain workflows, research skills, UI, and job queues in consumers. Core must not import Codex, SQLite, or a consumer repository. Inject filesystem/runtime configuration into adapters. Preserve persisted run/step/artifact formats and replay fingerprints unless a documented migration is provided.

Run `npm ci`, `npm run verify`, and `npm run example` before releasing. Changes are shared across projects: commit and push this repository first, then explicitly update each consumer's submodule pointer. Do not install global skills or include runtime traces, credentials, databases, or research assets.

For workflow authoring, use the guides in docs/ and the runnable examples in examples/. Keep documentation aligned with the checked-out API.
