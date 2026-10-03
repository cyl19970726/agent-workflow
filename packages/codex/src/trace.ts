import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Reading side of the private attempt trace written by `CodexSdkRunner`. Tuning a workflow starts from
 * what each agent actually did — what it ran, searched, failed on, how much it read and wrote — not from
 * the agent's own summary. These helpers turn one attempt directory into that evidence.
 */

export type CodexAttemptSummary = {
  attemptDir: string;
  agentId: string;
  model: string;
  reasoningEffort: string;
  codexRuntimeVersion: string;
  codexPath: string;
  threadId: string | null;
  state: "completed" | "failed" | "incomplete";
  failure?: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number } | null;
  chars: { prompt: number; input: number; output: number };
  /** Completed items by type, e.g. `{ command_execution: 31, file_change: 2, web_search: 4 }`. */
  items: Record<string, number>;
  searches: string[];
  commands: Array<{ command: string; exitCode: number | null }>;
  filesChanged: string[];
  errors: string[];
};

type TraceItem = {
  type?: string; message?: string; command?: string; exit_code?: number | null; query?: string;
  action?: { queries?: string[]; query?: string }; changes?: Array<{ path?: string }>;
};

function readText(dir: string, name: string): string | undefined {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

function readJson<T>(dir: string, name: string): T | undefined {
  const text = readText(dir, name);
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

/**
 * Summarises one attempt directory (`<traceRoot>/<runId>/<stepRunId>/<attemptId>`).
 * `ignoreErrors` drops environment noise that repeats on every call (for example local config warnings),
 * so the errors left are the ones this agent actually met.
 */
export function summarizeCodexAttempt(attemptDir: string, options: { ignoreErrors?: RegExp } = {}): CodexAttemptSummary {
  const runtime = readJson<Record<string, unknown>>(attemptDir, "runtime.json");
  if (!runtime) throw new Error(`Not a Codex attempt trace (no runtime.json): ${attemptDir}`);
  const result = readJson<{ metadata?: { threadId?: string | null; usage?: CodexAttemptSummary["usage"] } }>(attemptDir, "result.json");
  const failure = readJson<{ message?: string }>(attemptDir, "failure.json");
  const events = (readText(attemptDir, "events.jsonl") ?? "").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as { type?: string; thread_id?: string; item?: TraceItem }]; } catch { return []; }
  });
  const completed = events.filter((event) => event.type === "item.completed" && event.item).map((event) => event.item as TraceItem);
  const items: Record<string, number> = {};
  for (const item of completed) items[item.type ?? "unknown"] = (items[item.type ?? "unknown"] ?? 0) + 1;
  return {
    attemptDir,
    agentId: String((runtime.agent as { id?: string } | undefined)?.id ?? ""),
    model: String(runtime.model ?? ""),
    reasoningEffort: String(runtime.reasoningEffort ?? ""),
    codexRuntimeVersion: String(runtime.codexRuntimeVersion ?? "unknown"),
    codexPath: String(runtime.codexPath ?? "unrecorded"),
    threadId: result?.metadata?.threadId ?? events.find((event) => event.type === "thread.started")?.thread_id ?? null,
    state: result ? "completed" : failure ? "failed" : "incomplete",
    ...(failure?.message ? { failure: failure.message } : {}),
    usage: result?.metadata?.usage ?? null,
    chars: {
      prompt: readText(attemptDir, "prompt.txt")?.length ?? 0,
      input: readText(attemptDir, "input.json")?.length ?? 0,
      output: readText(attemptDir, "last-message.txt")?.length ?? 0
    },
    items,
    searches: completed.filter((item) => item.type === "web_search")
      .flatMap((item) => item.action?.queries ?? (item.action?.query ? [item.action.query] : item.query ? [item.query] : [])),
    commands: completed.filter((item) => item.type === "command_execution")
      .map((item) => ({ command: String(item.command ?? ""), exitCode: item.exit_code ?? null })),
    filesChanged: [...new Set(completed.filter((item) => item.type === "file_change")
      .flatMap((item) => (item.changes ?? []).map((change) => String(change.path ?? ""))).filter(Boolean))],
    errors: completed.filter((item) => item.type === "error").map((item) => String(item.message ?? ""))
      .filter((message) => !options.ignoreErrors?.test(message))
  };
}

/**
 * The full Codex session behind an attempt, found by thread id. SDK threads are ordinary Codex sessions
 * stored as `<codexHome>/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`. Always locate by thread id:
 * picking "the newest session file" finds whatever else ran on the machine at the same time.
 */
export function codexSessionFile(threadId: string, options: { startedAt?: string | Date; codexHome?: string } = {}): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) return undefined;
  const home = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const match = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).find((name) => name.includes(threadId) && name.endsWith(".jsonl")) : undefined;
  const day = options.startedAt ? new Date(options.startedAt) : undefined;
  if (day && !Number.isNaN(day.getTime())) {
    for (const offset of [0, -1, 1]) {
      const date = new Date(day.getTime() + offset * 86_400_000);
      const dir = path.join(home, "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
      const hit = match(dir);
      if (hit) return path.join(dir, hit);
    }
  }
  const archived = path.join(home, "archived_sessions");
  const hit = match(archived);
  return hit ? path.join(archived, hit) : undefined;
}
