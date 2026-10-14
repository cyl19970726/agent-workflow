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
    const requestMetric = events.find(event => event.type === "siwc.request")?.data as Record<string, unknown>;
    expect(requestMetric).toMatchObject({
      requestBodyBytes: Buffer.byteLength(JSON.stringify({
        model: "gpt-6.1-sol", input: [{ role: "user", content: [{ type: "input_text", text: '{"topic":"hello"}' },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" }] }],
        instructions: "Write plainly", reasoning: { effort: "low" }, store: false, stream: true,
      }), "utf8"),
      inputImageOccurrences: 1,
      inlineImageDecodedBytes: 5,
      functionCallArgumentBytes: 0,
      inputTextBytes: Buffer.byteLength('{"topic":"hello"}', "utf8"),
      nonInlineInputImageOccurrences: 0,
    });
    expect(requestMetric.uniqueInputImageHashes).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(JSON.stringify(requestMetric)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(requestMetric)).not.toContain("secret-token");
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
    expect(events.map(event => event.type)).toEqual(["siwc.started"]);
    expect(JSON.stringify(events)).not.toContain("late-token");
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
    const requestMetrics = events.filter(event => event.type === "siwc.request").map(event => event.data as Record<string, unknown>);
    expect(requestMetrics).toHaveLength(2);
    expect(requestMetrics[0]).toMatchObject({ functionCallArgumentBytes: 0, inputTextBytes: Buffer.byteLength('{"topic":"hello"}', "utf8") });
    expect(requestMetrics[1]).toMatchObject({
      requestBodyBytes: Buffer.byteLength(JSON.stringify(bodies[1]), "utf8"),
      functionCallArgumentBytes: Buffer.byteLength('{"slot":"brief"}', "utf8"),
      inputTextBytes: Buffer.byteLength('{"topic":"hello"}', "utf8"),
    });
    expect(JSON.stringify(requestMetrics)).not.toContain("brief body");
    expect(JSON.stringify(requestMetrics)).not.toContain("secret-token");
  });

  it("reacquires the SIWC access token on each turn of a long-running agent", async () => {
    let tokenExpired = false;
    const accessToken = vi.fn(async () => tokenExpired ? "rotated-token" : "starting-token");
    const authorization: string[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorization.length === 1) {
        // Simulate the first response taking the run past the cached token's lifetime.
        tokenExpired = true;
        return stream([{ type: "response.completed", response: { output: [{ type: "function_call",
          name: "read_evidence", call_id: "call-1", arguments: "{}" }] } }]);
      }
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken }, fetch,
      tools: () => [{ name: "read_evidence", description: "Read frozen evidence", parameters: { type: "object" },
        execute: async () => ({ read: true }) }] });

    expect((await runner.run(request([]))).output).toBe("Done");
    expect(accessToken).toHaveBeenCalledTimes(2); // one fresh lookup immediately before each POST
    expect(authorization).toEqual(["Bearer starting-token", "Bearer rotated-token"]);
  });

  it("retries a single HTTP 401 with the newly rotated SIWC token", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const authorization: string[] = [];
    const requestBodies: string[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get("authorization") ?? "");
      requestBodies.push(init?.body as string);
      return authorization.length === 1
        ? new Response("private unauthorized body", { status: 401, headers: { "x-request-id": "req_401_once" } })
        : stream([{ type: "response.completed", response: { output: [{ type: "message",
          content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const refreshAfterUnauthorized = vi.fn(async () => "fresh-token");
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "rejected-token", refreshAfterUnauthorized }, fetch });

    expect((await runner.run(request(events))).output).toBe("Done");
    expect(authorization).toEqual(["Bearer rejected-token", "Bearer fresh-token"]);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(refreshAfterUnauthorized).toHaveBeenCalledOnce();
    const requestMetrics = events.filter(event => event.type === "siwc.request").map(event => event.data as Record<string, unknown>);
    expect(requestMetrics).toHaveLength(2);
    const { requestAttempt: firstAttempt, ...firstMetrics } = requestMetrics[0]!;
    const { requestAttempt: secondAttempt, ...secondMetrics } = requestMetrics[1]!;
    expect([firstAttempt, secondAttempt]).toEqual([1, 2]);
    expect(firstMetrics).toEqual(secondMetrics);
    expect(requestMetrics[0]).toMatchObject({ requestBodyBytes: Buffer.byteLength(requestBodies[0]!, "utf8") });
    expect(events.find(event => event.type === "siwc.auth_refreshed")?.data).toEqual({ reason: "http_401", requestAttempt: 2 });
    expect(events.some(event => event.type === "siwc.response")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("rejected-token");
    expect(JSON.stringify(events)).not.toContain("fresh-token");
    expect(JSON.stringify(events)).not.toContain("private unauthorized body");
  });

  it("refreshes and retries one rejected SIWC request, counts both posts, and never loops on a second 401", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const authorization: string[] = [];
    const refreshAfterUnauthorized = vi.fn(async (rejected: string) => {
      expect(rejected).toBe("rejected-token");
      return "refreshed-token";
    });
    const beforeRequest = vi.fn(async () => {});
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorization.length <= 2) return new Response("private unauthorized body", {
        status: 401, headers: { "x-request-id": `req_401_${authorization.length}` }
      });
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "unreachable" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "rejected-token", refreshAfterUnauthorized },
      beforeRequest, fetch });

    await expect(runner.run(request(events))).rejects.toThrow("SIWC Responses request failed (401)");
    expect(authorization).toEqual(["Bearer rejected-token", "Bearer refreshed-token"]);
    expect(refreshAfterUnauthorized).toHaveBeenCalledOnce();
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === "siwc.request")).toHaveLength(2);
    expect(events.find(event => event.type === "siwc.auth_refreshed")?.data).toEqual({ reason: "http_401", requestAttempt: 2 });
    expect(events.filter(event => event.type === "siwc.provider_error").map(event => event.data)).toEqual([
      { eventType: "http.error", status: 401, requestId: "req_401_1" },
      { eventType: "http.error", status: 401, requestId: "req_401_2" },
    ]);
    expect(JSON.stringify(events)).not.toContain("rejected-token");
    expect(JSON.stringify(events)).not.toContain("refreshed-token");
    expect(JSON.stringify(events)).not.toContain("private unauthorized body");
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
    const interruptedFetch = vi.fn(async () => stream([{ type: "response.output_text.delta", delta: "partial" }]));
    const interrupted = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: interruptedFetch as typeof fetch });
    const interruptedEvents: { type: string; data?: unknown }[] = [];
    await expect(interrupted.run(request(interruptedEvents))).rejects.toThrow("SIWC_TRANSPORT_FAILURE:stream:SIWC_STREAM_PREMATURE_EOF");
    expect(interruptedFetch).toHaveBeenCalledOnce();
    expect(interruptedEvents.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({ retrying: false });
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

  it("retries one broken fetch on the same turn, gates both posts, and records only safe diagnostics", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const gate = vi.fn(async () => {});
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) throw new TypeError("terminated", { cause: {
        code: "UND_ERR_SOCKET", privateBody: "do-not-record" } });
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "private-token" },
      beforeRequest: gate, fetch });
    expect((await runner.run(request(events))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === "siwc.request").map(event => (event.data as { requestAttempt: number }).requestAttempt))
      .toEqual([1, 2]);
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toEqual({ turn: 1,
      requestAttempt: 1, phase: "fetch", retrying: true, errorName: "TypeError", causeCode: "UND_ERR_SOCKET", bytesRead: 0 });
    expect(JSON.stringify(events)).not.toContain("private-token");
    expect(JSON.stringify(events)).not.toContain("do-not-record");
  });

  it("retries a broken stream before tool dispatch without replaying prior or partial tools", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const bodies: unknown[] = [];
    const execute = vi.fn(async () => ({ read: true }));
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      if (bodies.length === 1) return stream([{ type: "response.completed", response: { output: [{ type: "function_call",
        name: "read_asset", call_id: "prior", arguments: "{}" }] } }]);
      if (bodies.length === 2) {
        const bytes = new TextEncoder().encode('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","name":"read_asset","call_id":"partial","arguments":"{}"}}\n\n');
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          if (!sent) { sent = true; controller.enqueue(bytes); }
          else controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
        } }), { headers: { "x-request-id": "req_safe_2" } });
      }
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
      tools: () => [{ name: "read_asset", description: "read", parameters: { type: "object" }, execute }] });
    expect((await runner.run(request(events))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === "siwc.tool_call")).toHaveLength(1);
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
      turn: 2, requestAttempt: 1, phase: "stream", retrying: true, status: 200, requestId: "req_safe_2" });
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it("retries premature EOF once with the same pending body and without replaying completed tools", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const bodies: unknown[] = [];
    const gate = vi.fn(async () => {});
    const execute = vi.fn(async () => ({ read: true }));
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      if (bodies.length === 1) return stream([{ type: "response.completed", response: { output: [{ type: "function_call",
        name: "read_asset", call_id: "prior", arguments: "{}" }] } }]);
      if (bodies.length === 2) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_item.added"'));
        controller.close();
      } }), { headers: { "x-request-id": "req_safe_eof" } });
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "private-token" }, fetch,
      beforeRequest: gate,
      tools: () => [{ name: "read_asset", description: "read", parameters: { type: "object" }, execute }] });

    expect((await runner.run(request(events))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(gate).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledOnce();
    expect(bodies[1]).toEqual(bodies[2]);
    expect(events.filter(event => event.type === "siwc.tool_call")).toHaveLength(1);
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toEqual({
      turn: 2, requestAttempt: 1, phase: "stream", retrying: true, errorName: "Error",
      causeCode: "SIWC_STREAM_PREMATURE_EOF", status: 200, requestId: "req_safe_eof",
      bytesRead: new TextEncoder().encode('data: {"type":"response.output_item.added"').byteLength,
    });
    expect(JSON.stringify(events)).not.toContain("private-token");
  });

  it("bounds premature EOF under the existing transport and server retry budget", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1
      ? new Response("private body", { status: 507 })
      : stream([])) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch });
    await expect(runner.run(request(events))).rejects.toThrow("SIWC_TRANSPORT_FAILURE:stream:SIWC_STREAM_PREMATURE_EOF");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
      causeCode: "SIWC_STREAM_PREMATURE_EOF", retrying: false, bytesRead: 0 });
    expect(JSON.stringify(events)).not.toContain("private body");
  });

  it("retries an eligible fetch timeout once without treating it as the workflow deadline", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) throw new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch });
    expect((await runner.run(request(events))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
      phase: "fetch", causeCode: "ETIMEDOUT", retrying: true });
  });

  it("retries an eligible body timeout before completion", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_BODY_TIMEOUT" } })); },
      }));
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch });
    expect((await runner.run(request(events))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
      phase: "stream", causeCode: "UND_ERR_BODY_TIMEOUT", retrying: true });
  });

  it("bounds transport retry, preserves 401 refresh, and never retries abort or explicit provider failure", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const gate = vi.fn(async () => {});
    const refresh = vi.fn(async () => "fresh-token");
    const authorization: string[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get("authorization") ?? "");
      if (fetch.mock.calls.length === 1) return new Response("private body", { status: 401 });
      throw new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET", secret: "do-not-record" } });
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "old-token",
      refreshAfterUnauthorized: refresh }, beforeRequest: gate, fetch });
    await expect(runner.run(request(events))).rejects.toThrow("SIWC_TRANSPORT_FAILURE:fetch:UND_ERR_SOCKET");
    expect(fetch).toHaveBeenCalledTimes(3); // 401 + one failed transport attempt + one retry
    expect(authorization).toEqual(["Bearer old-token", "Bearer fresh-token", "Bearer fresh-token"]);
    expect(gate).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === "siwc.transport_error").map(event =>
      (event.data as { retrying: boolean }).retrying)).toEqual([true, false]);
    expect(JSON.stringify(events)).not.toContain("old-token");
    expect(JSON.stringify(events)).not.toContain("fresh-token");
    expect(JSON.stringify(events)).not.toContain("do-not-record");

    const controller = new AbortController();
    const abortedFetch = vi.fn(async () => {
      controller.abort(new Error("canceled"));
      throw new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
    }) as typeof globalThis.fetch;
    await expect(new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch: abortedFetch })
      .run(request([], controller.signal))).rejects.toThrow("canceled");
    expect(abortedFetch).toHaveBeenCalledOnce();

    const providerFetch = vi.fn(async () => stream([{ type: "response.failed", response: { error: { code: "server_error" } } }])) as typeof globalThis.fetch;
    await expect(new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch: providerFetch })
      .run(request([]))).rejects.toThrow("SIWC response failed: server_error");
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("distinguishes a pre-POST auth failure from a sent request without logging its message", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => new Response());
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => {
      const error = new Error("private credential detail") as Error & { code: string };
      error.code = "invalid_grant";
      throw error;
    } }, fetch: fetch as typeof globalThis.fetch });
    await expect(runner.run(request(events))).rejects.toThrow("private credential detail");
    expect(fetch).not.toHaveBeenCalled();
    expect(events.find(event => event.type === "siwc.pre_request_error")?.data).toEqual({
      turn: 1, phase: "auth", errorName: "Error", causeCode: "invalid_grant" });
    expect(events.some(event => event.type === "siwc.request")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private credential detail");
  });

  it("records a failed 401 refresh separately and does not retry the provider POST", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => new Response("private body", { status: 401,
      headers: { "x-request-id": "req_safe_refresh" } })) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "private-token",
      refreshAfterUnauthorized: async () => {
        const error = new Error("private refresh body") as Error & { code: string };
        error.code = "invalid_grant";
        throw error;
      } }, fetch });
    await expect(runner.run(request(events))).rejects.toThrow("private refresh body");
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.find(event => event.type === "siwc.pre_request_error")?.data).toEqual({
      turn: 1, phase: "auth_refresh", status: 401, requestId: "req_safe_refresh",
      errorName: "Error", causeCode: "invalid_grant" });
    expect(events.some(event => event.type === "siwc.transport_error")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private-token");
    expect(JSON.stringify(events)).not.toContain("private body");
  });

  it("does not retry after a visible text delta, even if the stream then breaks", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => {
      const bytes = new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(bytes); }
        else controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
      } }));
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch });
    await expect(runner.run(request(events))).rejects.toThrow("SIWC_TRANSPORT_FAILURE:stream:UND_ERR_SOCKET");
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({ retrying: false });
    expect(events.some(event => event.type === "siwc.text_delta")).toBe(true);
  });

  it("continues after a completed tool response when its stream stays open and cancellation stalls", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const execute = vi.fn(async () => ({ read: true }));
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) {
        const bytes = new TextEncoder().encode('data: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"read_asset","call_id":"call-1","arguments":"{}"}]}}\n\ndata: {"type":"error","code":"late_error"}\n\n');
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(bytes); },
          cancel,
        }));
      }
      return stream([{ type: "response.completed", response: { output: [{ type: "message",
        content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch, timeoutMs: 200, tools: () => [{ name: "read_asset", description: "read",
        parameters: { type: "object" }, execute }] });

    expect((await runner.run(request(events))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === "siwc.tool_call")).toHaveLength(1);
    expect(events.some(event => event.type === "siwc.transport_error")).toBe(false);
    expect(events.some(event => event.type === "siwc.provider_error")).toBe(false);
  });

  it("retries one HTTP 507 on the same turn with identical input and a fresh request gate", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const bodies: string[] = [];
    const gate = vi.fn(async () => {});
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(init!.body as string);
      return bodies.length === 1
        ? new Response("private provider body", { status: 507, headers: { "retry-after-ms": "0", "x-request-id": "req_safe_507" } })
        : stream([{ type: "response.completed", response: { output: [{ type: "message",
          content: [{ type: "output_text", text: "Done" }] }] } }]);
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "secret-token" }, beforeRequest: gate, fetch });
    expect((await runner.run(request(events))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(events.find(event => event.type === "siwc.provider_retry")?.data).toEqual({
      turn: 1, requestAttempt: 1, status: 507, requestId: "req_safe_507", delayMs: 0 });
    expect(events.filter(event => event.type === "siwc.request")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("private provider body");
    expect(JSON.stringify(events)).not.toContain("secret-token");
  });

  it("shares one retry across HTTP 5xx and transport failures while keeping 401 refresh separate", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const refresh = vi.fn(async () => "fresh-token");
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) return new Response("", { status: 401 });
      if (fetch.mock.calls.length === 2) return new Response("", { status: 507,
        headers: { "retry-after-ms": "0" } });
      throw new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
    }) as typeof globalThis.fetch;
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "old-token",
      refreshAfterUnauthorized: refresh }, fetch });
    await expect(runner.run(request(events))).rejects.toThrow("SIWC_TRANSPORT_FAILURE:fetch:UND_ERR_SOCKET");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === "siwc.provider_retry")).toHaveLength(1);
    expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({ retrying: false });

    const repeated = vi.fn(async () => new Response("", { status: 507,
      headers: { "retry-after-ms": "0" } })) as typeof globalThis.fetch;
    await expect(new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch: repeated })
      .run(request([]))).rejects.toThrow("SIWC Responses request failed (507)");
    expect(repeated).toHaveBeenCalledTimes(2);
  });

  it("respects retry refusal and bounded Retry-After, and aborts during an accepted wait", async () => {
    for (const headers of [{ "x-should-retry": "false" }, { "retry-after": "60" }]) {
      const fetch = vi.fn(async () => new Response("", { status: 507, headers })) as typeof globalThis.fetch;
      await expect(new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch })
        .run(request([]))).rejects.toThrow("SIWC Responses request failed (507)");
      expect(fetch).toHaveBeenCalledOnce();
    }
    const controller = new AbortController();
    const events: { type: string; data?: unknown }[] = [];
    const fetch = vi.fn(async () => new Response("", { status: 507,
      headers: { "retry-after-ms": "1500" } })) as typeof globalThis.fetch;
    const running = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch })
      .run(request(events, controller.signal));
    await vi.waitFor(() => expect(events.some(event => event.type === "siwc.provider_retry")).toBe(true));
    controller.abort(new Error("user canceled"));
    await expect(running).rejects.toThrow("user canceled");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("finishes only on a sole passing draft receipt and still validates its exact handle", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const draftId = "123e4567-e89b-42d3-a456-426614174000";
    const sha256 = "a".repeat(64);
    const execute = vi.fn(async () => execute.mock.calls.length === 1
      ? { pass: false, draftId, sha256, errors: ["repair needed"] }
      : { pass: true, draftId, sha256, errors: [] });
    const validateOutput = vi.fn(async value => {
      expect(value).toEqual({ acceptedDraft: { draftId, sha256 } });
      return { resolved: true };
    });
    const fetch = vi.fn(async () => stream([{ type: "response.completed", response: { output: [{ type: "function_call",
      name: "validate_draft", call_id: `call-${fetch.mock.calls.length}`, arguments: "{}" }] } }]));
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: fetch as typeof globalThis.fetch, enforceJsonObject: true,
      finishOnPassingDraftTools: ["validate_draft"], validateOutput,
      tools: () => [{ name: "validate_draft", description: "validate", parameters: { type: "object" }, execute }] });
    const jsonRequest = request(events) as ReturnType<typeof request> & {
      definition: { config: { instructions: string; outputFormat: "json" } } };
    jsonRequest.definition.config = { instructions: "Write plainly", outputFormat: "json" };
    expect((await runner.run(jsonRequest)).output).toEqual({ resolved: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(validateOutput).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === "siwc.tool_result")).toHaveLength(2);
  });

  it("uses the existing technical correction path when host readiness rejects a passing receipt", async () => {
    const events: { type: string; data?: unknown }[] = [];
    const handle = { draftId: "123e4567-e89b-42d3-a456-426614174000", sha256: "a".repeat(64) };
    const validateOutput = vi.fn(async value => {
      if (validateOutput.mock.calls.length === 1) throw new Error("RESPONSES_PHASE1_UNREAD");
      expect(value).toEqual({ acceptedDraft: handle });
      return { ready: true };
    });
    const fetch = vi.fn(async () => stream([{ type: "response.completed", response: { output:
      fetch.mock.calls.length === 1
        ? [{ type: "function_call", name: "validate_draft", call_id: "call-1", arguments: "{}" }]
        : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ acceptedDraft: handle }) }] }] } }]));
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: fetch as typeof globalThis.fetch, finishOnPassingDraftTools: ["validate_draft"],
      maxOutputValidationCorrections: 1, outputValidationFeedback: async () => "Read missing evidence",
      validateOutput, tools: () => [{ name: "validate_draft", description: "validate",
        parameters: { type: "object" }, execute: async () => ({ pass: true, ...handle, errors: [] }) }] });
    const jsonRequest = request(events) as ReturnType<typeof request> & {
      definition: { config: { instructions: string; outputFormat: "json" } } };
    jsonRequest.definition.config = { instructions: "Write plainly", outputFormat: "json" };
    expect((await runner.run(jsonRequest)).output).toEqual({ ready: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(validateOutput).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === "siwc.validation_failed")).toHaveLength(1);
  });

  it("does not finalize a passing receipt in a mixed tool batch", async () => {
    const validate = vi.fn(async () => ({ pass: true, draftId: "123e4567-e89b-42d3-a456-426614174000",
      sha256: "a".repeat(64), errors: [] }));
    const other = vi.fn(async () => ({ read: true }));
    const fetch = vi.fn(async () => stream([{ type: "response.completed", response: { output:
      fetch.mock.calls.length === 1
        ? [{ type: "function_call", name: "validate_draft", call_id: "call-1", arguments: "{}" },
          { type: "function_call", name: "read_asset", call_id: "call-2", arguments: "{}" }]
        : [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] } }]));
    const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
      fetch: fetch as typeof globalThis.fetch, finishOnPassingDraftTools: ["validate_draft"],
      tools: () => [{ name: "validate_draft", description: "validate", parameters: { type: "object" }, execute: validate },
        { name: "read_asset", description: "read", parameters: { type: "object" }, execute: other }] });
    expect((await runner.run(request([]))).output).toBe("Done");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
  });

  it("times out a silent header wait and retries within the same turn", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const events: { type: string; data?: unknown }[] = [];
      const fetch = vi.fn(async () => {
        if (fetch.mock.calls.length === 1) { entered.resolve(); return await new Promise<Response>(() => {}); }
        return stream([{ type: "response.completed", response: { output: [{ type: "message",
          content: [{ type: "output_text", text: "Done" }] }] } }]);
      }) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
        fetch, headerTimeoutMs: 180, streamIdleTimeoutMs: 180, timeoutMs: 1_000 });
      const running = runner.run(request(events));
      await entered.promise;
      await vi.advanceTimersByTimeAsync(180);
      expect((await running).output).toBe("Done");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
        phase: "fetch", causeCode: "SIWC_HEADER_TIMEOUT", retrying: true });
      expect(events.filter(event => event.type === "siwc.response_headers")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("times out an idle stream after bytes and retries without replaying partial tools", async () => {
    vi.useFakeTimers();
    try {
      const firstProgress = deferred<void>();
      const events: { type: string; data?: unknown }[] = [];
      const fetch = vi.fn(async () => {
        if (fetch.mock.calls.length === 1) return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","name":"read_asset","call_id":"partial","arguments":"{}"}}\n\n')); },
        }));
        return stream([{ type: "response.completed", response: { output: [{ type: "message",
          content: [{ type: "output_text", text: "Done" }] }] } }]);
      }) as typeof globalThis.fetch;
      const execute = vi.fn(async () => ({ read: true }));
      const runRequest = request(events);
      runRequest.emit = async (type, data) => {
        events.push({ type, data });
        if (type === "siwc.stream_progress") firstProgress.resolve();
      };
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
        fetch, headerTimeoutMs: 180, streamIdleTimeoutMs: 180, timeoutMs: 1_000,
        tools: () => [{ name: "read_asset", description: "read", parameters: { type: "object" }, execute }] });
      const running = runner.run(runRequest);
      await firstProgress.promise;
      await vi.advanceTimersByTimeAsync(180);
      expect((await running).output).toBe("Done");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalled();
      expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
        phase: "stream", causeCode: "SIWC_STREAM_IDLE_TIMEOUT", retrying: true });
      expect(events.find(event => event.type === "siwc.stream_progress")?.data).toMatchObject({
        turn: 1, requestAttempt: 1, eventCount: 1, elapsedMs: 0 });
      expect(JSON.stringify(events.filter(event => event.type === "siwc.stream_progress"))).not.toContain("read_asset");
    } finally { vi.useRealTimers(); }
  });

  it("keeps an active stream alive beyond the idle limit and records content-free progress", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const headersSeen = deferred<void>();
      const events: { type: string; data?: unknown }[] = [];
      const runRequest = request(events);
      runRequest.emit = async (type, data) => {
        events.push({ type, data });
        if (type === "siwc.response_headers") headersSeen.resolve();
      };
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      }), { headers: { "x-request-id": "req_safe_active" } })) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
        fetch, headerTimeoutMs: 180, streamIdleTimeoutMs: 18_000, timeoutMs: 100_000 });
      const running = runner.run(runRequest);
      await headersSeen.promise;
      const encoder = new TextEncoder();
      await vi.advanceTimersByTimeAsync(10_000);
      streamController.enqueue(encoder.encode(": keepalive\n\n"));
      await vi.advanceTimersByTimeAsync(10_000);
      streamController.enqueue(encoder.encode(": keepalive\n\n"));
      await vi.advanceTimersByTimeAsync(10_000);
      streamController.enqueue(encoder.encode('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Done"}]}]}}\n\n'));
      expect((await running).output).toBe("Done");
      expect(fetch).toHaveBeenCalledOnce();
      expect(events.some(event => event.type === "siwc.transport_error")).toBe(false);
      expect(events.find(event => event.type === "siwc.response_headers")?.data).toMatchObject({
        status: 200, requestId: "req_safe_active" });
      expect(events.filter(event => event.type === "siwc.stream_progress")).toHaveLength(2);
      expect(JSON.stringify(events.filter(event => event.type === "siwc.stream_progress"))).not.toContain("Done");
    } finally { vi.useRealTimers(); }
  });

  it("does not retry an externally aborted request during a silent header wait", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const controller = new AbortController();
      const fetch = vi.fn(async () => { entered.resolve(); return await new Promise<Response>(() => {}); }) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" },
        fetch, headerTimeoutMs: 180, timeoutMs: 1_000 });
      const running = runner.run(request([], controller.signal));
      await entered.promise;
      controller.abort(new Error("user canceled"));
      await expect(running).rejects.toThrow("user canceled");
      expect(fetch).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("bounds an active stream by the physical POST deadline and safely retries once", async () => {
    vi.useFakeTimers();
    try {
      let firstStream!: ReadableStreamDefaultController<Uint8Array>;
      const firstHeaders = deferred<void>();
      const events: { type: string; data?: unknown }[] = [];
      const bodies: string[] = [];
      const signals: AbortSignal[] = [];
      const gate = vi.fn(async () => {});
      const execute = vi.fn(async () => ({ read: true }));
      const runRequest = request(events);
      runRequest.emit = async (type, data) => {
        events.push({ type, data });
        if (type === "siwc.response_headers" && firstHeaders) firstHeaders.resolve();
      };
      const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        bodies.push(init!.body as string);
        signals.push(init!.signal as AbortSignal);
        if (bodies.length === 1) return new Response(new ReadableStream<Uint8Array>({
          start(controller) { firstStream = controller; },
        }), { headers: { "x-request-id": "req_safe_deadline" } });
        return stream([{ type: "response.completed", response: { output: [{ type: "message",
          content: [{ type: "output_text", text: "Done" }] }],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }]);
      }) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "private-token" },
        fetch, beforeRequest: gate, requestTimeoutMs: 250, streamIdleTimeoutMs: 100,
        tools: () => [{ name: "read_asset", description: "read", parameters: { type: "object" }, execute }] });
      const running = runner.run(runRequest);
      await firstHeaders.promise;
      const keepalive = new TextEncoder().encode(": keepalive\n\n");
      for (let tick = 0; tick < 4; tick++) {
        await vi.advanceTimersByTimeAsync(50);
        firstStream.enqueue(keepalive);
      }
      await vi.advanceTimersByTimeAsync(50);
      expect((await running).output).toBe("Done");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(gate).toHaveBeenCalledTimes(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(signals[0]?.aborted).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(events.filter(event => event.type === "siwc.request")).toHaveLength(2);
      expect(events.filter(event => event.type === "siwc.response").map(event =>
        (event.data as { usage?: unknown }).usage)).toEqual([{ input_tokens: 4, output_tokens: 2, total_tokens: 6 }]);
      expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
        turn: 1, requestAttempt: 1, phase: "stream", causeCode: "SIWC_REQUEST_TIMEOUT",
        retrying: true, status: 200, requestId: "req_safe_deadline" });
      expect(events.find(event => event.type === "siwc.transport_error")?.data).not.toHaveProperty("usage");
      expect(JSON.stringify(events)).not.toContain("private-token");
    } finally { vi.useRealTimers(); }
  });

  it("applies the physical POST deadline while headers are still pending", async () => {
    vi.useFakeTimers();
    try {
      const firstEntered = deferred<void>();
      const events: { type: string; data?: unknown }[] = [];
      let firstSignal: AbortSignal | undefined;
      const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        if (fetch.mock.calls.length === 1) {
          firstSignal = init!.signal as AbortSignal;
          firstEntered.resolve();
          return await new Promise<Response>(() => {});
        }
        return stream([{ type: "response.completed", response: { output: [{ type: "message",
          content: [{ type: "output_text", text: "Done" }] }] } }]);
      }) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
        requestTimeoutMs: 100, headerTimeoutMs: 1_000 });
      const running = runner.run(request(events));
      await firstEntered.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect((await running).output).toBe("Done");
      expect(firstSignal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
        phase: "fetch", causeCode: "SIWC_REQUEST_TIMEOUT", retrying: true });
    } finally { vi.useRealTimers(); }
  });

  it("stops after two physical POST deadlines under the shared retry budget", async () => {
    vi.useFakeTimers();
    try {
      const headers = [deferred<void>(), deferred<void>()];
      const events: { type: string; data?: unknown }[] = [];
      const runRequest = request(events);
      let seenHeaders = 0;
      runRequest.emit = async (type, data) => {
        events.push({ type, data });
        if (type === "siwc.response_headers") headers[seenHeaders++]?.resolve();
      };
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({}))) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
        requestTimeoutMs: 100, streamIdleTimeoutMs: 1_000 });
      const running = runner.run(runRequest);
      const settled = running.then(value => ({ value }), error => ({ error }));
      await headers[0]!.promise;
      await vi.advanceTimersByTimeAsync(100);
      await headers[1]!.promise;
      await vi.advanceTimersByTimeAsync(100);
      const outcome = await settled;
      expect(outcome).toHaveProperty("error");
      expect((outcome as { error: Error }).error.message).toBe("SIWC_TRANSPORT_FAILURE:stream:SIWC_REQUEST_TIMEOUT");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(events.filter(event => event.type === "siwc.transport_error").map(event =>
        (event.data as { retrying: boolean; causeCode: string }).retrying)).toEqual([true, false]);
      expect(events.filter(event => event.type === "siwc.response")).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not replay a timed-out POST after visible text was emitted", async () => {
    vi.useFakeTimers();
    try {
      const textSeen = deferred<void>();
      const events: { type: string; data?: unknown }[] = [];
      const runRequest = request(events);
      runRequest.emit = async (type, data) => {
        events.push({ type, data });
        if (type === "siwc.text_delta") textSeen.resolve();
      };
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(
          'data: {"type":"response.output_text.delta","delta":"visible-fragment"}\n\n')); },
      }))) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
        requestTimeoutMs: 100, streamIdleTimeoutMs: 1_000 });
      const running = runner.run(runRequest);
      const rejected = expect(running).rejects.toThrow("SIWC_TRANSPORT_FAILURE:stream:SIWC_REQUEST_TIMEOUT");
      await textSeen.promise;
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(fetch).toHaveBeenCalledOnce();
      expect(events.find(event => event.type === "siwc.transport_error")?.data).toMatchObject({
        causeCode: "SIWC_REQUEST_TIMEOUT", retrying: false });
      expect(JSON.stringify(events.filter(event => event.type === "siwc.transport_error"))).not.toContain("visible-fragment");
    } finally { vi.useRealTimers(); }
  });

  it("preserves external cancellation ahead of the per-POST deadline", async () => {
    vi.useFakeTimers();
    try {
      const headers = deferred<void>();
      const host = new AbortController();
      const events: { type: string; data?: unknown }[] = [];
      const runRequest = request(events, host.signal);
      runRequest.emit = async (type, data) => {
        events.push({ type, data });
        if (type === "siwc.response_headers") headers.resolve();
      };
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({}))) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
        requestTimeoutMs: 100, streamIdleTimeoutMs: 1_000 });
      const running = runner.run(runRequest);
      await headers.promise;
      host.abort(new Error("user canceled"));
      await expect(running).rejects.toThrow("user canceled");
      await vi.advanceTimersByTimeAsync(200);
      expect(fetch).toHaveBeenCalledOnce();
      expect(events.filter(event => event.type === "siwc.transport_error")).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("clears the deadline at response.completed before slow progress logging", async () => {
    vi.useFakeTimers();
    try {
      const progressEntered = deferred<void>();
      const releaseProgress = deferred<void>();
      const events: { type: string; data?: unknown }[] = [];
      const runRequest = request(events);
      runRequest.emit = async (type, data) => {
        events.push({ type, data });
        if (type === "siwc.stream_progress") { progressEntered.resolve(); await releaseProgress.promise; }
      };
      let postSignal: AbortSignal | undefined;
      const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        postSignal = init!.signal as AbortSignal;
        const bytes = new TextEncoder().encode('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Done"}]}]}}\n\n');
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(bytes); controller.close();
        } }));
      }) as typeof globalThis.fetch;
      const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "token" }, fetch,
        requestTimeoutMs: 100 });
      const running = runner.run(runRequest);
      await progressEntered.promise;
      await vi.advanceTimersByTimeAsync(200);
      expect(postSignal?.aborted).toBe(false);
      releaseProgress.resolve();
      expect((await running).output).toBe("Done");
      expect(fetch).toHaveBeenCalledOnce();
      expect(events.filter(event => event.type === "siwc.transport_error")).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
