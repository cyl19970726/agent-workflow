# OpenAI Agents SDK runner with SIWC Responses transport

`OpenAIAgentsSdkRunner` adapts the workflow `AgentRunner` port to the official `@openai/agents` SDK (pinned here to `0.20.0`). The SDK `Agent` and `Runner.run` own the agent turn loop, tool dispatch, and conversation history. A custom SDK `Model` sends each model request to the OpenAI Responses endpoint using the app-owned **Continue with ChatGPT** authorization. SIWC is the authorization and model-transport path; it is not a replacement agent loop.

This is a deliberately bounded integration: it implements the workflow runner surface and the SIWC-compatible subset of the SDK model protocol. It does not claim support for every Agents SDK feature, provider, deployment mode, or native session-resume capability. The runner disables SDK cloud tracing because workflow events are persisted by the host; it does not enable a second remote trace exporter.

The SIWC route uses ChatGPT plan authorization only. It never reads Codex credentials, accepts a Platform API key, or silently falls back to API billing. The app-owned login flow stores the renewable connection at `~/.config/creator-lab/workflow-siwc.json` with owner-only permissions. `login`, `status`, `models`, and `logout` are available through the package CLI:

Each Responses POST obtains the current SIWC access token immediately before sending, so a long tool loop can cross a token expiry safely. If a Responses POST returns HTTP 401, the runner attempts one locked SIWC refresh and retries that POST once; concurrent processes reuse a token already rotated by another process. The durable trace records sanitized `siwc.provider_error` status/request IDs and `siwc.auth_refreshed` reason/attempt metadata, never bearer values or response bodies. If refresh or the retry fails, inspect the connection with `workflow-siwc status` and sign in again with `workflow-siwc login` when needed. The runner never switches to API-key or API billing authorization.

```sh
node packages/agent-sdk/dist/cli.js login
node packages/agent-sdk/dist/cli.js status
node packages/agent-sdk/dist/cli.js models
```

Construct the runner with the host's authenticated SIWC connection and attempt-bound tools:

```ts
const runner = new OpenAIAgentsSdkRunner({
  auth: new SiwcAuth(),
  tools: (request) => bindRestrictedToolsForAttempt(request),
  timeoutMs: 180_000,
  validateOutput: (value) => mySchema.parse(value),
  maxTurns: 8,
  maxToolCalls: 16,
});
```

The runner maps workflow instructions, model, reasoning effort, text/JSON output and input into an SDK `Agent` and invokes `Runner.run`. The host injects tool implementations for each attempt; model output cannot register tools. Tool calls are dispatched by the SDK and remain bound to the host's node-scoped capabilities. Tool calls/results, visible completed messages, text deltas, and safe provider error identifiers are emitted as `siwc.*` workflow events. Event metadata records `runtime: "openai-agents-sdk"`, `sdkPackage: "@openai/agents"`, and `sdkVersion: "0.20.0"`; the host remains responsible for durable storage, redaction, access controls, evidence binding, domain schemas, and quality gates. The host's final `validateOutput` runs after the SDK returns its final output.

JSON output is parsed by the adapter. Hosts that require a top-level object can opt into Responses JSON object mode with `enforceJsonObject: true`; each model turn then sends `text.format: { type: "json_object" }` and an explicit JSON requirement in developer input. The default remains compatible with top-level arrays and text output. Hosts may also opt into bounded same-conversation technical corrections with `maxOutputValidationCorrections` (0 by default, maximum 3) and `outputValidationFeedback`. Corrections use the SDK result history and consume the same turn, tool-call, and timeout budgets. They do not relax domain validation or let the host rewrite model output.

For vision, the host can supply `images: (request) => SiwcImage[]` at the initial user turn or return a `SiwcVisualToolResult` from a bound tool. The custom model transport sends actual image bytes as Responses `input_image` data URLs; a path or OCR string alone does not give the model visual access. Events retain MIME types and image hashes, not base64 pixels. `timeoutMs` bounds when `run()` returns and composes with the workflow abort signal. It cannot forcibly stop host callbacks that ignore cancellation; their side effects must be cancellation-safe, and late callback results are ignored by the runner.

The former `SiwcResponsesRunner` compatibility name has been removed. Consumers must use `OpenAIAgentsSdkRunner`. Existing event names beginning `siwc.` and PostgreSQL trace records are retained for persisted-run compatibility; new start/request events add the runtime and SDK identity metadata. `tracingDisabled: true` is deliberate: the existing restricted PostgreSQL workflow trace remains the record, with no implicit cloud SDK trace export.

Official references: [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/), [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
