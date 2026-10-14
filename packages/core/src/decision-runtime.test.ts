import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DecisionProtocolError, defineDecision, type DecisionDefinition, type DecisionInput, type DecisionResult, type DecisionRunRequest, type DecisionRunner } from "./decisions.js";
import { MemoryRunStore } from "./memory-run-store.js";
import type { AgentRunner } from "./ports.js";
import { runWorkflow, workflow } from "./runtime.js";

const noAgent: AgentRunner = { run: async () => { throw new Error("Unexpected agent run"); } };
const definition = defineDecision({ id: "review", revision: "1", provider: "test", model: "local",
  timeoutMs: 1000, questions: [
    { type: "predicate", name: "supported", instructions: "Is it supported?" },
    { type: "choice", name: "route", instructions: "Choose route", choices: [{ value: "keep" }, { value: false }] },
    { type: "score", name: "quality", instructions: "Score quality", levels: [{ label: "low" }, { label: "high" }] },
  ] });
const result: DecisionResult = { provider: "test", model: "local", answers: [
  { type: "predicate", name: "supported", probability: 0.8 },
  { type: "choice", name: "route", choice: "keep", confidence: 0.7,
    probabilities: [{ value: "keep", probability: 0.7 }, { value: false, probability: 0.3 }] },
  { type: "score", name: "quality", score: 0.6, confidence: 0.6,
    probabilities: [{ label: "low", value: 0, probability: 0.4 }, { label: "high", value: 1, probability: 0.6 }] },
] };
function runner(implementation: (request: DecisionRunRequest) => Promise<DecisionResult> = async () => result): DecisionRunner & { calls: DecisionRunRequest[] } {
  const calls: DecisionRunRequest[] = [];
  return { provider: "test", revision: "adapter-1", calls,
    run: async (request) => { calls.push(request); return implementation(request); } };
}

