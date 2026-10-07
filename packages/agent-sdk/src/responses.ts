import { createHash } from "node:crypto";
import type { AgentRunRequest, AgentRunResult, AgentRunner } from "@signal-room/workflow";
import { artifactPayloadSha256 } from "@signal-room/workflow";
import type { SiwcAuth } from "./auth.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

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
  execute(args: Json, signal: AbortSignal): Promise<Json>;
}

export interface SiwcRunnerOptions {
  auth: Pick<SiwcAuth, "accessToken">;
  /** Tool set is supplied by the harness for this exact attempt; definitions cannot grant tools. */
  tools?: (request: AgentRunRequest<unknown>) => readonly SiwcTool[] | Promise<readonly SiwcTool[]>;
  maxTurns?: number;
  maxToolCalls?: number;
  fetch?: typeof fetch;
}

/** Bounded SIWC Responses tool runner. This is not an OpenAI Agents SDK adapter. */
export class SiwcResponsesRunner implements AgentRunner {
  private readonly http: typeof fetch;
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  constructor(private readonly options: SiwcRunnerOptions) {
    this.http = options.fetch ?? fetch;
    this.maxTurns = positiveLimit(options.maxTurns ?? 8, "maxTurns");
    this.maxToolCalls = positiveLimit(options.maxToolCalls ?? 16, "maxToolCalls");
  }

  async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    if (request.signal.aborted) throw new Error("Agent run canceled");
    const token = await this.options.auth.accessToken();
    const tools = [...(await this.options.tools?.(request as AgentRunRequest<unknown>) ?? [])];
    const names = new Set<string>();
    for (const tool of tools) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name)) throw new Error("Invalid or duplicate SIWC tool name");
      names.add(tool.name);
    }
    const instructions = request.definition.config?.instructions;
    if (instructions !== undefined && typeof instructions !== "string") throw new Error("Agent instructions must be a string");
    const outputFormat = request.definition.config?.outputFormat;
    if (outputFormat !== undefined && outputFormat !== "text" && outputFormat !== "json") throw new Error("Unsupported outputFormat");
    const effort = request.definition.reasoningEffort;
    if (!/^(none|minimal|low|medium|high|xhigh)$/.test(effort)) throw new Error("Unsupported reasoning effort for SIWC Responses");
    const input: ResponseItem[] = [];
    // Snapshot the actual harness tool definitions after its attempt-specific callback.
    // Reuse that snapshot in the provider request and evidence; Agent definitions cannot supply it.
    const toolDefinitions = tools.map(({ name, description, parameters }) =>
      structuredClone({ name, description, parameters }));
    if (toolDefinitions.length) input.push({ type: "additional_tools", role: "developer",
      tools: toolDefinitions.map(tool => ({ type: "function", ...tool })) });
    input.push({ role: "user", content: typeof request.input === "string" ? request.input : JSON.stringify(request.input) });
    await request.emit("siwc.started", { model: request.definition.model, instructions: instructions ?? "",
      toolNames: toolDefinitions.map(tool => tool.name), toolDefinitions,
      toolProfileHash: await artifactPayloadSha256(toolDefinitions),
      contextHash: sha(JSON.stringify(request.input)) });
    let calls = 0;
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      if (request.signal.aborted) throw new Error("Agent run canceled");
      const body = { model: request.definition.model, input, instructions, reasoning: { effort }, store: false, stream: true };
      await request.emit("siwc.request", { turn, inputItems: input.length });
      const response = await this.http(RESPONSES_URL, { method: "POST", signal: request.signal, headers: {
        "authorization": `Bearer ${token}`, "content-type": "application/json", "accept": "text/event-stream",
      }, body: JSON.stringify(body) });
      if (!response.ok) {
        const requestId = safeField(response.headers.get("x-request-id"), /^[a-zA-Z0-9_-]{1,128}$/);
        await request.emit("siwc.provider_error", { eventType: "http.error", status: response.status, ...(requestId ? { requestId } : {}) });
        throw new Error(`SIWC Responses request failed (${response.status}); requestId=${requestId ?? "unknown"}`);
      }
      const completed = await consumeEvents(response, request);
      const items = completed.output ?? [];
      const textParts: string[] = [];
      for (const item of items) {
        if (item.type !== "message" || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && typeof part === "object" && part.type === "output_text" && typeof part.text === "string") textParts.push(part.text);
        }
      }
      const text = textParts.join("");
      const visibleOutput: Record<string, unknown>[] = [];
      for (const item of items) {
        if (item.type === "message") visibleOutput.push({ type: "message", id: item.id, role: item.role,
          content: Array.isArray(item.content) ? item.content.filter((part): part is { type: string; text?: string } =>
            !!part && typeof part === "object" && (part as { type?: string }).type === "output_text")
            .map((part) => ({ type: part.type, text: part.text })) : [] });
        if (item.type === "function_call") visibleOutput.push({ type: "function_call", id: item.id, name: item.name,
          callId: item.call_id, arguments: item.arguments });
      }
      await request.emit("siwc.response", { turn, responseId: completed.id, outputItems: items.length,
        visibleOutput, usage: completed.usage, textHash: sha(text) });
      const pending = items.filter((item) => item.type === "function_call");
      if (!pending.length) {
        if (!text) throw new Error("SIWC response completed without text or tool calls");
        const output = outputFormat === "json" ? JSON.parse(text) as Output : text as Output;
        return { output, validation: "pending", metadata: { provider: "siwc-responses", model: request.definition.model,
          responseId: completed.id, turns: turn, toolCalls: calls } };
      }
      if (calls + pending.length > this.maxToolCalls || turn === this.maxTurns) throw new Error("SIWC tool or turn limit exceeded before execution");
      input.push(...items);
      for (const item of pending) {
        const name = item.name;
        const callId = item.call_id;
        if (typeof name !== "string" || typeof callId !== "string" || typeof item.arguments !== "string") throw new Error("Malformed SIWC function call");
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`SIWC requested unauthorized tool: ${name}`);
        const args = JSON.parse(item.arguments) as Json;
        calls++;
        await request.emit("siwc.tool_call", { turn, name, callId, arguments: args, argumentsHash: sha(item.arguments) });
        let result: Json;
        try { result = await tool.execute(args, request.signal); }
        catch (error) {
          await request.emit("siwc.tool_failed", { turn, name, callId, outcomeUnknown: true });
          throw error;
        }
        if (request.signal.aborted) throw new Error("Agent run canceled");
        const output = JSON.stringify(result);
        if (output === undefined) throw new Error(`SIWC tool ${name} returned a non-JSON result`);
        await request.emit("siwc.tool_result", { turn, name, callId, output: result, outputHash: sha(output) });
        input.push({ type: "function_call_output", call_id: callId, output });
      }
    }
    throw new Error("SIWC turn limit exceeded");
  }
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

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
