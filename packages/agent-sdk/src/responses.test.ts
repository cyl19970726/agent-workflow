import { describe, expect, it, vi } from "vitest";
import { artifactPayloadSha256 } from "@signal-room/workflow";
import { SiwcResponsesRunner } from "./responses.js";

function stream(events: unknown[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    const bytes = encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close();
  } }), { headers: { "content-type": "text/event-stream", ...headers } });
}

const request = (events: { type: string; data?: unknown }[], signal = new AbortController().signal) => ({
  runId: "r", stepRunId: "s", attemptId: "a", input: { topic: "hello" }, signal,
  definition: { id: "writer", revision: "1", model: "gpt-6.1-sol", reasoningEffort: "low",
    promptRevision: "1", skillsRevision: "1", permissionsRevision: "1", config: { instructions: "Write plainly" } },
  emit: async (type: string, data?: unknown) => { events.push({ type, data }); },
});

describe("SiwcResponsesRunner", () => {
  it("records actual instructions and attempt-specific tools as sent, without tool code or credentials", async () => {
    const profiles: Record<string, unknown>[] = [];
    for (const [instructions, description] of [["Judge original", "Read bound report"],
      ["Judge changed", "Read bound report"], ["Judge original", "Read expanded report"]]) {
      const events: { type: string; data?: unknown }[] = [];
      const definition = { name: "read_report", description: description!, parameters: { type: "object" } };
      let body: Record<string, unknown> | undefined;
      const runner = new SiwcResponsesRunner({ auth: { accessToken: async () => "private-token" },
        tools: () => [{ ...definition, execute: async () => null }],
        fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
          body = JSON.parse(init!.body as string);
          return stream([{ type: "response.completed", response: { output: [{ type: "message",
            content: [{ type: "output_text", text: "Done" }] }] } }]);
        }) as typeof fetch });
      const actual = request(events);
      actual.definition.config.instructions = instructions!;
      await runner.run(actual);
      const profile = events.find(event => event.type === "siwc.started")!.data as Record<string, unknown>;
      expect(profile).toMatchObject({ instructions, toolDefinitions: [definition],
        toolProfileHash: await artifactPayloadSha256([definition]) });
      expect(profile.toolProfileHash).toBe(await artifactPayloadSha256([{
        parameters: definition.parameters, description: definition.description, name: definition.name,
      }])); // jsonb can reorder keys without changing the actual tool profile.
      expect(body!.instructions).toBe(profile.instructions);
      expect((body!.input as { tools?: unknown[] }[])[0]!.tools).toEqual([{ type: "function", ...definition }]);
      expect(JSON.stringify(profile)).not.toContain("execute");
      expect(JSON.stringify(events)).not.toContain("private-token");
      profiles.push(profile);
    }
    expect(profiles[0]!.toolProfileHash).toBe(profiles[1]!.toolProfileHash);
    expect(profiles[0]!.instructions).not.toBe(profiles[1]!.instructions);
    expect(profiles[0]!.toolProfileHash).not.toBe(profiles[2]!.toolProfileHash);
  });
  it("streams text, passes only SIWC fields, and completes only on terminal event", async () => {
    const captured: { url: unknown; init: RequestInit }[] = [];
    const http = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      captured.push({ url, init: init! });
      return stream([{ type: "response.output_text.delta", delta: "Hello" },
        { type: "response.completed", response: { id: "resp-1", output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] } }]);
    });
    const events: { type: string; data?: unknown }[] = [];
    const runner = new SiwcResponsesRunner({ auth: { accessToken: async () => "secret-token" }, fetch: http as typeof fetch });
    const result = await runner.run(request(events));
    expect(result.output).toBe("Hello");
    const body = JSON.parse(captured[0]!.init.body as string);
    expect(body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true, input: [{ role: "user", content: '{"topic":"hello"}' }] });
    expect(body).not.toHaveProperty("max_tool_calls");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(events)).not.toContain("secret-token");
    expect(events.some((event) => event.type === "siwc.text_delta")).toBe(true);
  });

  it("executes only injected tools and sends full history on the next request", async () => {
    const bodies: unknown[] = [];
    const http = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      if (bodies.length === 1) return stream([{ type: "response.completed", response: { output: [
        { type: "function_call", name: "read_asset", call_id: "call-1", arguments: '{"slot":"brief"}' },
      ] } }]);
      return stream([{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] } }]);
    });
    const execute = vi.fn(async () => ({ text: "brief body" }));
    const events: { type: string; data?: unknown }[] = [];
    const runner = new SiwcResponsesRunner({ auth: { accessToken: async () => "secret-token" }, fetch: http as typeof fetch,
      tools: async () => [{ name: "read_asset", description: "Read a bound asset", parameters: { type: "object", properties: {} }, execute }] });
    expect((await runner.run(request(events))).output).toBe("Done");
    expect(execute).toHaveBeenCalledOnce();
    const second = bodies[1] as { input: { type?: string; call_id?: string }[] };
    expect(second.input.map((item) => item.type)).toEqual(["additional_tools", undefined, "function_call", "function_call_output"]);
    expect(second.input[3]!.call_id).toBe("call-1");
    expect(events.some((event) => event.type === "siwc.tool_call")).toBe(true);
    expect(events.find((event) => event.type === "siwc.tool_call")?.data).toMatchObject({ arguments: { slot: "brief" } });
    expect(events.find((event) => event.type === "siwc.tool_result")?.data).toMatchObject({ output: { text: "brief body" } });
    expect(events.find((event) => event.type === "siwc.response")?.data).toMatchObject({ visibleOutput: [{ type: "function_call", name: "read_asset" }] });
    expect(JSON.stringify(events)).not.toContain("secret-token");
  });

  it("assembles streamed function calls and text when response.completed omits output", async () => {
    const bodies: { input: { type?: string; arguments?: string; output?: string }[] }[] = [];
    const http = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      if (bodies.length === 1) return stream([
        { type: "response.output_item.added", output_index: 0, item: { id: "fc-1", type: "function_call", name: "read_asset", call_id: "call-1", arguments: "" } },
        { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc-1", arguments: '{"slot":"brief"}' },
        { type: "response.output_item.done", output_index: 0, item: { id: "fc-1", type: "function_call", name: "read_asset", call_id: "call-1", arguments: '{"slot":"brief"}' } },
        { type: "response.completed", response: { id: "resp-tool", output: [], usage: { output_tokens: 19 } } },
      ]);
      return stream([
        { type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done" },
        { type: "response.output_item.done", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
        { type: "response.completed", response: { id: "resp-final", usage: { output_tokens: 3 } } },
      ]);
    });
    const events: { type: string; data?: unknown }[] = [];
    const execute = vi.fn(async () => ({ text: "brief body" }));
    const runner = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" }, fetch: http as typeof fetch,
      tools: () => [{ name: "read_asset", description: "Read a bound asset", parameters: { type: "object" }, execute }] });
    expect((await runner.run(request(events))).output).toBe("Done");
    expect(execute).toHaveBeenCalledWith({ slot: "brief" }, expect.any(AbortSignal));
    expect(bodies[1]!.input[2]).toMatchObject({ type: "function_call", arguments: '{"slot":"brief"}' });
    expect(bodies[1]!.input[3]).toMatchObject({ type: "function_call_output", output: '{"text":"brief body"}' });
    expect(events.find((event) => event.type === "siwc.response")?.data).toMatchObject({ visibleOutput: [{ type: "function_call", name: "read_asset" }] });
  });

  it("fails closed on unapproved tools, limits, and interrupted streams", async () => {
    const call = { type: "function_call", name: "danger", call_id: "1", arguments: "{}" };
    const http = vi.fn(async () => stream([{ type: "response.completed", response: { output: [call] } }]));
    const runner = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" }, fetch: http as typeof fetch });
    await expect(runner.run(request([]))).rejects.toThrow("unauthorized tool");
    const limited = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" }, fetch: http as typeof fetch,
      tools: () => [{ name: "danger", description: "test", parameters: {}, execute: async () => null }], maxTurns: 1 });
    await expect(limited.run(request([]))).rejects.toThrow("limit exceeded");
    const interrupted = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => stream([{ type: "response.output_text.delta", delta: "partial" }])) as typeof fetch });
    await expect(interrupted.run(request([]))).rejects.toThrow("without response.completed");
  });

  it("records only safe provider identifiers from a stream error", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const runner = new SiwcResponsesRunner({ auth: { accessToken: async () => "secret-token" },
      fetch: vi.fn(async () => stream([{ type: "error", code: "rate_limit_exceeded", param: "input[0]",
        request_id: "req_mimo_123", message: "Bearer secret-token; private prompt", headers: { authorization: "secret-token" },
        body: { private: "do-not-save" }, error: { type: "provider_error", code: "rate_limit_exceeded", param: "input[0]" } }])) as typeof fetch });
    await expect(runner.run(request(events))).rejects.toThrow("SIWC stream error: rate_limit_exceeded");
    expect(events.find(event => event.type === "siwc.provider_error")?.data).toEqual({
      eventType: "error", code: "rate_limit_exceeded", providerType: "provider_error", param: "input[0]", requestId: "req_mimo_123",
    });
    expect(JSON.stringify(events)).not.toContain("secret-token");
    expect(JSON.stringify(events)).not.toContain("private prompt");
    expect(JSON.stringify(events)).not.toContain("do-not-save");
  });

  it("preserves safe failed and incomplete reasons without provider messages", async () => {
    const failedEvents: { type: string; data?: unknown }[] = [];
    const failed = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => stream([{ type: "response.failed", response: { id: "resp_123",
        error: { code: "server_error", type: "upstream_error", param: "model", message: "private failure body" } } }],
      { "x-request-id": "req_header_42" })) as typeof fetch });
    await expect(failed.run(request(failedEvents))).rejects.toThrow("SIWC response failed: server_error");
    expect(failedEvents.find(event => event.type === "siwc.provider_error")?.data).toEqual({
      eventType: "response.failed", code: "server_error", providerType: "upstream_error", param: "model",
      requestId: "req_header_42", responseId: "resp_123",
    });
    expect(JSON.stringify(failedEvents)).not.toContain("private failure body");

    const incompleteEvents: { type: string; data?: unknown }[] = [];
    const incomplete = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => stream([{ type: "response.incomplete", response: { id: "resp_456",
        incomplete_details: { reason: "max_output_tokens", message: "hidden text" } } }])) as typeof fetch });
    await expect(incomplete.run(request(incompleteEvents))).rejects.toThrow("SIWC response incomplete: max_output_tokens");
    expect(incompleteEvents.find(event => event.type === "siwc.provider_error")?.data).toEqual({
      eventType: "response.incomplete", responseId: "resp_456", reason: "max_output_tokens",
    });
    expect(JSON.stringify(incompleteEvents)).not.toContain("hidden text");
  });

  it("rejects unsafe identifier shapes and never records HTTP response bodies", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const runner = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => new Response("private body", { status: 429, headers: { "x-request-id": "Bearer secret-token" } })) as typeof fetch });
    await expect(runner.run(request(events))).rejects.toThrow("SIWC Responses request failed (429); requestId=unknown");
    expect(events.find(event => event.type === "siwc.provider_error")?.data).toEqual({ eventType: "http.error", status: 429 });
    expect(JSON.stringify(events)).not.toContain("private body");
    expect(JSON.stringify(events)).not.toContain("secret-token");
    const streamedEvents: { type: string; data?: unknown }[] = [];
    const streamed = new SiwcResponsesRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => stream([{ type: "error", code: "sk-secret-token", request_id: "sk-secret-token",
        message: "private provider response" }])) as typeof fetch });
    await expect(streamed.run(request(streamedEvents))).rejects.toThrow("SIWC stream error: unknown");
    expect(streamedEvents.find(event => event.type === "siwc.provider_error")?.data).toEqual({ eventType: "error" });
    expect(JSON.stringify(streamedEvents)).not.toContain("secret-token");
  });
});
