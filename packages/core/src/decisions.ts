import type { ArtifactDependency } from "./contracts.js";
import type { AgentRunRequest } from "./ports.js";

export type DecisionQuestion =
  | { readonly type: "predicate"; readonly name: string; readonly instructions: string }
  | { readonly type: "choice"; readonly name: string; readonly instructions: string;
      readonly choices: readonly { readonly value: string | boolean; readonly description?: string }[] }
  | { readonly type: "score"; readonly name: string; readonly instructions: string;
      readonly levels: readonly { readonly label: string; readonly description?: string }[] };

export interface DecisionDefinition {
  readonly id: string;
  readonly revision: string;
  readonly provider: string;
  readonly model: string;
  readonly questions: readonly DecisionQuestion[];
  readonly timeoutMs: number;
  readonly maxRetries?: number;
}

export interface DecisionInput {
  readonly text: string;
  readonly images?: readonly { readonly dataUrl: string; readonly sha256: string;
    readonly label?: string; readonly detail?: "low" | "high" | "auto" }[];
  readonly evidenceRefs?: readonly ArtifactDependency[];
}

export type DecisionAnswer =
  | { readonly type: "predicate"; readonly name: string; readonly probability: number }
  | { readonly type: "choice"; readonly name: string; readonly choice: string | boolean;
      readonly confidence: number; readonly probabilities: readonly { readonly value: string | boolean; readonly probability: number }[] }
  | { readonly type: "score"; readonly name: string; readonly score: number;
      readonly confidence: number; readonly probabilities: readonly { readonly label: string; readonly value: number; readonly probability: number }[] }
  | { readonly type: "refusal"; readonly name: string };

export interface DecisionResult {
  readonly provider: string;
  readonly model: string;
  readonly answers: readonly DecisionAnswer[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
  readonly requestId?: string;
}

export interface DecisionRunRequest extends Omit<AgentRunRequest<DecisionInput>, "definition"> {
  readonly definition: DecisionDefinition;
  readonly idempotencyKey: string;
}
export interface DecisionRunner {
  readonly provider: string;
  readonly revision: string;
  run(request: DecisionRunRequest): Promise<DecisionResult>;
}

/** Signal malformed provider output. Core will replace its message with a fixed safe error at the runner boundary. */
export class DecisionProtocolError extends Error {
  constructor(message = "malformed provider response") {
    super(`Invalid decision result: ${message}`);
    this.name = "DecisionProtocolError";
  }
}

/** Validate and freeze the caller-owned question lists before using them in a workflow. */
export function defineDecision(definition: DecisionDefinition): DecisionDefinition {
  for (const value of [definition.id, definition.revision, definition.provider, definition.model]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Decision id, revision, provider and model are required");
  }
  if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0) throw new Error("Decision timeoutMs must be a positive integer");
  if (definition.maxRetries !== undefined && (!Number.isSafeInteger(definition.maxRetries) || definition.maxRetries < 0)) {
    throw new Error("Decision maxRetries must be a non-negative integer");
  }
  if (!Array.isArray(definition.questions) || !definition.questions.length) throw new Error("Decision questions are required");
  const names = new Set<string>();
  const sourceQuestions: readonly DecisionQuestion[] = definition.questions;
  const questions = sourceQuestions.map((question): DecisionQuestion => {
    if (!question.name?.trim() || !question.instructions?.trim() || names.has(question.name)) {
      throw new Error("Decision question names must be unique and instructions must be non-empty");
    }
    names.add(question.name);
    if (question.type === "predicate") return Object.freeze({ ...question });
    if (question.type === "choice") {
      if (!question.choices.length || new Set(question.choices.map((choice) => `${typeof choice.value}:${choice.value}`)).size !== question.choices.length
        || question.choices.some((choice) => typeof choice.value !== "string" && typeof choice.value !== "boolean")) {
        throw new Error("Decision choice values must be non-empty and unique by type");
      }
      return Object.freeze({ ...question, choices: Object.freeze(question.choices.map((choice) => Object.freeze({ ...choice }))) });
    }
    if (question.type === "score") {
      if (!question.levels.length || new Set(question.levels.map((level) => level.label)).size !== question.levels.length
        || question.levels.some((level) => !level.label?.trim())) throw new Error("Decision score levels must have unique labels");
      return Object.freeze({ ...question, levels: Object.freeze(question.levels.map((level) => Object.freeze({ ...level }))) });
    }
    throw new Error("Unknown decision question type");
  });
  return Object.freeze({ ...definition, maxRetries: definition.maxRetries ?? 0, questions: Object.freeze(questions) });
}
