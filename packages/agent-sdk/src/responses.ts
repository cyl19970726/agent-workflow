import { createHash } from "node:crypto";
import { Agent, Runner, tool as sdkTool, Usage,
  type AgentInputItem, type AgentOutputItem, type Model, type ModelRequest, type ModelResponse, type StreamEventResponseCompleted } from "@openai/agents";
import type { AgentRunRequest, AgentRunResult, AgentRunner } from "@signal-room/workflow";
import { artifactPayloadSha256 } from "@signal-room/workflow";
import type { SiwcAuth } from "./auth.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const JSON_OBJECT_REQUIREMENT = "The final response must be a valid JSON object.";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ResponseItem = Record<string, unknown>;
type Completed = { id?: string; output?: ResponseItem[]; usage?: Record<string, unknown> };
type ProviderFailure = { code?: unknown; type?: unknown; param?: unknown; request_id?: unknown };

/** Provider identifiers only. Never persist free-form messages, headers or response bodies as diagnostics. */
function safeField(value: unknown, pattern = /^[a-z][a-z0-9_]{0,63}$/): string | undefined {
  return typeof value === "string" && pattern.test(value) && !/^(?:sk|rk|pk|sess|bearer)[-_]/i.test(value) ? value : undefined;
}

function safeProviderFailure(eventType: string, response: Response, event: {
  code?: unknown; param?: unknown; request_id?: unknown; error?: ProviderFailure;
  response?: { id?: unknown; error?: ProviderFailure; incomplete_details?: { reason?: unknown } };
}): Record<string, string> {
  const failure = event.response?.error ?? event.error;
  const result: Record<string, string> = { eventType };
  const code = safeField(failure?.code ?? event.code);
  const providerType = safeField(failure?.type);
  const param = safeField(failure?.param ?? event.param, /^[a-zA-Z0-9_.\[\]-]{1,128}$/);
  const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
  const requestId = safeField(failure?.request_id, identifier) ?? safeField(event.request_id, identifier) ?? safeField(response.headers.get("x-request-id"), identifier);
  const responseId = safeField(event.response?.id, identifier);
  const reason = safeField(event.response?.incomplete_details?.reason);
  if (code) result.code = code;
  if (providerType) result.providerType = providerType;
  if (param) result.param = param;
  if (requestId) result.requestId = requestId;
  if (responseId) result.responseId = responseId;
  if (reason) result.reason = reason;
  return result;
}

export interface SiwcTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** The host binds this to the current node's restricted storage/tools. */
  execute(args: Json, signal: AbortSignal): Promise<Json | SiwcVisualToolResult>;
}

/** A visual tool supplies actual image pixels to the next Responses turn, never a path or OCR substitute. */
export interface SiwcImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
  detail?: "low" | "high" | "auto" | "original";
}
export interface SiwcVisualToolResult {
  kind: "siwc_visual_tool_result";
  value: Json;
  images: readonly SiwcImage[];
}

export interface SiwcRunnerOptions {
  auth: Pick<SiwcAuth, "accessToken">;
  /** Tool set is supplied by the harness for this exact attempt; definitions cannot grant tools. */
  tools?: (request: AgentRunRequest<unknown>) => readonly SiwcTool[] | Promise<readonly SiwcTool[]>;
  /** Optional, attempt-bound visual inputs. The selected SIWC model must support images. */
  images?: (request: AgentRunRequest<unknown>) => readonly SiwcImage[] | Promise<readonly SiwcImage[]>;
  maxTurns?: number;
  maxToolCalls?: number;
  /** Opt into Responses JSON object mode for JSON outputs; other consumers retain legacy parsing. */
  enforceJsonObject?: boolean;
  timeoutMs?: number;
  validateOutput?: (output: unknown, request: AgentRunRequest<unknown>) => unknown | Promise<unknown>;
  /** Optional same-session technical correction; omitted consumers retain fail-fast behavior. */
  maxOutputValidationCorrections?: number;
  /** Only this callback may supply safe, structured validation values for durable trace events. */
  outputValidationFeedback?: (error: unknown, request: AgentRunRequest<unknown>) => string | SiwcValidationFeedback | null | Promise<string | SiwcValidationFeedback | null>;
  /** Durable aggregate reservation gate, invoked after the request event and immediately before every provider POST. */
  beforeRequest?: (input:{request:AgentRunRequest<unknown>;turn:number;kind:'original'|'tool-continuation'|'technical-repair'})=>Promise<void>;
  fetch?: typeof fetch;
}

