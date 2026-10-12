import { Runner } from "@openai/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIAgentsSdkRunner } from "./responses.js";

type Event = { type: string; data?: unknown };

function stream(output: unknown[], id = "resp-1"): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`data: ${JSON.stringify({ type: "response.completed", response: {
    id, output, usage: { input_tokens: 11, output_tokens: 3 },
  } })}\n\n`);
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), {
    headers: { "content-type": "text/event-stream" },
  });
}

function request(events: Event[], signal = new AbortController().signal) {
  return {
    runId: "run-1", stepRunId: "step-1", attemptId: "attempt-1", input: { question: "read the brief" }, signal,
    definition: { id: "writer", revision: "1", model: "gpt-6.1-sol", reasoningEffort: "low" as const,
      promptRevision: "1", skillsRevision: "1", permissionsRevision: "1", config: { instructions: "Use the bound tool." } },
    emit: async (type: string, data?: unknown) => { events.push({ type, data }); },
  };
}

const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (name: string, callId: string, args = "{}") => ({ type: "function_call", name, call_id: callId, arguments: args });

afterEach(() => vi.restoreAllMocks());

describe("OpenAIAgentsSdkRunner", () => {
  it("uses the real Agents SDK runner for a tool turn and records the SDK identity", async () => {
    const sdkRun = vi.spyOn(Runner.prototype, "run");
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? stream([call("read_brief", "call-1", '{"section":"summary"}')], "resp-tool")
        : stream([message("The brief says launch Friday.")], "resp-final");
    }) as typeof globalThis.fetch;
    const execute = vi.fn(async () => ({ excerpt: "Launch Friday." }));
    const events: Event[] = [];
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "chatgpt-token" }, fetch,
      tools: () => [{ name: "read_brief", description: "Read the bound brief", parameters: { type: "object" }, execute }] });

    const result = await runner.run(request(events));

    expect(sdkRun).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ section: "summary" }, expect.any(AbortSignal));
    expect(result.output).toBe("The brief says launch Friday.");
    expect(result.metadata).toMatchObject({ runtime: "openai-agents-sdk", sdkPackage: "@openai/agents", sdkVersion: "0.20.0" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call-1", name: "read_brief" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call-1",
        output: '{"excerpt":"Launch Friday."}' }),
    ]));
  });

  it("denies a batch above maxToolCalls before invoking any tool", async () => {
    const fetch = vi.fn(async () => stream([call("read_brief", "call-1"), call("read_brief", "call-2")])) as typeof globalThis.fetch;
    const execute = vi.fn(async () => ({ ok: true }));
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch, maxToolCalls: 1,
      tools: () => [{ name: "read_brief", description: "Read", parameters: { type: "object" }, execute }] });

    await expect(runner.run(request([]))).rejects.toThrow(/tool|limit/i);
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("replays opaque reasoning across tool and technical-correction turns without tracing it", async () => {
    const opaque = "opaque-reasoning-private-payload";
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      switch (bodies.length) {
        case 1: return stream([
          { type: "reasoning", id: "reasoning-1", summary: [{ type: "summary_text", text: opaque }], encrypted_content: opaque },
          call("read_brief", "call-1"),
        ]);
        case 2: return stream([message('{"ok":false}')]);
        default: return stream([message('{"ok":true}')]);
      }
    }) as typeof globalThis.fetch;
    const events: Event[] = [];
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
      tools: () => [{ name: "read_brief", description: "Read", parameters: { type: "object" }, execute: async () => ({ read: true }) }],
      maxOutputValidationCorrections: 1,
      validateOutput: value => { if (!(value as { ok?: boolean }).ok) throw new Error("INVALID"); return value; },
      outputValidationFeedback: () => "Correct the JSON output" });
    const input = request(events);
    input.definition.config.outputFormat = "json";

    expect((await runner.run(input)).output).toEqual({ ok: true });
    for (const body of bodies.slice(1)) {
      expect(body.input).toContainEqual({ type: "reasoning", id: "reasoning-1",
        summary: [{ type: "summary_text", text: opaque }], encrypted_content: opaque });
    }
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(opaque);
  });

  it.each([
    ["unknown", call("not_authorized", "call-unknown")],
    ["malformed", call("read_brief", "call-bad", "{bad json")],
  ])("rejects %s function calls before tool side effects", async (_kind, functionCall) => {
    const fetch = vi.fn(async () => stream([functionCall])) as typeof globalThis.fetch;
    const execute = vi.fn(async () => ({ ok: true }));
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
      tools: () => [{ name: "read_brief", description: "Read", parameters: { type: "object" }, execute }] });

    await expect(runner.run(request([]))).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops before the next provider request when cancellation interrupts a running tool", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fetch = vi.fn(async () => stream([call("read_brief", "call-1")])) as typeof globalThis.fetch;
    const execute = vi.fn((_args: unknown, signal: AbortSignal) => new Promise<{ ok: true }>((_resolve, reject) => {
      markStarted();
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    }));
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
      tools: () => [{ name: "read_brief", description: "Read", parameters: { type: "object" }, execute }] });
    const running = runner.run(request([], controller.signal));
    await started;
    controller.abort(new Error("user canceled"));

    await expect(running).rejects.toThrow("user canceled");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
