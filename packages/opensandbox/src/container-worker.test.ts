import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { containerAttemptKey, parseContainerAgentJob, parseContainerAgentResult, validateContainerAgentJob,
  validateContainerAgentResult, type ContainerAgentJob } from "./container-protocol.js";
import { ContainerWorkerFailure, executeContainerWorkerFiles, observeCodexEvent,
  projectSdkEventData, runContainerAgentJob } from "./container-worker.js";

function job(overrides: Partial<ContainerAgentJob> = {}): ContainerAgentJob {
  return { protocolVersion: 1, runId: "run-1", stepRunId: "step-1", attemptId: "attempt-1",
    runtime: "codex-cli", workspaceRoot: "/work/shared", definition: { id: "a", revision: "1",
      model: "gpt-6-luna", reasoningEffort: "low", promptRevision: "1", skillsRevision: "none",
      permissionsRevision: "1", config: { instructions: "Analyze the input" } }, input: { file: "input.csv" },
    limits: { timeoutMs: 30_000, maxTurns: 2, maxToolCalls: 1, maxOutputBytes: 4096 }, ...overrides };
}
function state() { return { thread: false, turn: false, complete: false, commandStarts: 0, turns: 0, lastMessage: "" }; }

describe("container job protocol", () => {
  it("accepts a data-only job and exact-attempt result", () => {
    const value = job();
    validateContainerAgentJob(value);
    expect(parseContainerAgentJob(value)).toBe(value);
    const result = { protocolVersion: 1, runId: value.runId, stepRunId: value.stepRunId,
      attemptId: value.attemptId, status: "succeeded", output: "done" };
    validateContainerAgentResult(result, value);
    expect(parseContainerAgentResult(result, value)).toBe(result);
  });
  it("rejects callbacks, control-directory paths, bad commands and stale results", () => {
    expect(() => parseContainerAgentJob({ ...job(), input: { execute() {} } })).toThrow(/JSON data/);
    expect(() => parseContainerAgentJob({ ...job(), workspaceRoot: "/work/.workflow" })).toThrow();
    expect(() => parseContainerAgentJob({ ...job(), tools: { writePaths: ["scripts"], commands: {} } }))
      .toThrow(/Codex native shell/);
    expect(() => parseContainerAgentJob({ ...job(), tools: { writePaths: ["../.workflow/job.json"], commands: {} } })).toThrow();
    expect(() => parseContainerAgentJob({ ...job(), tools: { writePaths: [], commands: { run: { argv: [], timeoutSeconds: 3 } } } })).toThrow();
    expect(() => parseContainerAgentResult({ protocolVersion: 1, runId: "other", stepRunId: "step-1",
      attemptId: "attempt-1", status: "succeeded", output: "done" }, job())).toThrow(/correlation/);
  });
  it("bounds result bytes independently from business file size", () => {
    expect(() => parseContainerAgentResult({ protocolVersion: 1, runId: "run-1", stepRunId: "step-1",
      attemptId: "attempt-1", status: "succeeded", output: "x".repeat(5000) }, job())).toThrow(/exceeds limit/);
  });
  it("reads the exact attempt control path and atomically writes its correlated result", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-worker-test-"));
    try {
      const value = job();
      const control = join(root, containerAttemptKey(value));
      await mkdir(control);
      const jobPath = join(control, "job.json"), resultPath = join(control, "result.json");
      await writeFile(jobPath, JSON.stringify(value));
      const run = vi.fn(async () => ({ protocolVersion: 1 as const, runId: value.runId,
        stepRunId: value.stepRunId, attemptId: value.attemptId, status: "succeeded" as const, output: "done" }));
      const result = await executeContainerWorkerFiles(jobPath, resultPath, { controlRoot: root, run });
      expect(result.status).toBe("succeeded");
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(result);
      expect(await readdir(control)).toEqual(["home", "job.json", "result.json"]);
      expect(await readdir(join(control, "home"))).toContain(".codex");
      await expect(executeContainerWorkerFiles(jobPath, join(root, "wrong", "result.json"),
        { controlRoot: root, run })).rejects.toThrow(/control paths/);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("Codex event acceptance", () => {
  it("tracks a completed turn and emits command identity without raw command content", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(value => { writes.push(String(value)); return true; });
    try {
      const s = state(); const value = job();
      observeCodexEvent({ type: "thread.started", thread_id: "01a13ec9-23a5-7b02-bb84-d2d2cbd28d18" }, s, value);
      observeCodexEvent({ type: "item.completed", item: { type: "error",
        message: "Model metadata for `gpt-6-luna` not found. Private detail must not leak." } }, s, value);
      observeCodexEvent({ type: "turn.started" }, s, value);
      observeCodexEvent({ type: "item.started", item: { type: "command_execution", command: "/bin/bash -lc 'secret input'" } }, s, value);
      observeCodexEvent({ type: "item.completed", item: { type: "command_execution", command: "/bin/bash -lc 'secret input'", exit_code: 0 } }, s, value);
      observeCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } }, s, value);
      observeCodexEvent({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3,
        cached_input_tokens: 5, reasoning_output_tokens: 2 } }, s, value);
      expect(s).toMatchObject({ thread: true, turn: true, complete: true, commandStarts: 1, lastMessage: "done" });
      expect(writes.join("")).toContain('"name":"/bin/bash"');
      expect(writes.join("")).toContain('"inputTokens":12');
      expect(writes.join("")).toContain('"threadId":"01a13ec9-23a5-7b02-bb84-d2d2cbd28d18"');
      expect(writes.join("")).toContain('"cachedInputTokens":5');
      expect(writes.join("")).toContain('"reasoningOutputTokens":2');
      expect(writes.join("")).toContain('"totalTokens":15');
      expect(writes.join("")).toContain("codex.model_metadata_fallback");
      expect(writes.join("")).not.toContain("secret input");
      expect(writes.join("")).not.toContain("Private detail");
    } finally { spy.mockRestore(); }
  });
  it("rejects failed turns and excess commands", () => {
    const s = state(); const value = job();
    expect(() => observeCodexEvent({ type: "turn.failed" }, s, value)).toThrow(ContainerWorkerFailure);
    observeCodexEvent({ type: "thread.started" }, s, value);
    observeCodexEvent({ type: "turn.started" }, s, value);
    observeCodexEvent({ type: "item.started", item: { type: "command_execution", command: "echo one" } }, s, value);
    expect(() => observeCodexEvent({ type: "item.started", item: { type: "command_execution", command: "echo two" } }, s, value))
      .toThrow(/LIMIT/);
  });
  it("returns a failed envelope for a canceled SDK run without invoking a model", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await runContainerAgentJob(job({ runtime: "agents-sdk" }), controller.signal, "/tmp/empty-home");
    expect(result).toMatchObject({ status: "failed", failureCode: "ABORTED", attemptId: "attempt-1" });
  });
  it("omits unknown Codex counts instead of inventing zero", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(value => { writes.push(String(value)); return true; });
    try {
      const s = state(), value = job();
      observeCodexEvent({ type: "thread.started", thread_id: "Bearer secret" }, s, value);
      observeCodexEvent({ type: "turn.started" }, s, value);
      observeCodexEvent({ type: "turn.completed", usage: { input_tokens: "unknown" } }, s, value);
      expect(writes.join("")).not.toContain("Bearer secret");
      expect(writes.join("")).not.toContain("inputTokens");
      expect(writes.join("")).not.toContain("totalTokens");
    } finally { spy.mockRestore(); }
  });
  it("projects only safe SDK response identity and token metrics", () => {
    expect(projectSdkEventData("siwc.response", { turn: 2, responseId: "resp_123",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
        input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 4 } },
      visibleOutput: [{ text: "private model answer" }], token: "private credential" })).toEqual({
      turn: 2, responseId: "resp_123", inputTokens: 100, outputTokens: 20,
      cachedInputTokens: 30, reasoningOutputTokens: 4, totalTokens: 120,
    });
    expect(projectSdkEventData("siwc.response", { responseId: "Bearer secret",
      usage: { input_tokens: "missing", output_tokens: -2 } })).toEqual({});
    expect(projectSdkEventData("siwc.tool_call", { name: "read_file", output: "private" }))
      .toEqual({ name: "read_file" });
  });
});
