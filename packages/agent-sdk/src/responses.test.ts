import { describe, expect, it, vi } from "vitest";
import { artifactPayloadSha256 } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner } from "./responses.js";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("OpenAIAgentsSdkRunner", () => {
  it("sends real image pixels as input_image without leaking base64 into events", async () => {
    let body: { input: Array<{ role?: string; content?: unknown }> } | undefined;
    const events: { type: string; data?: unknown }[] = [];
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      images: () => [{ mimeType: "image/png", base64: "aGVsbG8=", detail: "high" }],
      fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        body = JSON.parse(init!.body as string);
        return stream([{ type: "response.completed", response: { output: [{ type: "message",
          content: [{ type: "output_text", text: "seen" }] }] } }]);
      }) as typeof fetch });
    expect((await runner.run(request(events))).output).toBe("seen");
    expect(body!.input[0]!.content).toEqual([{ type: "input_text", text: '{"topic":"hello"}' },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" }]);
    expect(JSON.stringify(events)).not.toContain("aGVsbG8=");
  });

  it("aborts a pending transport at the host deadline", async () => {
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, timeoutMs: 1,
      fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject((init!.signal as AbortSignal).reason), { once: true });
      })) as typeof fetch });
    await expect(runner.run(request([]))).rejects.toThrow("SIWC_RUN_TIMEOUT");
  });

  it("returns at the deadline when authorization hangs and ignores its late token", async () => {
    const pendingToken = deferred<string>();
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => stream([{ type: "response.completed", response: { output: [{ type: "message",
      content: [{ type: "output_text", text: "late" }] }] } }])) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: () => pendingToken.promise }, timeoutMs: 10, fetch });

    const running = runner.run(request(events));
    await expect(running).rejects.toThrow("SIWC_RUN_TIMEOUT");
    pendingToken.resolve("late-token");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("returns on external cancellation while a request gate hangs and ignores its late release", async () => {
    const controller = new AbortController();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => stream([{ type: "response.completed", response: { output: [{ type: "message",
      content: [{ type: "output_text", text: "late" }] }] } }])) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
      beforeRequest: () => { entered.resolve(); return gate.promise; } });

    const running = runner.run(request(events, controller.signal));
    await entered.promise;
    controller.abort(new Error("user canceled"));
    await expect(running).rejects.toThrow("user canceled");
    const persistedEvents = events.map((event) => event.type);

    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(persistedEvents);
  });

  it("does not persist validation feedback or resume the model loop after a canceled validator settles", async () => {
    const controller = new AbortController();
    const validation = deferred<unknown>();
    const entered = deferred<void>();
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => stream([{ type: "response.completed", response: { output: [{ type: "message",
      content: [{ type: "output_text", text: "candidate" }] }] } }])) as typeof globalThis.fetch;
    const feedback = vi.fn(async () => "repair it");
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
      maxOutputValidationCorrections: 1, validateOutput: () => { entered.resolve(); return validation.promise; },
      outputValidationFeedback: feedback });

    const running = runner.run(request(events, controller.signal));
    await entered.promise;
    controller.abort(new Error("user canceled"));
    await expect(running).rejects.toThrow("user canceled");
    const persistedEvents = events.map((event) => event.type);

    validation.resolve("late result");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(feedback).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(persistedEvents);
  });

  it("validates a parsed output before reporting success", async () => {
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      validateOutput: value => { if (typeof value !== "object" || value === null || !("ok" in value)) throw new Error("BAD_OUTPUT"); return value; },
      fetch: vi.fn(async () => stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: '{"ok":true}' }] }] } }])) as typeof fetch });
    const input = request([]); input.definition.config.outputFormat = "json";
    expect((await runner.run(input)).validation).toBe("valid");
  });

  it("opts into JSON object transport with actual instructions recorded, preserving legacy JSON parsing", async () => {
    const bodies: Array<{ instructions?: string; text?: { format: { type: string } };
      input: Array<{ role?: string; content?: unknown }> }> = [];
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: bodies.length === 4 ? "[1,2]" : '{"ok":true}' }] }] } }]);
    }) as typeof globalThis.fetch;
    for (const configured of ["", "Write plainly"]) {
      const input = request(events);
      input.definition.config.instructions = configured;
      input.definition.config.outputFormat = "json";
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch, enforceJsonObject: true });
      expect((await runner.run(input)).output).toEqual({ ok: true });
      const body = bodies.at(-1)!;
      expect(body.text).toEqual({ format: { type: "json_object" } });
      expect(body.instructions).toContain("The final response must be a valid JSON object.");
      expect(body.input).toContainEqual({ role: "developer", content: "The final response must be a valid JSON object." });
      expect(body.input).toContainEqual({ role: "user", content: '{"topic":"hello"}' });
      const started = events.filter(event => event.type === "siwc.started").at(-1);
      expect(started?.data).toMatchObject({ instructions: body.instructions,
        jsonObjectInputRequirement: "The final response must be a valid JSON object." });
    }
    const alreadyJson = request(events);
    alreadyJson.definition.config.instructions = "Return JSON that matches the schema.";
    alreadyJson.definition.config.outputFormat = "json";
    await new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch, enforceJsonObject: true }).run(alreadyJson);
    expect(bodies.at(-1)?.instructions).toBe("Return JSON that matches the schema.");
    expect(bodies.at(-1)?.input).toContainEqual({ role: "developer", content: "The final response must be a valid JSON object." });
    expect(bodies.at(-1)?.input).toContainEqual({ role: "user", content: '{"topic":"hello"}' });
    const legacy = request(events);
    legacy.definition.config.instructions = "Write plainly";
    legacy.definition.config.outputFormat = "json";
    expect((await new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch }).run(legacy)).output).toEqual([1, 2]);
    expect(bodies.at(-1)).not.toHaveProperty("text");
    expect(bodies.at(-1)?.instructions).toBe("Write plainly");
    expect(bodies.at(-1)?.input).toEqual([{ role: "user", content: '{"topic":"hello"}' }]);
  });

  it("corrects invalid JSON and unread evidence within one bounded conversation when explicitly enabled", async () => {
    const bodies: Array<{ input: Array<{ role?: string; type?: string; content?: unknown; output?: string }>;
      text?: { format: { type: string } } }> = [];
    const events: { type: string; data?: unknown }[] = [];
    let read = false;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, enforceJsonObject: true,
      images: () => [{ mimeType: "image/png", base64: "aGVsbG8=" }],
      tools: () => [{ name: "read_evidence", description: "Read the rest", parameters: { type: "object" },
        execute: async () => { read = true; return { text: "remaining evidence" }; } }],
      maxOutputValidationCorrections: 2,
      outputValidationFeedback: error => error instanceof SyntaxError ? "Return valid JSON" : "Read evidence offset 32768, then return JSON",
      validateOutput: value => { if (!read) throw new Error("UNREAD offset=32768"); return value; },
      fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string));
        switch (bodies.length) {
          case 1: return stream([{ type: "response.completed", response: { output: [{ type: "message",
            content: [{ type: "output_text", text: '{"ready" true}' }] }] } }]);
          case 2: return stream([{ type: "response.completed", response: { output: [{ type: "message",
            content: [{ type: "output_text", text: '{"ready":true}' }] }] } }]);
          case 3: return stream([{ type: "response.completed", response: { output: [{ type: "function_call",
            name: "read_evidence", call_id: "read-2", arguments: '{"offset":32768}' }] } }]);
          default: return stream([{ type: "response.completed", response: { output: [{ type: "message",
            content: [{ type: "output_text", text: '{"ready":true}' }] }] } }]);
        }
      }) as typeof fetch });
    const input = request(events); input.definition.config.outputFormat = "json";
    const result = await runner.run(input);
    expect(result).toMatchObject({ output: { ready: true }, metadata: { outputValidationCorrections: 2, turns: 4 } });
    expect(bodies.map((body) => body.text)).toEqual(Array(4).fill({ format: { type: "json_object" } }));
    expect(bodies.every((body) => body.input.some((item) => item.role === "developer"
      && item.content === "The final response must be a valid JSON object."))).toBe(true);
    expect(bodies[1]!.input.at(-1)).toEqual({ role: "user", content: "Return valid JSON" });
    expect(bodies[2]!.input.at(-1)).toEqual({ role: "user", content: "Read evidence offset 32768, then return JSON" });
    expect(bodies[3]!.input.at(-1)).toMatchObject({ type: "function_call_output", output: '{"text":"remaining evidence"}' });
    expect(JSON.stringify(bodies[3])).toContain("data:image/png;base64,aGVsbG8=");
    expect(events.filter(event => event.type === "siwc.validation_failed")).toMatchObject([
      { data: { failureKind: "json_parse", correction: 1 } },
      { data: { failureKind: "output_validation", correction: 2 } }
    ]);
    expect(JSON.stringify(events)).not.toContain("aGVsbG8=");
  });

  it("keeps invalid JSON fail-fast by default", async () => {
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: '{bad json}' }] }] } }])) as typeof fetch });
    const input = request([]); input.definition.config.outputFormat = "json";
    await expect(runner.run(input)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("gates original, technical repair and tool continuation POSTs and records safe structured validation feedback after raw output",async()=>{
    const events:{type:string;data?:unknown}[]=[];
    const kinds:string[]=[];
    const bodies:Array<{input:Array<{role?:string;content?:unknown}>}>=[];
    const fetch=vi.fn(async(_url:URL|RequestInfo,init?:RequestInit)=>{
      bodies.push(JSON.parse(String(init?.body)));
      switch(fetch.mock.calls.length){
        case 1:return stream([{type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'{"ok":false}'}]}]}}]);
        case 2:return stream([{type:'response.completed',response:{output:[{type:'function_call',name:'read_evidence',call_id:'call-1',arguments:'{}'}]}}]);
        default:return stream([{type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]}}]);
      }
    }) as typeof fetch;
    const runner=new OpenAIAgentsSdkRunner({auth:{accessToken:async()=>"token"},fetch,maxOutputValidationCorrections:1,
      tools:()=>[{name:'read_evidence',description:'Read',parameters:{type:'object'},execute:async()=>({done:true})}],
      beforeRequest:async({turn,kind})=>{kinds.push(`${turn}:${kind}`);},
      validateOutput:value=>{if(!(value as {ok?:boolean}).ok)throw new Error('INVALID');return value;},
      outputValidationFeedback:()=>({message:'Read evidence then correct the answer',validationError:{issues:[{path:'$.ok',value:false,expected:'true'}]}})});
    const input=request(events);input.definition.config.outputFormat='json';
    expect((await runner.run(input)).output).toEqual({ok:true});
    expect(kinds).toEqual(['1:original','2:technical-repair','3:tool-continuation']);
    expect(fetch).toHaveBeenCalledTimes(3);
    const repair=String(bodies[1]?.input.at(-1)?.content);
    expect(repair).toContain('Read evidence then correct the answer');
    expect(repair).toContain('"path":"$.ok"');
    expect(repair).toContain('"value":false');
    expect(repair).toContain('"expected":"true"');
    const raw=events.findIndex(event=>event.type==='siwc.response'),error=events.findIndex(event=>event.type==='siwc.validation_error');
    expect(raw).toBeGreaterThan(-1);expect(error).toBeGreaterThan(raw);
    expect(events[error]?.data).toMatchObject({issues:[{path:'$.ok',value:false,expected:'true'}]});
  });

  it("stops before the provider POST when a durable reservation is denied",async()=>{
    const events:{type:string;data?:unknown}[]=[];
    const fetch=vi.fn(async()=>stream([{type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'invalid'}]}]}}])) as typeof fetch;
    const runner=new OpenAIAgentsSdkRunner({auth:{accessToken:async()=>"token"},fetch,maxOutputValidationCorrections:1,
      outputValidationFeedback:()=>"Fix output",validateOutput:()=>{throw new Error('INVALID');},
      beforeRequest:async({kind})=>{if(kind==='technical-repair')throw new Error('Budget denied');}});
    await expect(runner.run(request(events))).rejects.toThrow('Budget denied');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.some(event=>event.type==='siwc.response')).toBe(true);
  });

  it("injects tool-returned pixels into the next model turn without putting them in trace", async () => {
    const bodies: Array<{ input: Array<{ role?: string; content?: unknown }> }> = [];
    const events: { type: string; data?: unknown }[] = [];
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      tools: () => [{ name: "inspect_image", description: "Inspect a bound image", parameters: { type: "object" },
        execute: async () => ({ kind: "siwc_visual_tool_result", value: { ref: "frame-1" },
          images: [{ mimeType: "image/jpeg", base64: "aGVsbG8=" }] }) }],
      fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string));
        return bodies.length === 1
          ? stream([{ type: "response.completed", response: { output: [{ type: "function_call",
              name: "inspect_image", call_id: "call-1", arguments: "{}" }] } }])
          : stream([{ type: "response.completed", response: { output: [{ type: "message",
              content: [{ type: "output_text", text: "visible" }] }] } }]);
      }) as typeof fetch });
    expect((await runner.run(request(events))).output).toBe("visible");
    expect(bodies[1]!.input.at(-1)!.content).toEqual([
      { type: "input_text", text: "Images returned by inspect_image for call call-1. Inspect their pixels directly." },
      { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=", detail: "auto" }
    ]);
    expect(JSON.stringify(events)).not.toContain("aGVsbG8=");
  });
  it("records actual instructions and attempt-specific tools as sent, without tool code or credentials", async () => {
    const profiles: Record<string, unknown>[] = [];
    for (const [instructions, description] of [["Judge original", "Read bound report"],
      ["Judge changed", "Read bound report"], ["Judge original", "Read expanded report"]]) {
      const events: { type: string; data?: unknown }[] = [];
      const definition = { name: "read_report", description: description!, parameters: { type: "object" } };
      let body: Record<string, unknown> | undefined;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "private-token" },
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
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "secret-token" },
      fetch: http as typeof fetch, enforceJsonObject: true });
    const result = await runner.run(request(events));
    expect(result.output).toBe("Hello");
    const body = JSON.parse(captured[0]!.init.body as string);
    expect(body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true, input: [{ role: "user", content: '{"topic":"hello"}' }] });
    expect(body).not.toHaveProperty("text");
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
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "secret-token" }, fetch: http as typeof fetch,
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
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch: http as typeof fetch,
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
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch: http as typeof fetch });
    await expect(runner.run(request([]))).rejects.toThrow("unauthorized tool");
    const limited = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch: http as typeof fetch,
      tools: () => [{ name: "danger", description: "test", parameters: {}, execute: async () => null }], maxTurns: 1 });
    await expect(limited.run(request([]))).rejects.toThrow("limit exceeded");
    const interrupted = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => stream([{ type: "response.output_text.delta", delta: "partial" }])) as typeof fetch });
    await expect(interrupted.run(request([]))).rejects.toThrow("without response.completed");
  });

  it("records only safe provider identifiers from a stream error", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "secret-token" },
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
    const failed = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
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
    const incomplete = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
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
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => new Response("private body", { status: 429, headers: { "x-request-id": "Bearer secret-token" } })) as typeof fetch });
    await expect(runner.run(request(events))).rejects.toThrow("SIWC Responses request failed (429); requestId=unknown");
    expect(events.find(event => event.type === "siwc.provider_error")?.data).toEqual({ eventType: "http.error", status: 429 });
    expect(JSON.stringify(events)).not.toContain("private body");
    expect(JSON.stringify(events)).not.toContain("secret-token");
    const streamedEvents: { type: string; data?: unknown }[] = [];
    const streamed = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: vi.fn(async () => stream([{ type: "error", code: "sk-secret-token", request_id: "sk-secret-token",
        message: "private provider response" }])) as typeof fetch });
    await expect(streamed.run(request(streamedEvents))).rejects.toThrow("SIWC stream error: unknown");
    expect(streamedEvents.find(event => event.type === "siwc.provider_error")?.data).toEqual({ eventType: "error" });
    expect(JSON.stringify(streamedEvents)).not.toContain("secret-token");
  });
});
