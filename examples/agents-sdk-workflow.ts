/** Host Agents SDK + frozen skill example; no OpenSandbox. See opensandbox-shared.ts for container nodes. */
import { defineAgent, runWorkflow, workflow, type RunStore } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner, SiwcAuth } from "../packages/agent-sdk/dist/index.js";
import { snapshotSkill } from "../packages/skill-snapshot/dist/index.js";

type Summary = { summary: string };
export type SummaryOptions = {
  workflowRevision: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  skillDirectory: string;
  store: RunStore;
  resumeRunId?: string;
};

/** The host supplies PostgreSQL-backed storage; importing this example never starts a model. */
export async function runAgentsSdkSummary(input: { text: string }, options: SummaryOptions) {
  if (!options.workflowRevision || !options.model) throw new Error("Choose workflow revision and model explicitly");
  const skill = snapshotSkill(options.skillDirectory);
  const agent = defineAgent<typeof input, Summary>({
    id: "document-summary", revision: "1", model: options.model, reasoningEffort: options.reasoningEffort,
    promptRevision: "1", skillsRevision: skill.sha256, permissionsRevision: "read-only-v1",
    config: {
      instructions: `Use this method: ${skill.content}\nSummarize the frozen input as a concise JSON object with one summary string.`,
      outputFormat: "json",
    },
  });
  const definition = workflow<typeof input, unknown>("document.summary", { revision: options.workflowRevision }, async (ctx, frozenInput) => {
    const candidate = await ctx.agent("summarize", agent, frozenInput);
    const checked = await ctx.validate("summary-contract", candidate, value => ({
      valid: typeof value?.summary === "string" && value.summary.trim().length > 0,
    }));
    if (!checked.valid) return ctx.needsReview({ candidate, reason: "invalid-summary" });
    return ctx.publish("summary", "document-summary", candidate, { validation: "valid", review: "pending" });
  });
  const agentRunner = new OpenAIAgentsSdkRunner({ auth: new SiwcAuth(), enforceJsonObject: true, timeoutMs: 120_000 });
  return runWorkflow({ workflow: definition, input, store: options.store, agentRunner, resumeRunId: options.resumeRunId });
}
