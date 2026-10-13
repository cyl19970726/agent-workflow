import { describe, expect, it } from "vitest";
import { canReadWorkflow, readableWorkflowIds, readWorkflowScopeKey } from "./read-workflow-scope.js";

describe("read workflow scope", () => {
  it("defaults to the primary workflow and normalizes an explicit read allowlist", () => {
    expect(readableWorkflowIds({ workflowId: "post.analyze" })).toEqual(["post.analyze"]);
    const scope = { workflowId: "post.analyze", auxiliaryWorkflowIds: ["post.review", "post.build", "post.review", ""] };
    expect(readableWorkflowIds(scope)).toEqual(["post.analyze", "post.build", "post.review"]);
    expect(canReadWorkflow(scope, "post.build")).toBe(true);
    expect(canReadWorkflow(scope, "creator.analyze")).toBe(false);
    expect(readWorkflowScopeKey(scope)).toBe(readWorkflowScopeKey({ workflowId: "post.analyze",
      auxiliaryWorkflowIds: ["post.build", "post.review"] }));
    expect(readWorkflowScopeKey(scope)).not.toBe(readWorkflowScopeKey({ workflowId: "post.analyze" }));
  });
});