export interface SiwcValidationFeedback {
  message:string;
  validationError:{issues:readonly {path:string;value:Json;expected?:string}[]};
}

const SDK_RUNTIME = { runtime: "openai-agents-sdk", sdkPackage: "@openai/agents", sdkVersion: "0.20.0" } as const;

/** Official SDK owns the agent/tool loop; SIWC is only the model transport. */
export class OpenAIAgentsSdkRunner implements AgentRunner {
  private readonly http: typeof fetch;
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly maxOutputValidationCorrections: number;
  constructor(private readonly options: SiwcRunnerOptions) {
    this.http = options.fetch ?? fetch;
    this.maxTurns = positiveLimit(options.maxTurns ?? 8, "maxTurns");
    this.maxToolCalls = positiveLimit(options.maxToolCalls ?? 16, "maxToolCalls");
    const corrections = options.maxOutputValidationCorrections ?? 0;
    if (!Number.isSafeInteger(corrections) || corrections < 0 || corrections > 3) throw new Error("Invalid SIWC maxOutputValidationCorrections");
    this.maxOutputValidationCorrections = corrections;
  }

  async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    const timeoutMs = this.options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("Invalid SIWC timeoutMs");
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason ?? new Error("Agent run canceled"));
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error("SIWC_RUN_TIMEOUT")), timeoutMs);
    const scopedRequest: AgentRunRequest<Input> = { ...request, signal: controller.signal,
      emit: async (type, data) => awaitWithAbort(controller.signal, () => request.emit(type, data)) };
    try { return await awaitWithAbort(controller.signal, () => this.runWithSignal(scopedRequest)); }
    catch (error) { if (controller.signal.aborted) throw controller.signal.reason ?? error; throw error; }
    finally { if (timer) clearTimeout(timer); request.signal.removeEventListener("abort", onAbort); }
  }

  private async runWithSignal<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    if (request.signal.aborted) throw request.signal.reason ?? new Error("Agent run canceled");
    const token = await awaitWithAbort(request.signal, () => this.options.auth.accessToken());
    const tools = [...(await awaitWithAbort(request.signal, () => this.options.tools?.(request as AgentRunRequest<unknown>) ?? []) ?? [])];
    const names = new Set<string>();
    for (const tool of tools) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name)) throw new Error("Invalid or duplicate SIWC tool name");
      names.add(tool.name);
    }
    const configuredInstructions = request.definition.config?.instructions;
    if (configuredInstructions !== undefined && typeof configuredInstructions !== "string") throw new Error("Agent instructions must be a string");
    const outputFormat = request.definition.config?.outputFormat;
    if (outputFormat !== undefined && outputFormat !== "text" && outputFormat !== "json") throw new Error("Unsupported outputFormat");
    const jsonObjectMode = outputFormat === "json" && this.options.enforceJsonObject === true;
    const instructions = jsonObjectMode && !/json/i.test(configuredInstructions ?? "")
      ? `${configuredInstructions?.trim() ? `${configuredInstructions}\n\n` : ""}${JSON_OBJECT_REQUIREMENT}`
      : configuredInstructions;
    const effort = request.definition.reasoningEffort;
    if (!/^(none|minimal|low|medium|high|xhigh)$/.test(effort)) throw new Error("Unsupported reasoning effort for SIWC Responses");
    const toolDefinitions = tools.map(({ name, description, parameters }) =>
      structuredClone({ name, description, parameters }));
    const images = [...(await awaitWithAbort(request.signal, () => this.options.images?.(request as AgentRunRequest<unknown>) ?? []) ?? [])];
    const userText = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
    let history: AgentInputItem[] = [{ role: "user", content: images.length ? [
      { type: "input_text", text: userText }, ...images.map(image => {
        validateImage(image);
        return { type: "input_image" as const, image: `data:${image.mimeType};base64,${image.base64}`, detail: image.detail ?? "auto" };
      })
    ] : userText }];
    await request.emit("siwc.started", { ...SDK_RUNTIME, model: request.definition.model, instructions: instructions ?? "",
      ...(jsonObjectMode ? { jsonObjectInputRequirement: JSON_OBJECT_REQUIREMENT } : {}),
      toolNames: toolDefinitions.map(tool => tool.name), toolDefinitions,
      toolProfileHash: await artifactPayloadSha256(toolDefinitions),
      contextHash: sha(JSON.stringify(request.input)), imageHashes: images.map(image => imageHash(image)) });
    let calls = 0;
    let turns = 0;
    let corrections = 0;
    let responseId: string | undefined;
    let nextKind: 'original' | 'tool-continuation' | 'technical-repair' = 'original';
    // Preserve opaque provider items only in memory for stateless continuation, never in trace.
    const rawItems = new Map<string, ResponseItem>();
    const visualResults = new Map<string, readonly SiwcImage[]>();
    const boundTools = tools.map(bound => sdkTool({
      name: bound.name, description: bound.description, strict: false,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: true, ...bound.parameters } as {
        type: "object"; properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: true;
      },
      errorFunction: null,
      execute: async (args, _context, details) => {
        request.signal.throwIfAborted();
        const callId = details?.toolCall?.callId;
        if (!callId) throw new Error("Missing SDK tool call identity");
        const argumentsText = details.toolCall!.arguments;
        calls++;
        await request.emit("siwc.tool_call", { turn: turns, name: bound.name, callId,
          arguments: args, argumentsHash: sha(argumentsText) });
        let result: Json | SiwcVisualToolResult;
        try { result = await awaitWithAbort(request.signal, () => bound.execute(args as Json, request.signal)); }
        catch (error) {
          await request.emit("siwc.tool_failed", { turn: turns, name: bound.name, callId, outcomeUnknown: true });
          throw error;
        }
        request.signal.throwIfAborted();
        const visual = isVisualResult(result) ? result : undefined;
        const value = visual ? visual.value : result;
        const output = JSON.stringify(value);
        if (output === undefined) throw new Error(`SIWC tool ${bound.name} returned a non-JSON result`);
        await request.emit("siwc.tool_result", { turn: turns, name: bound.name, callId, output: value, outputHash: sha(output),
          ...(visual ? { imageHashes: visual.images.map(image => imageHash(image)) } : {}) });
        // The SDK owns result/history ordering. The transport expands this call's images
        // next to its result; paths and OCR are never substituted for pixels.
        if (visual) visualResults.set(callId, visual.images);
        return output;
      }
    }));
    const model: Model = {
      getResponse: async (modelRequest: ModelRequest): Promise<ModelResponse> => {
        request.signal.throwIfAborted();
        if (++turns > this.maxTurns) throw new Error("SIWC turn limit exceeded");
        const input: ResponseItem[] = [];
        if (toolDefinitions.length) input.push({ type: "additional_tools", role: "developer",
          tools: toolDefinitions.map(tool => ({ type: "function", ...tool })) });
        if (jsonObjectMode) input.push({ role: "developer", content: JSON_OBJECT_REQUIREMENT });
        const sdkInput = typeof modelRequest.input === "string"
          ? [{ role: "user" as const, content: modelRequest.input }] : modelRequest.input;
        for (const item of sdkInput) input.push(...toWireInput(item, rawItems, visualResults));
        const body = { model: request.definition.model, input, instructions: modelRequest.systemInstructions,
          reasoning: { effort }, store: false, stream: true,
          ...(jsonObjectMode ? { text: { format: { type: "json_object" as const } } } : {}) };
        await request.emit("siwc.request", { ...SDK_RUNTIME, turn: turns, inputItems: input.length });
        await awaitWithAbort(request.signal, () => this.options.beforeRequest?.({ request: request as AgentRunRequest<unknown>, turn: turns, kind: nextKind }));
        request.signal.throwIfAborted();
        const response = await this.http(RESPONSES_URL, { method: "POST", signal: modelRequest.signal ?? request.signal, headers: {
          "authorization": `Bearer ${token}`, "content-type": "application/json", "accept": "text/event-stream",
        }, body: JSON.stringify(body) });
        if (!response.ok) {
          const requestId = safeField(response.headers.get("x-request-id"), /^[a-zA-Z0-9_-]{1,128}$/);
          await request.emit("siwc.provider_error", { eventType: "http.error", status: response.status, ...(requestId ? { requestId } : {}) });
          throw new Error(`SIWC Responses request failed (${response.status}); requestId=${requestId ?? "unknown"}`);
        }
        const completed = await consumeEvents(response, request);
        responseId = completed.id;
        const items = completed.output ?? [];
        const visibleOutput = items.flatMap(item => {
          if (item.type === "message") return [{ type: "message", id: item.id, role: item.role,
            content: Array.isArray(item.content) ? item.content.filter(part => part?.type === "output_text")
              .map(part => ({ type: part.type, text: part.text })) : [] } as Record<string, unknown>];
          if (item.type === "function_call") return [{ type: "function_call", id: item.id, name: item.name,
            callId: item.call_id, arguments: item.arguments }];
          return [];
        });
        const text = items.flatMap(item => item.type === "message" && Array.isArray(item.content)
          ? item.content.filter(part => part?.type === "output_text").map(part => part.text) : []).join("");
        await request.emit("siwc.response", { turn: turns, responseId: completed.id, outputItems: items.length,
          visibleOutput, usage: completed.usage, textHash: sha(text) });
        const pending = items.filter(item => item.type === "function_call");
        if (pending.length && (calls + pending.length > this.maxToolCalls || turns === this.maxTurns))
          throw new Error("SIWC tool or turn limit exceeded before execution");
        // Validate the entire batch before SDK dispatch so a malformed later call cannot
        // execute an earlier side effect. The SDK, not this adapter, dispatches the tools.
        for (const item of pending) {
          if (typeof item.name !== "string" || typeof item.call_id !== "string" || typeof item.arguments !== "string")
            throw new Error("Malformed SIWC function call");
          if (!names.has(item.name)) throw new Error(`SIWC requested unauthorized tool: ${item.name}`);
          JSON.parse(item.arguments);
        }
        if (!pending.length && !text) throw new Error("SIWC response completed without text or tool calls");
        nextKind = 'tool-continuation';
        return { responseId: completed.id, usage: new Usage({ ...completed.usage, requests: 1 }),
          output: items.map((item, index) => toSdkOutput(item, `${turns}:${index}`, rawItems)) };
      },
      async *getStreamedResponse(modelRequest) {
        const response = await this.getResponse(modelRequest);
        yield { type: "response_done", response: { ...response, id: response.responseId ?? "", usage: response.usage,
          output: response.output as StreamEventResponseCompleted["response"]["output"] } };
      }
    };
    const agent = new Agent({ name: request.definition.id, instructions, model, tools: boundTools });
    // Workflow events remain in PostgreSQL. Do not enable an implicit second cloud trace export
    // or the SDK's default API-key provider on this explicitly SIWC-authorized route.
    const runner = new Runner({ tracingDisabled: true, toolExecution: { maxFunctionToolConcurrency: 1 } });
    for (;;) {
      const result = await runner.run(agent, history, { signal: request.signal, maxTurns: this.maxTurns - turns });
      request.signal.throwIfAborted();
      const text = result.finalOutput;
      if (typeof text !== "string" || !text) throw new Error("SDK run completed without final text");
      try {
        const parsed = outputFormat === "json" ? JSON.parse(text) : text;
        const output = this.options.validateOutput
          ? await awaitWithAbort(request.signal, () => this.options.validateOutput!(parsed, request as AgentRunRequest<unknown>)) as Output
          : parsed as Output;
        return { output, validation: this.options.validateOutput ? "valid" : "pending", metadata: {
          ...SDK_RUNTIME, provider: "siwc-responses", model: request.definition.model,
          responseId, turns, toolCalls: calls, outputValidationCorrections: corrections } };
      } catch (error) {
        request.signal.throwIfAborted();
        if (!this.options.outputValidationFeedback || corrections >= this.maxOutputValidationCorrections || turns >= this.maxTurns) throw error;
        const feedback = await awaitWithAbort(request.signal, () => this.options.outputValidationFeedback!(error, request as AgentRunRequest<unknown>));
        request.signal.throwIfAborted();
        const message = typeof feedback === 'string' ? feedback : feedback?.message;
        if (!message?.trim()) throw error;
        corrections++;
        await request.emit("siwc.validation_failed", { turn: turns, correction: corrections,
          failureKind: error instanceof SyntaxError ? "json_parse" : "output_validation" });
        let repairMessage = message;
        if (feedback !== null && typeof feedback === 'object' && feedback.validationError) {
          const issues = feedback.validationError.issues;
          if (!Array.isArray(issues) || issues.length > 32 || issues.some(issue => typeof issue.path !== 'string' || issue.path.length > 256 ||
            (issue.expected !== undefined && (typeof issue.expected !== 'string' || issue.expected.length > 256)) ||
            JSON.stringify(issue.value)?.length > 2048)) throw new Error('Invalid safe SIWC validation feedback');
          const safeIssues = structuredClone(issues);
          await request.emit("siwc.validation_error", { turn: turns, correction: corrections, issues: safeIssues });
          repairMessage += `\n\nValidation issues (safe values):\n${JSON.stringify({ issues: safeIssues })}`;
        }
        // Only a final domain/JSON rejection starts another bounded SDK run, using SDK history.
        // There is no hand-written model/tool dispatch loop here.
        history = [...result.history, { role: "user", content: repairMessage }];
        nextKind = 'technical-repair';
      }
    }
  }
}

