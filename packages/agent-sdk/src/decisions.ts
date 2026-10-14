import type OpenAI from "openai";
import { defineDecision, DecisionProtocolError, type DecisionAnswer, type DecisionQuestion, type DecisionRunRequest,
  type DecisionResult, type DecisionRunner } from "@signal-room/workflow";

export type DecisionClient = Pick<OpenAI, "decisions">;
type WireQuestion = Parameters<DecisionClient["decisions"]["create"]>[0]["questions"][number];
export interface OpenAIDecisionsRunnerOptions { readonly client: DecisionClient }

/** No ambient credential lookup: the host must inject a separately authorized OpenAI client. */
export class OpenAIDecisionsRunner implements DecisionRunner {
  readonly provider = "openai";
  readonly revision = "openai-decisions-v1";

  private readonly client: DecisionClient;

  constructor(options: OpenAIDecisionsRunnerOptions) { this.client = options.client; }

  async run(request: DecisionRunRequest): Promise<DecisionResult> {
    const { definition, input } = request;
    if (definition.provider !== this.provider || definition.model !== "gpt-6-luna") {
      throw new Error("OpenAI Decisions requires provider openai and model gpt-6-luna");
    }
    defineDecision(definition);
    if (typeof input.text !== "string") throw new Error("Decisions requires text");
    for (const question of definition.questions) {
      if (question.type === "choice" && (question.choices.length < 2 || question.choices.length > 255)) {
        throw new Error("Decisions choice questions require 2 to 255 options");
      }
    }
    if (input.images && (input.images.length > 128 || input.images.some((image) =>
      !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl) ||
      (image.detail !== undefined && !["low", "high", "auto"].includes(image.detail)) ||
      (image.label !== undefined && typeof image.label !== "string")))) {
      throw new Error("Decisions images must be inline base64 data URLs (maximum 128)");
    }
    const questions: WireQuestion[] = definition.questions.map((question) => {
      if (!question.name?.trim() || !question.instructions?.trim()) throw new Error("Invalid Decisions question");
      if (question.type === "predicate") return { type: "predicate", name: question.name, instructions: question.instructions };
      if (question.type === "choice") return { type: "choice", name: question.name, instructions: question.instructions,
        choices: question.choices.map((choice: Extract<DecisionQuestion, { type: "choice" }>["choices"][number]) => ({ ...choice })) };
      if (question.type === "score") return { type: "score", name: question.name, instructions: question.instructions,
        levels: question.levels.map((level: Extract<DecisionQuestion, { type: "score" }>["levels"][number]) => ({ ...level })) };
      throw new Error("Unknown Decisions question type");
    });
    const wireInput = input.images?.length ? [{ role: "user" as const, content: [
      { type: "input_text" as const, text: input.text },
      ...input.images.flatMap((image) => [
        ...(image.label ? [{ type: "input_text" as const, text: image.label }] : []),
        { type: "input_image" as const, image_url: image.dataUrl,
          ...(image.detail ? { detail: image.detail } : {}) }
      ])
    ] }] : input.text;

    request.signal.throwIfAborted();
    const started = performance.now();
    try {
      const { data, request_id } = await this.client.decisions.create({ model: definition.model, input: wireInput,
        questions }, { signal: request.signal, timeout: definition.timeoutMs, maxRetries: 0 }).withResponse();
      if (!data || data.model !== definition.model || !Array.isArray(data.answers)
        || data.answers.length !== definition.questions.length) {
        throw new DecisionProtocolError();
      }
      const answers: DecisionAnswer[] = data.answers.map((answer, index) => {
        const expected = definition.questions[index]!;
        if (!answer || typeof answer !== "object" || answer.name !== expected.name
          || (answer.type !== expected.type && answer.type !== "refusal")) {
          throw new DecisionProtocolError();
        }
        if (answer.type === "predicate") return { type: "predicate", name: expected.name, probability: answer.probability };
        if (answer.type === "choice") {
          if (!validWireProbabilities(answer.probabilities)) throw new DecisionProtocolError();
          return { type: "choice", name: expected.name, choice: answer.choice,
          confidence: answer.confidence, probabilities: answer.probabilities.map(({ value, probability }) => ({ value, probability })) };
        }
        if (answer.type === "score") {
          if (!validWireProbabilities(answer.probabilities)) throw new DecisionProtocolError();
          return { type: "score", name: expected.name, score: answer.score,
          confidence: answer.confidence, probabilities: answer.probabilities.map(({ label, value, probability }) => ({ label, value, probability })) };
        }
        return { type: "refusal", name: expected.name };
      });
      const rawUsage = data.usage;
      if (rawUsage && (![rawUsage.input_tokens, rawUsage.output_tokens, rawUsage.total_tokens]
        .every((value) => Number.isSafeInteger(value) && value >= 0))) throw new DecisionProtocolError();
      const result: DecisionResult = { provider: this.provider, model: data.model, answers,
        usage: rawUsage && { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens,
          totalTokens: rawUsage.total_tokens }, ...(safeRequestId(request_id) ? { requestId: safeRequestId(request_id) } : {}) };
      await request.emit("decision.inference.response", { provider: this.provider, revision: this.revision, model: data.model,
        requestId: result.requestId, elapsedMs: Math.round(performance.now() - started), usage: result.usage,
        answerTypes: answers.map((answer) => answer.type) });
      return result;
    } catch (error) {
      const status = safeStatus((error as { status?: unknown } | null)?.status);
      const requestId = safeRequestId((error as { request_id?: unknown } | null)?.request_id);
      const errorType = classifyError(error, status);
      await request.emit("decision.inference.error", { provider: this.provider, revision: this.revision,
        elapsedMs: Math.round(performance.now() - started), errorType, ...(status ? { status } : {}),
        ...(requestId ? { requestId } : {}) });
      if (error instanceof DecisionProtocolError) throw error;
      throw new DecisionsRequestError(errorType, status, requestId);
    }
  }
}

export class DecisionsRequestError extends Error {
  constructor(readonly errorType: string, readonly status?: number, readonly requestId?: string) {
    super(`OpenAI Decisions request failed (${errorType}${status ? `, HTTP ${status}` : ""})`);
    this.name = "DecisionsRequestError";
  }
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    !/^(?:sk|rk|pk|sess|bearer)[-_]/i.test(value) ? value : undefined;
}

function validWireProbabilities(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}

function safeStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : undefined;
}

function classifyError(error: unknown, status?: number): string {
  if (error instanceof DecisionProtocolError) return "DecisionProtocolError";
  if (status === 429) return "RateLimitError";
  if (status === 401) return "AuthenticationError";
  if (status === 403) return "PermissionDeniedError";
  if (status === 400) return "BadRequestError";
  if (status !== undefined && status >= 500) return "InternalServerError";
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name !== "string") return "UnknownError";
  return ["APIError", "BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError",
    "ConflictError", "UnprocessableEntityError", "RateLimitError", "InternalServerError",
    "APIConnectionError", "APIConnectionTimeoutError", "APIUserAbortError", "AbortError", "TypeError"].includes(name) ? name : "UnknownError";
}
