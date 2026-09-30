import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexSessionFile, summarizeCodexAttempt } from "./trace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trace-"));
  roots.push(root);
  return root;
}

function attempt(files: Record<string, string>): string {
  const dir = temporaryRoot();
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const runtime = JSON.stringify({ agent: { id: "b3-designer" }, model: "gpt-6-sol", reasoningEffort: "medium",
  codexRuntimeVersion: "codex-cli 0.158.0", codexPath: "/opt/codex" });
const events = [
  { type: "thread.started", thread_id: "01a0-thread" },
  { type: "item.completed", item: { id: "1", type: "command_execution", command: "bash build.sh", exit_code: 0 } },
  { type: "item.completed", item: { id: "2", type: "command_execution", command: "bash check.sh", exit_code: 1 } },
  { type: "item.completed", item: { id: "3", type: "web_search", action: { queries: ["kimi k2 post-training"] } } },
  { type: "item.completed", item: { id: "4", type: "file_change", changes: [{ path: "a.html" }, { path: "a.html" }] } },
  { type: "item.completed", item: { id: "5", type: "error", message: "ignoring 2 unrecognized configuration setting" } },
  { type: "item.completed", item: { id: "6", type: "error", message: "font Space Grotesk is not declared" } }
].map((event) => JSON.stringify(event)).join("\n");

describe("summarizeCodexAttempt", () => {
  it("reports what the agent actually did, without environment noise", () => {
    const dir = attempt({ "runtime.json": runtime, "events.jsonl": events, "prompt.txt": "p".repeat(10), "input.json": "{}",
      "last-message.txt": '{"ok":true}', "result.json": JSON.stringify({ metadata: { threadId: "01a0-thread",
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 3 } } }) });
    const summary = summarizeCodexAttempt(dir, { ignoreErrors: /unrecognized configuration setting/ });
    expect(summary).toMatchObject({
      agentId: "b3-designer", model: "gpt-6-sol", codexRuntimeVersion: "codex-cli 0.158.0", codexPath: "/opt/codex",
      threadId: "01a0-thread", state: "completed", chars: { prompt: 10, input: 2, output: 11 },
      items: { command_execution: 2, web_search: 1, file_change: 1, error: 2 },
      searches: ["kimi k2 post-training"], filesChanged: ["a.html"], errors: ["font Space Grotesk is not declared"]
    });
    expect(summary.commands).toEqual([{ command: "bash build.sh", exitCode: 0 }, { command: "bash check.sh", exitCode: 1 }]);
  });

  it("marks a failed attempt and keeps its thread id from the event stream", () => {
    const dir = attempt({ "runtime.json": runtime, "events.jsonl": events, "failure.json": JSON.stringify({ message: "CODEX_SDK_TIMEOUT" }) });
    expect(summarizeCodexAttempt(dir)).toMatchObject({ state: "failed", failure: "CODEX_SDK_TIMEOUT", threadId: "01a0-thread", usage: null });
  });

  it("refuses a directory that is not an attempt trace", () => {
    expect(() => summarizeCodexAttempt(temporaryRoot())).toThrow("no runtime.json");
  });
});

describe("codexSessionFile", () => {
  it("finds the session by thread id on the day the attempt started, not the newest file", () => {
    const home = temporaryRoot();
    const day = path.join(home, "sessions", "2026", "09", "30");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "rollout-2026-09-30T10-00-00-01a0-thread.jsonl"), "");
    fs.writeFileSync(path.join(day, "rollout-2026-09-30T11-00-00-other-project.jsonl"), "");
    expect(codexSessionFile("01a0-thread", { startedAt: "2026-09-30T10:00:05+08:00", codexHome: home }))
      .toBe(path.join(day, "rollout-2026-09-30T10-00-00-01a0-thread.jsonl"));
  });

  it("falls back to archived sessions and returns nothing for an unknown thread", () => {
    const home = temporaryRoot();
    fs.mkdirSync(path.join(home, "archived_sessions"));
    fs.writeFileSync(path.join(home, "archived_sessions", "rollout-x-01a0-old.jsonl"), "");
    expect(codexSessionFile("01a0-old", { codexHome: home })).toBe(path.join(home, "archived_sessions", "rollout-x-01a0-old.jsonl"));
    expect(codexSessionFile("missing", { codexHome: home })).toBeUndefined();
  });
});
