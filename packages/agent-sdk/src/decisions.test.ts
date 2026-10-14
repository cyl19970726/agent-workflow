import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { DecisionProtocolError, MemoryRunStore, runWorkflow, workflow, type DecisionRunRequest } from "@signal-room/workflow";
import { DecisionsRequestError, OpenAIDecisionsRunner } from "./decisions.js";

function request(overrides: Partial<DecisionRunRequest> = {}) {
  const events: { type: string; data: unknown }[] = [];
  const base: DecisionRunRequest = {
    runId: "run", stepRunId: "step", attemptId: "attempt", idempotencyKey: "local-key",
    definition: { id: "check", revision: "v1", provider: "openai", model: "gpt-6-luna", timeoutMs: 1234,
      questions: [{ type: "predicate", name: "visible", instructions: "Is the object visible?" }] },
    input: { text: "original evidence" }, signal: new AbortController().signal,
    emit: async (type, data) => { events.push({ type, data }); }
  };
  return { value: { ...base, ...overrides }, events };
}

function client(fetch: typeof globalThis.fetch) {
  return new OpenAI({ apiKey: "test-only-key", fetch, maxRetries: 2, timeout: 600_000 });
}

function response(answers: unknown[], status = 200, headers: Record<string, string> = {}) {
  return Response.json({ model: "gpt-6-luna", answers,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: {}, output_tokens_details: {} } },
  { status, headers: { "x-request-id": "req_42", ...headers } });
}

