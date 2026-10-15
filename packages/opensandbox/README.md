# OpenSandbox Agent runners

The primary path runs the complete Codex CLI or OpenAI Agents SDK loop inside a pinned OpenSandbox image. `createOpenSandboxEnvironment` creates one outer-owned sandbox and provisions native Credential Vault bindings; `createContainerAgentRunner` connects each Agent attempt to that same environment. Set `runtime: "codex-cli"` or `runtime: "agents-sdk"` explicitly. The adapter never falls back to a host Agent runtime.

For full integration, image-build commands, environment variables, security limits, and PR #9 historical evidence, see [the OpenSandbox guide](../../docs/opensandbox.md) and [the shared example](../../examples/opensandbox-shared.ts).

## Choose an example

| Example | Runtime placement and purpose |
| --- | --- |
| [opensandbox-shared.ts](../../examples/opensandbox-shared.ts) | Start here: complete Codex CLI and Agents SDK nodes share one sandbox; native Vault, host byte validation, PG artifacts and completed replay |
| [opensandbox-smoke.mjs](../../examples/opensandbox-smoke.mjs) | Legacy tool-adapter wiring with fake execution; no service or model |
| [opensandbox-live.mjs](../../examples/opensandbox-live.mjs) | Legacy adapter's real container file/command checks; no model or database |
| [opensandbox-csv.ts](../../examples/opensandbox-csv.ts) | Legacy host Agents SDK loop with container Python tools, PG and replay |

The legacy examples use `OPEN_SANDBOX_IMAGE_DIGEST` and a `python` executable. The new shared example uses `OPEN_SANDBOX_AGENT_IMAGE`, which must contain the fixed worker, Codex CLI and Agents SDK. Their images and environment variables are not interchangeable. See the guide for exact prerequisites and expected results. The default checks do not run either live model example.

## Shared environment lifecycle

Create an environment from host-selected immutable profile settings and credential bindings. Credential values are supplied only by an in-memory callback and provisioned through the native Vault; do not put them in the job, prompt, image, or workspace files.

```ts
const environment = await createOpenSandboxEnvironment({ connection, profile, credentials });
const policy = { runtime: "codex-cli", limits } satisfies ContainerAgentPolicy;
try {
  const runner = createContainerAgentRunner({ environment, policy, prepare, finish });
  const outcome = await runWorkflow({
    workflow,
    input,
    store,
    agentRunner: runner,
    metadata: { openSandboxEnvironment: environment.binding },
  });
  return outcome;
} finally {
  const cleanup = await environment.dispose();
  // Persist/inspect cleanup status in the outer workflow owner.
}
```

The `runMetadata.openSandboxEnvironment` binding must match the owner on every node use. It binds the sandbox ID and environment profile digest to one run, preventing partial resume from combining an old upstream replay with a newly created empty environment. Nodes share `/work/shared` serially. A failed, canceled, or uncertain node invalidates the owner; do not continue another node against possibly changed shared state. The outer workflow remains responsible for calling `dispose()` in all exit paths.

`prepare` materializes exact input bytes and `finish` reads and validates actual container output. Keep durable publication outside these callbacks; publish only after the host accepts the returned result. Put environment lifetime and fingerprint-relevant policy in the existing workflow/Agent config path; this adapter does not alter core fingerprint format or add a persistent recovery table.

## Image build and execution

From the repository root, `npm run build:opensandbox-image` uses the script's digest-pinned ARM64 Node 24 base, installs Python 3 and Codex CLI `0.154.0`, and writes a local Docker image. The command prints an image ID and `localImageReference`; use that exact local reference as `OPEN_SANDBOX_AGENT_IMAGE` only when the OpenSandbox Docker server can access the same Docker daemon. The script does not push to a registry. For a remote server, publish to a trusted registry and configure the resulting immutable registry digest.

For another architecture or a different Debian-compatible Node 24 base, provide that architecture's digest-pinned base explicitly:

```bash
npm run build:opensandbox-image -- --base docker.io/library/node@sha256:<64-hex-digest> --tag local/workflow-container-agent:custom
```

The opt-in integration example requires `OPEN_SANDBOX_DOMAIN`, `OPEN_SANDBOX_PROTOCOL`, `OPEN_SANDBOX_API_KEY`, `OPEN_SANDBOX_AGENT_IMAGE`, `WORKFLOW_DATABASE_URL`, and `SIWC_MODEL`. Its credential callback reads an existing authorized Codex ChatGPT login (`CODEX_AUTH_FILE` or `~/.codex/auth.json`) and the configured Agents SDK authorization, then creates narrow Vault routes. Run it explicitly with a private, uncommitted env file:

```bash
node --env-file=/absolute/path/to/private.env examples/opensandbox-shared.ts
```

The package's deterministic tests and `example:opensandbox-smoke` do not call models or create remote sandboxes. They are not evidence that a live server, model authorization, or in-container runtime has passed an actual test.

## Legacy host-loop adapter

`createOpenSandboxAgentRunner` is retained for explicit migration compatibility with the earlier PR #9 path. That runner keeps the Agents SDK loop and model authorization on the host and dispatches only registered workspace tools to an OpenSandbox sandbox. It is not the new primary execution path and does not establish that a full Agent loop runs in the container. Never select it silently when the in-container runner fails.

The older one-sandbox-per-attempt tool adapter enforces lexical workspace path checks, but model-written code remains arbitrary code inside a Docker container. Symlinks can reach other container paths; uploaded files are not OS-level read-only. Docker shares the host kernel. Production Space recovery, durable environment leases, worker restart reconciliation, claim fencing, atomic publication, and long-term orphan collection remain out of scope.
