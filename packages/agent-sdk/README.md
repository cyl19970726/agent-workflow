# SIWC Responses runner

This optional package connects the shared workflow `AgentRunner` to OpenAI's public Responses API using an app-owned **Continue with ChatGPT** connection. It uses ChatGPT plan authorization only. It never reads Codex credentials, accepts a Platform API key, or silently falls back to API billing.

Build from the `vendor/agent-workflow` workspace, then run:

```sh
node packages/agent-sdk/dist/cli.js login
node packages/agent-sdk/dist/cli.js status
node packages/agent-sdk/dist/cli.js models
```

The `login` command starts an HTTP listener on `127.0.0.1`, opens OpenAI authorization in the system browser, verifies state, exchanges a PKCE code, validates the signed ID token and its identity, and saves credentials at `~/.config/creator-lab/workflow-siwc.json` with owner-only permissions. The user completes account selection and authorization in that browser. `logout` attempts to revoke the renewable session before removing local credentials and reports if remote revocation could not be confirmed. The saved connection supports one account; reconnecting verifies the same account identity. Credentials are never included in runner events or results.

```ts
const runner = new SiwcResponsesRunner({
  auth: new SiwcAuth(),
  tools: (request) => bindRestrictedToolsForAttempt(request),
  maxTurns: 8,
  maxToolCalls: 16,
});
```

`AgentDefinition.config.instructions` supplies the developer instructions; `outputFormat` may be `text` or `json`. The input is a string or JSON value. Tools must be injected by the host for each attempt; model output cannot register tools. Tool calls and results are recorded with their parsed arguments/output, call IDs and content hashes. Visible completed messages and function calls, plus text deltas, are emitted as observable events; opaque reasoning items are excluded. The host should bind tools to its node-scoped asset client and persist events in its restricted trace store with appropriate secret redaction and access controls. Tool output is returned to the model. A call fails if authorization is absent, the stream is incomplete, or tool/turn limits are reached. The runner uses `store:false`, `stream:true`, and sends full in-run history with every turn.

This is a SIWC **Responses adapter**, not an OpenAI Agents SDK integration. The current SIWC preview route has unsupported request fields and tool types, and the OpenAI devkit `@siwc/local` shown in the cookbook was not published to npm when this package was built. An authorized local account completed a bounded live `gpt-6-astra` producer and independent reviewer probe on 2026-10-04, including bound tool reads and durable outputs. This verifies that account and route, not creative quality or eligibility for every account; see the [Space integration guide](../../docs/space-storage.md). No model request is made by the deterministic tests.

Official references: [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
