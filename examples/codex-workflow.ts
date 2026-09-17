import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defineAgent, runWorkflow, workflow, type RunStore } from "@signal-room/workflow";
import { CodexSdkRunner } from "@signal-room/workflow-codex";

type Summary = { summary: string };
export type SummaryOptions = {
  workflowRevision: string;
  model: string;
  reasoningEffort: string;
  methodFile: string;
  traceRoot: string;
  store: RunStore;
  resumeRunId?: string;
};

/** Importing/typechecking this example never starts a model. Calling it does. */
export async function runCodexSummary(input: { text: string }, options: SummaryOptions) {
  if (!options.workflowRevision || !options.model || !options.reasoningEffort) throw new Error("Choose workflow revision, model and effort explicitly");
  const methodFile = path.resolve(options.methodFile);
  const content = fs.readFileSync(methodFile, "utf8");
  if (!content.trim()) throw new Error("Method file must not be empty");
  const skillsRevision = createHash("sha256").update(content).digest("hex");
  const agent = defineAgent<typeof input, Summary>({
    id: "document-summary", revision: "1", model: options.model, reasoningEffort: options.reasoningEffort,
    promptRevision: "1", skillsRevision, permissionsRevision: "read-only-v1",
    config: {
      prompt: "Use the supplied method to summarize the frozen input. Return only the requested JSON.",
      skills: [{ path: methodFile, content }],
      outputSchema: {
        type: "object", properties: { summary: { type: "string" } },
        required: ["summary"], additionalProperties: false,
      },
      threadOptions: { sandboxMode: "read-only", approvalPolicy: "never" },
      timeoutMs: 120_000,
      // No outputDirectory: the runner uses its private per-attempt directory as cwd.
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
  const agentRunner = new CodexSdkRunner(undefined, path.resolve(options.traceRoot));
  return runWorkflow({ workflow: definition, input, store: options.store, agentRunner, resumeRunId: options.resumeRunId });
}
