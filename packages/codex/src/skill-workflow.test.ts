import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Input, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { MemoryRunStore, defineAgent, runWorkflow, workflow } from "@signal-room/workflow";
import { CodexSdkRunner, attachVerifiedSkillSnapshots, type CodexSdkFactory } from "./runner.js";
import { snapshotSkill, type FrozenSkillBundle } from "./skill-bundle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-workflow-"));
  roots.push(root);
  return root;
}

function writeSkill(root: string, reference: string): string {
  const skill = path.join(root, "source", "complete-method");
  fs.mkdirSync(path.join(skill, "references"), { recursive: true });
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skill, "assets"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# Complete method\nRead references/method.md and use scripts/probe.sh.");
  fs.writeFileSync(path.join(skill, "references", "method.md"), reference);
  fs.writeFileSync(path.join(skill, "scripts", "probe.sh"), "#!/bin/sh\nprintf staged-script", { mode: 0o755 });
  fs.writeFileSync(path.join(skill, "assets", "sample.bin"), Buffer.from([0, 255, 1, 128]));
  return skill;
}

function readingFactory(observed: Array<{ cwd: string; mode: number; output: Record<string, unknown> }>): CodexSdkFactory {
  return { create: () => ({
    startThread: (options: ThreadOptions) => {
      const cwd = options.workingDirectory!;
      const staged = path.join(cwd, ".agents", "skills", "complete-method");
      const output = {
        reference: fs.readFileSync(path.join(staged, "references", "method.md"), "utf8"),
        script: fs.readFileSync(path.join(staged, "scripts", "probe.sh"), "utf8"),
        binary: [...fs.readFileSync(path.join(staged, "assets", "sample.bin"))]
      };
      observed.push({ cwd, mode: fs.statSync(path.join(staged, "scripts", "probe.sh")).mode & 0o777, output });
      return { id: `thread-${observed.length}`, runStreamed: async (_input: Input) => ({ events: (async function* () {
        yield ({ type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify(output) } } as ThreadEvent);
      })() }) };
    },
    resumeThread: () => { throw new Error("unexpected resume"); }
  }) as never };
}

function skillAgent(bundle: FrozenSkillBundle, outputDirectory: string, resume?: {
  requested: true; threadId: string; role: string; fingerprint: string;
}) {
  return defineAgent<null, Record<string, unknown>>({
    id: "skill-reader", revision: "1", model: "gpt-5.6-terra", reasoningEffort: "medium",
    promptRevision: "1", skillsRevision: bundle.sha256, permissionsRevision: "1",
    config: { prompt: "Use the required native skill package.", skills: [bundle], outputDirectory, ...(resume ? { resume } : {}) }
  });
}

describe("native skill package workflow", () => {
  it("runs from a complete frozen skill after its source is removed and changes output only for a fresh snapshot", async () => {
    const root = temporaryRoot();
    const source = writeSkill(root, "reference-v1");
    const firstBundle = snapshotSkill(source);
    fs.rmSync(path.join(root, "source"), { recursive: true, force: true });

    const observed: Array<{ cwd: string; mode: number; output: Record<string, unknown> }> = [];
    const runner = new CodexSdkRunner(readingFactory(observed), path.join(root, "traces"), { cliBinary: "missing-codex" });
    const makeFlow = (bundle: FrozenSkillBundle, outputDirectory: string) => workflow("skill-package", { revision: "1" }, async (ctx) => {
      const output = await ctx.agent("read", skillAgent(bundle, outputDirectory), null);
      await ctx.validate("validate", output, () => ({ valid: true }));
      return output;
    });
    const first = await runWorkflow({ workflow: makeFlow(firstBundle, path.join(root, "output-v1")), input: null,
      store: new MemoryRunStore(), agentRunner: runner });

    expect(first.output).toEqual({ reference: "reference-v1", script: "#!/bin/sh\nprintf staged-script", binary: [0, 255, 1, 128] });
    expect(observed[0]).toMatchObject({ cwd: path.join(root, "output-v1"), mode: 0o700 });
    expect(fs.existsSync(source)).toBe(false);

    const changedSource = writeSkill(root, "reference-v2");
    const secondBundle = snapshotSkill(changedSource);
    expect(secondBundle.sha256).not.toBe(firstBundle.sha256);
    fs.rmSync(path.join(root, "source"), { recursive: true, force: true });
    const second = await runWorkflow({ workflow: makeFlow(secondBundle, path.join(root, "output-v2")), input: null,
      store: new MemoryRunStore(), agentRunner: runner });

    expect(second.output).toEqual({ reference: "reference-v2", script: "#!/bin/sh\nprintf staged-script", binary: [0, 255, 1, 128] });
  });

  it("rejects resume when the frozen package digest no longer matches the original thread fingerprint", async () => {
    const root = temporaryRoot();
    const source = writeSkill(root, "reference-v1");
    const firstBundle = snapshotSkill(source);
    fs.writeFileSync(path.join(source, "references", "method.md"), "reference-v2");
    const secondBundle = snapshotSkill(source);
    const runner = new CodexSdkRunner(readingFactory([]), path.join(root, "traces"), { cliBinary: "missing-codex" });
    const first = await runner.run({ runId: "run-a", stepRunId: "step-a", attemptId: "attempt-a",
      definition: skillAgent(firstBundle, path.join(root, "resume-v1")), input: null,
      signal: new AbortController().signal, emit: async () => undefined });
    const fingerprint = (first.metadata as { fingerprint: string }).fingerprint;

    await expect(runner.run({ runId: "run-b", stepRunId: "step-b", attemptId: "attempt-b",
      definition: skillAgent(secondBundle, path.join(root, "resume-v2"), {
        requested: true, threadId: "thread-1", role: "skill-reader", fingerprint
      }), input: null, signal: new AbortController().signal, emit: async () => undefined }))
      .rejects.toThrow("CODEX_SDK_RESUME_FINGERPRINT_MISMATCH");
  });

  it("stages the complete containing package when a legacy caller requires only a nested reference", () => {
    const root = temporaryRoot();
    const source = writeSkill(root, "nested-reference");
    const output = path.join(root, "legacy-output");
    const result = attachVerifiedSkillSnapshots("Follow the method.", [path.join(source, "references", "method.md")],
      { outputDirectory: output });
    const staged = path.join(output, ".agents", "skills", "complete-method");

    expect(fs.readFileSync(path.join(staged, "SKILL.md"), "utf8")).toContain("Complete method");
    expect(fs.readFileSync(path.join(staged, "scripts", "probe.sh"), "utf8")).toContain("staged-script");
    expect([...fs.readFileSync(path.join(staged, "assets", "sample.bin"))]).toEqual([0, 255, 1, 128]);
    expect(result.receipt.packages).toEqual([expect.objectContaining({ root: staged })]);
    expect(result.prompt).toContain(path.join(staged, "SKILL.md"));
  });
});