function toSdkOutput(item: ResponseItem, key: string, rawItems: Map<string, ResponseItem>): AgentOutputItem {
  rawItems.set(key, item);
  const providerData = { siwcItemKey: key };
  if (item.type === "message") return { type: "message", role: "assistant", status: "completed", providerData,
    content: (Array.isArray(item.content) ? item.content : []).filter(part => part?.type === "output_text" && typeof part.text === "string")
      .map(part => ({ type: "output_text", text: part.text })) };
  if (item.type === "function_call") return { type: "function_call", callId: String(item.call_id), name: String(item.name),
    arguments: String(item.arguments), providerData };
  if (item.type === "reasoning") return { type: "reasoning", content: [], providerData };
  throw new Error(`Unsupported SIWC response item: ${safeField(item.type) ?? "unknown"}`);
}

function toWireInput(item: AgentInputItem, rawItems: Map<string, ResponseItem>, images: Map<string, readonly SiwcImage[]>): ResponseItem[] {
  const key = item.providerData?.siwcItemKey;
  if (typeof key === "string" && rawItems.has(key)) return [rawItems.get(key)!];
  if (item.type === "function_call_result") {
    const output = typeof item.output === "string" ? item.output
      : !Array.isArray(item.output) && item.output.type === "text" ? item.output.text : undefined;
    if (output === undefined) throw new Error("Unsupported SDK tool result for SIWC");
    const result: ResponseItem[] = [{ type: "function_call_output", call_id: item.callId, output }];
    const pixels = images.get(item.callId);
    if (pixels?.length) result.push({ role: "user", content: [
      { type: "input_text", text: `Images returned by ${item.name} for call ${item.callId}. Inspect their pixels directly.` },
      ...pixels.map(imageContent)
    ] });
    return result;
  }
  if ('role' in item && (item.role === "user" || item.role === "system")) {
    const content = typeof item.content === "string" ? item.content : item.content.map(part => {
      if (part.type === "input_image") return { type: "input_image", image_url: part.image, detail: part.detail ?? "auto" };
      if (part.type === "input_text") return { type: "input_text", text: part.text };
      throw new Error("Unsupported SDK input content for SIWC");
    });
    return [{ role: item.role === "system" ? "developer" : item.role, content }];
  }
  throw new Error("Unsupported SDK history item for SIWC");
}