describe("decision inference runtime", () => {
  it("persists a validated result, replays it without a new runner call, and records only inference events", async () => {
    const store = new MemoryRunStore();
    const image = Buffer.from("image bytes");
    const input: DecisionInput = { text: "Evaluate the frame", images: [{ dataUrl: `data:image/png;base64,${image.toString("base64")}`,
      sha256: createHash("sha256").update(image).digest("hex"), label: "frame" }] };
    const decisionRunner = runner();
    const flow = workflow("decision-replay", { revision: "1" }, (ctx) => ctx.decision("check", definition, input));
    const first = await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner });
    const replay = await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent,
      decisionRunner, resumeRunId: first.run.id });
    expect(first.output).toEqual(result);
    expect(replay.output).toEqual(result);
    expect(decisionRunner.calls).toHaveLength(1);
    expect(decisionRunner.calls[0]!.idempotencyKey).toContain("fnv1a64:");
    const events = await store.listEvents(first.run.id);
    expect(events.map((event) => event.type)).toContain("decision.inference.completed");
    expect(events.map((event) => event.type)).toContain("step.reused");
    expect(events.map((event) => event.type)).not.toContain("decision.recorded");
    expect(JSON.stringify(events)).not.toContain(image.toString("base64"));
  });

  it("snapshots whitelisted input before the caller can mutate nested arrays", async () => {
    const image = Buffer.from("original frame");
    const digest = createHash("sha256").update(image).digest("hex");
    const authored = { text: "original text", images: [{ dataUrl: `data:image/png;base64,${image.toString("base64")}`,
      sha256: digest, label: "original" }], evidenceRefs: [{ artifactId: "artifact-1", revision: "1", sha256: digest }],
    };
    const decisionRunner = runner();
    const store = new MemoryRunStore();
    const flow = workflow("decision-snapshot", { revision: "1" }, (ctx) => {
      const pending = ctx.decision("check", definition, authored);
      authored.text = "changed text";
      authored.images[0]!.label = "changed";
      authored.images.push({ dataUrl: "https://invalid.example/image", sha256: digest, label: "extra" });
      authored.evidenceRefs[0]!.revision = "2";
      authored.evidenceRefs.push({ artifactId: "artifact-2", revision: "1", sha256: digest });
      return pending;
    });
    const completed = await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner });
    expect(completed.output).toEqual(result);
    expect(decisionRunner.calls[0]!.input).toMatchObject({ text: "original text",
      images: [{ label: "original", sha256: digest }], evidenceRefs: [{ artifactId: "artifact-1", revision: "1" }] });
    expect(decisionRunner.calls[0]!.input.images).toHaveLength(1);
    expect(decisionRunner.calls[0]!.input.evidenceRefs).toHaveLength(1);
    const started = (await store.listEvents(completed.run.id)).find((event) => event.type === "decision.inference.started");
    expect(started?.data).toMatchObject({ input: { text: "original text", images: [{ label: "original" }],
      evidenceRefs: [{ artifactId: "artifact-1", revision: "1" }] } });
  });

  it("changes the persisted step when the input, definition or runner revision changes", async () => {
    const store = new MemoryRunStore();
    let text = "first";
    let current: DecisionDefinition = definition;
    const firstRunner = runner();
    const flow = workflow("decision-fingerprint", { revision: "1" }, (ctx) => ctx.decision("check", current, { text }));
    const first = await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner: firstRunner });
    text = "second";
    await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner: firstRunner, resumeRunId: first.run.id });
    current = defineDecision({ ...definition, questions: [{ type: "predicate", name: "supported", instructions: "Different question" }] });
    const oneAnswerRunner = runner(async () => ({ ...result, answers: [result.answers[0]!] }));
    await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner: oneAnswerRunner, resumeRunId: first.run.id });
    const revisedRunner = { ...oneAnswerRunner, revision: "adapter-2" };
    await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner: revisedRunner, resumeRunId: first.run.id });
    expect(firstRunner.calls).toHaveLength(2);
    expect(oneAnswerRunner.calls).toHaveLength(2);
    expect((await store.listSteps(first.run.id)).filter((step) => step.kind === "decision")).toHaveLength(4);
  });

  it("accepts per-question refusal but rejects malformed answers without caching them", async () => {
    const store = new MemoryRunStore();
    const flow = workflow("decision-refusal", { revision: "1" }, (ctx) => ctx.decision("check", definition, { text: "x" }));
    const refused = runner(async () => ({ ...result, answers: [{ type: "refusal", name: "supported" }, ...result.answers.slice(1)] }));
    const first = await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner: refused });
    expect(first.output?.answers[0]).toEqual({ type: "refusal", name: "supported" });
    await runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent, decisionRunner: refused, resumeRunId: first.run.id });
    expect(refused.calls).toHaveLength(1);

    const badFlow = workflow("decision-bad", { revision: "1" }, (ctx) => ctx.decision("check", definition, { text: "x" }));
    const bad = runner(async () => ({ ...result, answers: [result.answers[0]!, result.answers[0]!, result.answers[2]!] }));
    await expect(runWorkflow({ workflow: badFlow, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: bad })).rejects.toThrow("duplicate");
    const badProbability = runner(async () => ({ ...result, answers: [result.answers[0]!,
      { type: "choice", name: "route", choice: "keep", confidence: 0.7,
        probabilities: [{ value: "keep", probability: 1.2 }, { value: false, probability: -0.2 }] }, result.answers[2]!] }));
    await expect(runWorkflow({ workflow: badFlow, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: badProbability })).rejects.toThrow("invalid choice probability");
  });

  it("treats malformed nested probabilities and provider protocol failures as non-retryable", async () => {
    const retryDefinition = defineDecision({ ...definition, maxRetries: 2 });
    const flow = workflow("decision-protocol", { revision: "1" }, (ctx) => ctx.decision("check", retryDefinition, { text: "x" }));
    const malformed = runner(async () => ({ ...result, answers: [result.answers[0]!,
      { type: "choice", name: "route", choice: "keep", confidence: 0.7,
        probabilities: [null, { value: false, probability: 0.3 }] }, result.answers[2]!] } as unknown as DecisionResult));
    await expect(runWorkflow({ workflow: flow, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: malformed })).rejects.toThrow("invalid choice probability");
    expect(malformed.calls).toHaveLength(1);
    const malformedScore = runner(async () => ({ ...result, answers: [result.answers[0]!, result.answers[1]!,
      { type: "score", name: "quality", score: 0.6, confidence: 0.6, probabilities: [null,
        { label: "high", value: 1, probability: 0.6 }] }] } as unknown as DecisionResult));
    await expect(runWorkflow({ workflow: flow, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: malformedScore })).rejects.toThrow("invalid score probability");
    expect(malformedScore.calls).toHaveLength(1);
    const outOfRange = runner(async () => ({ ...result, answers: [result.answers[0]!, result.answers[1]!,
      { type: "score", name: "quality", score: 1.4, confidence: 0.6, probabilities: [
        { label: "low", value: 0, probability: 0.4 }, { label: "high", value: 1, probability: 0.6 }] }] }));
    await expect(runWorkflow({ workflow: flow, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: outOfRange })).rejects.toThrow("outside its level values");
    expect(outOfRange.calls).toHaveLength(1);
    const adapterMalformed = runner(async () => { throw new DecisionProtocolError("secret-from-adapter"); });
    const store = new MemoryRunStore();
    await expect(runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent,
      decisionRunner: adapterMalformed })).rejects.toThrow("malformed provider response");
    expect(adapterMalformed.calls).toHaveLength(1);
    expect(JSON.stringify(await store.listEvents(store.runs[0]!.id))).not.toContain("secret-from-adapter");
  });

  it("sanitizes runner errors and never retries a static HTTP configuration failure", async () => {
    const retryDefinition = defineDecision({ ...definition, maxRetries: 2 });
    const flow = workflow("decision-error", { revision: "1" }, (ctx) => ctx.decision("check", retryDefinition, { text: "x" }));
    const secret = "sk-private-secret-and-prompt";
    const broken = runner(async () => {
      throw Object.assign(new Error(secret), { status: 400, errorType: "BadRequestError" });
    });
    const store = new MemoryRunStore();
    await expect(runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent,
      decisionRunner: broken })).rejects.toThrow("Decision runner failed (BadRequestError), HTTP 400");
    expect(broken.calls).toHaveLength(1);
    expect(JSON.stringify(await store.listEvents(store.runs[0]!.id))).not.toContain(secret);
    expect(store.runs[0]!.error).not.toContain(secret);
  });

  it("fails explicitly for missing runner, provider mismatch, invalid image hash and repeated async key", async () => {
    const flow = workflow("decision-configuration", { revision: "1" }, (ctx) => ctx.decision("check", definition, { text: "x" }));
    await expect(runWorkflow({ workflow: flow, input: null, store: new MemoryRunStore(), agentRunner: noAgent }))
      .rejects.toThrow("Decision runner is not configured");
    await expect(runWorkflow({ workflow: flow, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: { ...runner(), provider: "wrong" } })).rejects.toThrow("provider/revision mismatch");
    const invalid = workflow("decision-image", { revision: "1" }, (ctx) => ctx.decision("check", definition,
      { text: "x", images: [{ dataUrl: "https://example.com/frame.png", sha256: "0".repeat(64) }] }));
    await expect(runWorkflow({ workflow: invalid, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: runner() })).rejects.toThrow("inline data URLs");
    const wrongHash = workflow("decision-image-hash", { revision: "1" }, (ctx) => ctx.decision("check", definition,
      { text: "x", images: [{ dataUrl: "data:image/png;base64,YQ==", sha256: "0".repeat(64) }] }));
    await expect(runWorkflow({ workflow: wrongHash, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: runner() })).rejects.toThrow("does not match");
    const duplicate = workflow("decision-duplicate", { revision: "1" }, async (ctx) => {
      await ctx.decision("check", definition, { text: "x" });
      return ctx.decision("check", definition, { text: "x" });
    });
    await expect(runWorkflow({ workflow: duplicate, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: runner() })).rejects.toThrow("already used");
    const mixed = workflow("decision-mixed", { revision: "1" }, async (ctx) => {
      ctx.decide("check", "manual");
      return ctx.decision("check", definition, { text: "x" });
    });
    await expect(runWorkflow({ workflow: mixed, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: runner() })).rejects.toThrow("already used");
  });

  it("propagates cancellation and timeout and passes the runner through local child and phase contexts", async () => {
    const parent = workflow("decision-parent", { revision: "1" }, (ctx) => ctx.phase("review",
      { title: "Review", purpose: "Check" }, (phase) => phase.call("child",
        workflow("decision-child", { revision: "1" }, (child) => child.decision("check", definition, { text: "x" })), null)));
    const decisionRunner = runner();
    const store = new MemoryRunStore();
    const done = await runWorkflow({ workflow: parent, input: null, store, agentRunner: noAgent, decisionRunner });
    expect(done.output).toEqual(result);
    expect(decisionRunner.calls[0]!.runMetadata?.phasePath).toEqual(["review"]);

    const short = defineDecision({ ...definition, timeoutMs: 5 });
    const hanging = runner(async () => new Promise<DecisionResult>(() => {}));
    const timedFlow = workflow("decision-timeout", { revision: "1" }, (ctx) => ctx.decision("check", short, { text: "x" }));
    await expect(runWorkflow({ workflow: timedFlow, input: null, store: new MemoryRunStore(), agentRunner: noAgent,
      decisionRunner: hanging })).rejects.toThrow("timed out");

    const controller = new AbortController();
    let canceledEmit: DecisionRunRequest["emit"] | undefined;
    const cancellation = runner(async (request) => { canceledEmit = request.emit; return new Promise<DecisionResult>(() => {}); });
    const cancelFlow = workflow("decision-cancel", { revision: "1" }, (ctx) => ctx.decision("check", definition, { text: "x" }));
    const canceledStore = new MemoryRunStore();
    const pending = runWorkflow({ workflow: cancelFlow, input: null, store: canceledStore, agentRunner: noAgent,
      decisionRunner: cancellation, signal: controller.signal });
    const canceled = expect(pending).rejects.toThrow("canceled");
    await vi.waitFor(() => expect(cancellation.calls).toHaveLength(1));
    controller.abort();
    await canceled;
    const before = await canceledStore.listEvents(canceledStore.runs[0]!.id);
    await canceledEmit?.("decision.inference.late", { secret: "should-not-persist" });
    expect(await canceledStore.listEvents(canceledStore.runs[0]!.id)).toEqual(before);
  });

  it("never invokes the runner when cancellation happens while recording the start event", async () => {
    const controller = new AbortController();
    class CancelOnStartStore extends MemoryRunStore {
      override async appendEvent(event: Parameters<MemoryRunStore["appendEvent"]>[0]) {
        const recorded = await super.appendEvent(event);
        if (event.type === "decision.inference.started") controller.abort();
        return recorded;
      }
    }
    const store = new CancelOnStartStore();
    const decisionRunner = runner();
    const flow = workflow("decision-cancel-before-runner", { revision: "1" }, (ctx) =>
      ctx.decision("check", definition, { text: "x" }));
    await expect(runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent,
      decisionRunner, signal: controller.signal })).rejects.toThrow("canceled");
    expect(decisionRunner.calls).toHaveLength(0);
    expect(store.runs[0]!.state).toBe("canceled");
  });

  it("closes attempt emit after timeout so late runner callbacks cannot append events", async () => {
    const short = defineDecision({ ...definition, timeoutMs: 5 });
    let lateEmit: DecisionRunRequest["emit"] | undefined;
    const hanging = runner(async (request) => { lateEmit = request.emit; return new Promise<DecisionResult>(() => {}); });
    const store = new MemoryRunStore();
    const flow = workflow("decision-late-event", { revision: "1" }, (ctx) => ctx.decision("check", short, { text: "x" }));
    await expect(runWorkflow({ workflow: flow, input: null, store, agentRunner: noAgent,
      decisionRunner: hanging })).rejects.toThrow("timed out");
    const before = await store.listEvents(store.runs[0]!.id);
    await lateEmit?.("decision.inference.late", { secret: "should-not-persist" });
    const after = await store.listEvents(store.runs[0]!.id);
    expect(after).toEqual(before);

    let completedEmit: DecisionRunRequest["emit"] | undefined;
    const completedRunner = runner(async (request) => { completedEmit = request.emit; return result; });
    const completedStore = new MemoryRunStore();
    const completedFlow = workflow("decision-late-success", { revision: "1" }, (ctx) => ctx.decision("check", definition, { text: "x" }));
    const completed = await runWorkflow({ workflow: completedFlow, input: null, store: completedStore,
      agentRunner: noAgent, decisionRunner: completedRunner });
    const completedBefore = await completedStore.listEvents(completed.run.id);
    await completedEmit?.("decision.inference.late", { secret: "should-not-persist" });
    expect(await completedStore.listEvents(completed.run.id)).toEqual(completedBefore);
  });
});
