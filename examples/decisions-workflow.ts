import { defineDecision, runWorkflow, workflow, type AgentRunner, type DecisionInput, type RunStore } from "@signal-room/workflow";
import { OpenAIDecisionsRunner } from "../packages/agent-sdk/dist/index.js";

type DecisionClient = ConstructorParameters<typeof OpenAIDecisionsRunner>[0]["client"];

/** The host explicitly provides API authorization. Importing this file never calls a model. */
export async function runEvidenceShadow(input: DecisionInput, options: {
  client: DecisionClient; store: RunStore; agentRunner: AgentRunner; resumeRunId?: string;
}) {
  const definition = defineDecision({
    id: "evidence.support", revision: "1", provider: "openai", model: "gpt-6-luna",
    timeoutMs: 20_000, maxRetries: 0,
    questions: [{ name: "support", type: "choice",
      instructions: "Evaluate only whether the supplied evidence directly supports the supplied claim. Missing evidence means insufficient.",
      choices: [{ value: "supported" }, { value: "contradicted" }, { value: "insufficient" }] }],
  });
  const check = workflow<DecisionInput, unknown>("evidence.shadow", { revision: "1" }, async (ctx, evidence) => {
    const judgment = await ctx.decision("support", definition, evidence);
    const disposition = ctx.decide("disposition", { route: "review", basis: "shadow-only" });
    return { judgment, disposition };
  });
  return runWorkflow({ workflow: check, input, store: options.store, agentRunner: options.agentRunner,
    decisionRunner: new OpenAIDecisionsRunner({ client: options.client }), resumeRunId: options.resumeRunId });
}