function imageHash(image: SiwcImage): string {
  validateImage(image);
  return sha(`${image.mimeType}:${image.base64}`);
}
function imageContent(image: SiwcImage): ResponseItem {
  validateImage(image);
  return { type: "input_image", image_url: `data:${image.mimeType};base64,${image.base64}`,
    detail: image.detail ?? "auto" };
}
function validateImage(image: SiwcImage): void {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64) || image.base64.length > 20_000_000 || image.base64.length % 4 !== 0) {
    throw new Error("Invalid SIWC image payload");
  }
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) throw new Error("Unsupported SIWC image type");
}
function isVisualResult(value: Json | SiwcVisualToolResult): value is SiwcVisualToolResult {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && value.kind === "siwc_visual_tool_result" && Array.isArray(value.images);
}

async function consumeEvents<Input>(response: Response, request: AgentRunRequest<Input>): Promise<Completed> {
  if (!response.body) throw new Error("SIWC response has no stream");
  let buffer = "";
  let complete: Completed | undefined;
  let bytes = 0;
  const output = new Map<number, ResponseItem>();
  const textDeltas = new Map<string, string>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_000_000) throw new Error("SIWC response exceeded stream byte limit");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data) as { type?: string; delta?: string; text?: string; arguments?: string;
          output_index?: number; content_index?: number; item_id?: string; item?: ResponseItem;
          code?: unknown; param?: unknown; request_id?: unknown; error?: ProviderFailure;
          response?: Completed & { error?: ProviderFailure; incomplete_details?: { reason?: unknown } } };
        if (event.type === "response.output_item.added" && Number.isInteger(event.output_index) && event.item) {
          output.set(event.output_index!, event.item);
        }
        if (event.type === "response.output_item.done" && Number.isInteger(event.output_index) && event.item) {
          output.set(event.output_index!, event.item);
        }
        if (event.type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
          const index = event.output_index ?? [...output.entries()].find(([, item]) => item.id === event.item_id)?.[0];
          if (index !== undefined) output.set(index, { ...output.get(index), type: "function_call", arguments: event.arguments });
        }
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
          textDeltas.set(key, (textDeltas.get(key) ?? "") + event.delta);
          await request.emit("siwc.text_delta", { text: event.delta });
        }
        if (event.type === "response.output_text.done" && typeof event.text === "string") {
          const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
          textDeltas.set(key, event.text);
        }
        if (event.type === "response.completed") complete = event.response;
        if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
          const failure = safeProviderFailure(event.type, response, event);
          await request.emit("siwc.provider_error", failure);
          const reason = failure.code ?? failure.reason ?? "unknown";
          throw new Error(`SIWC ${event.type === "error" ? "stream error" : event.type === "response.failed" ? "response failed" : "response incomplete"}: ${reason}`);
        }
      }
    }
  } finally { reader.releaseLock(); }
  if (!complete) throw new Error("SIWC stream ended without response.completed");
  if (!complete.output?.length) {
    const assembled = [...output.entries()].sort(([a], [b]) => a - b).map(([index, item]) => {
      if (item.type !== "message" || (Array.isArray(item.content) && item.content.length)) return item;
      const content = [...textDeltas.entries()].filter(([key]) => key.startsWith(`${index}:`))
        .sort(([a], [b]) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
        .map(([, text]) => ({ type: "output_text", text }));
      return content.length ? { ...item, content } : item;
    });
    if (!assembled.length && textDeltas.size) assembled.push({ type: "message", role: "assistant", content:
      [...textDeltas.values()].map((text) => ({ type: "output_text", text })) });
    complete.output = assembled;
  }
  return complete;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error(`${name} must be 1..100`);
  return value;
}

function awaitWithAbort<T>(signal: AbortSignal, start: () => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error("Agent run canceled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    let value: T | PromiseLike<T>;
    try { value = start(); }
    catch (error) { cleanup(); reject(error); return; }
    Promise.resolve(value).then((result) => {
      cleanup();
      if (signal.aborted) reject(signal.reason ?? new Error("Agent run canceled"));
      else resolve(result);
    }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