describe("OpenAIDecisionsRunner", () => {
  it("uses the official Decisions endpoint, preserves question/input text and typed answers, with retries disabled", async () => {
    const calls: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), init: init ?? {} });
      return response([
        { type: "predicate", name: "visible", probability: 0.8 },
        { type: "choice", name: "flag", choice: true, confidence: 0.9,
          probabilities: [{ value: true, probability: 0.9 }, { value: "true", probability: 0.1 }] },
        { type: "score", name: "quality", score: 0.7, confidence: 0.7,
          probabilities: [{ label: "bad", value: 0, probability: 0.3 },
            { label: "good", value: 1, probability: 0.7 }] }
      ]);
    }) as typeof globalThis.fetch;
    const { value, events } = request({ definition: { id: "check", revision: "v1", provider: "openai", model: "gpt-6-luna",
      timeoutMs: 1234, questions: [
        { type: "predicate", name: "visible", instructions: "Is the object visible?" },
        { type: "choice", name: "flag", instructions: "Choose a flag", choices: [{ value: true }, { value: "true" }] },
        { type: "score", name: "quality", instructions: "Score quality", levels: [{ label: "bad" }, { label: "good" }] }
      ] }, input: { text: "original evidence", evidenceRefs: [], images: [
        { dataUrl: "data:image/png;base64,YQ==", sha256: "hash", label: "local frame", detail: "high" }
      ] } });
    const result = await new OpenAIDecisionsRunner({ client: client(fetch) }).run(value);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/decisions");
    expect(calls[0]!.body).toEqual({ model: "gpt-6-luna", input: [{ role: "user", content: [
      { type: "input_text", text: "original evidence" },
      { type: "input_text", text: "local frame" },
      { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" }
    ] }], questions: [
      { type: "predicate", name: "visible", instructions: "Is the object visible?" },
      { type: "choice", name: "flag", instructions: "Choose a flag", choices: [{ value: true }, { value: "true" }] },
      { type: "score", name: "quality", instructions: "Score quality", levels: [{ label: "bad" }, { label: "good" }] }
    ] });
    expect(result.answers[1]).toMatchObject({ type: "choice", choice: true,
      probabilities: [{ value: true }, { value: "true" }] });
    expect(result).toMatchObject({ provider: "openai", model: "gpt-6-luna", requestId: "req_42",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(events[0]).toMatchObject({ type: "decision.inference.response", data: { requestId: "req_42", usage: result.usage } });
    expect(JSON.stringify(events)).not.toContain("original evidence");
  });

  it("preserves a refusal as an answer", async () => {
    const fetch = vi.fn(async () => response([{ type: "refusal", name: "visible" }])) as typeof globalThis.fetch;
    const { value } = request();
    expect((await new OpenAIDecisionsRunner({ client: client(fetch) }).run(value)).answers).toEqual([{ type: "refusal", name: "visible" }]);
  });

  it("fails a malformed provider distribution through core without another paid request", async () => {
    const fetch = vi.fn(async () => response([{ type: "choice", name: "category", choice: "a",
      confidence: 0.7, probabilities: null }])) as typeof globalThis.fetch;
    const definition = { id: "category", revision: "v1", provider: "openai", model: "gpt-6-luna",
      timeoutMs: 1234, maxRetries: 3, questions: [{ type: "choice" as const, name: "category",
        instructions: "Select a category", choices: [{ value: "a" }, { value: "b" }] }] };
    const flow = workflow("malformed-decision-response", { revision: "1" },
      (ctx) => ctx.decision("category", definition, { text: "Evidence" }));
    const store = new MemoryRunStore();
    const runner = new OpenAIDecisionsRunner({ client: client(fetch) });
    await expect(runWorkflow({ workflow: flow, input: null, store,
      agentRunner: { run: async () => { throw new Error("Unexpected agent call"); } }, decisionRunner: runner }))
      .rejects.toBeInstanceOf(DecisionProtocolError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.events.some((event) => event.type === "decision.inference.retrying")).toBe(false);
    expect(JSON.stringify(store.events)).not.toContain("null probability body");
  });

  it("passes cancellation and a bounded timeout into the SDK", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret body")), { once: true });
        queueMicrotask(() => controller.abort());
      });
    }) as typeof globalThis.fetch;
    const { value, events } = request({ signal: controller.signal });
    await expect(new OpenAIDecisionsRunner({ client: client(fetch) }).run(value)).rejects.toBeInstanceOf(DecisionsRequestError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain("secret body");
  });

  it("enforces the definition timeout instead of the client default", async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timeout body")), { once: true });
    })) as typeof globalThis.fetch;
    const { value, events } = request({ definition: { id: "check", revision: "v1", provider: "openai",
      model: "gpt-6-luna", timeoutMs: 20, questions: [{ type: "predicate", name: "visible", instructions: "Visible?" }] } });
    await expect(new OpenAIDecisionsRunner({ client: client(fetch) }).run(value)).rejects.toBeInstanceOf(DecisionsRequestError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain("timeout body");
  });

  it("does not retry HTTP errors and redacts response bodies, headers and unsafe request IDs", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { message: "secret body", type: "secret-type" } },
      { status: 429, headers: { "x-request-id": "sk-secret" } })) as typeof globalThis.fetch;
    const { value, events } = request({ definition: { id: "check", revision: "v1", provider: "openai",
      model: "gpt-6-luna", timeoutMs: 1234, maxRetries: 3,
      questions: [{ type: "predicate", name: "visible", instructions: "Is the object visible?" }] } });
    const failure = await new OpenAIDecisionsRunner({ client: client(fetch) }).run(value).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DecisionsRequestError);
    expect(failure).toMatchObject({ status: 429, requestId: undefined });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify({ failure: String(failure), events })).not.toMatch(/secret body|secret-type|sk-secret|test-only-key/);
    expect(events[0]).toMatchObject({ type: "decision.inference.error", data: { status: 429, errorType: "RateLimitError" } });
  });

  it("rejects incompatible provider/model and non-inline images before a request", async () => {
    const fetch = vi.fn(async () => response([])) as typeof globalThis.fetch;
    const runner = new OpenAIDecisionsRunner({ client: client(fetch) });
    const { value } = request();
    await expect(runner.run({ ...value, definition: { ...value.definition, model: "gpt-6-sol" } })).rejects.toThrow(/gpt-6-luna/);
    await expect(runner.run({ ...value, definition: { ...value.definition, provider: "siwc" } })).rejects.toThrow(/provider openai/);
    await expect(runner.run({ ...value, input: { text: "x", images: [{ dataUrl: "file:///private/frame.png", sha256: "hash" }] } }))
      .rejects.toThrow(/inline base64/);
    await expect(runner.run({ ...value, input: { text: "x", images: [
      { dataUrl: "data:image/png;base64,YQ==", sha256: "hash", detail: "original" as "high" }
    ] } })).rejects.toThrow(/inline base64/);
    await expect(runner.run({ ...value, definition: { ...value.definition, questions: [
      { type: "predicate", name: "same", instructions: "One" },
      { type: "predicate", name: "same", instructions: "Two" }
    ] } })).rejects.toThrow(/unique/);
    await expect(runner.run({ ...value, definition: { ...value.definition, questions: [
      { type: "choice", name: "one", instructions: "Choose", choices: [{ value: "only" }] }
    ] } })).rejects.toThrow(/2 to 255/);
    await expect(runner.run({ ...value, definition: { ...value.definition, questions: [
      { type: "score", name: "score", instructions: "Score", levels: [{ label: "" }] }
    ] } })).rejects.toThrow(/score levels/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
