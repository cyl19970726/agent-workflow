/**
 * Legacy host-loop/tool-container adapter smoke; all execution below is fake.
 * No OpenSandbox service, PostgreSQL or model. This does not test the in-container worker.
 * For complete container-resident nodes, see opensandbox-shared.ts and ../docs/opensandbox.md.
 */
import assert from "node:assert/strict";
import { createOpenSandboxAgentRunner, openSandboxAgentConfig, readBoundedSandboxBytes } from "@signal-room/workflow-opensandbox";

const profile = { image: `python@sha256:${"a".repeat(64)}`, ttlSeconds: 120,
  resource: { cpu: "1", memory: "1Gi" },
  tools: { workspaceRoot: "/work", writePrefixes: ["scripts"],
    commands: { analyze: { argv: ["python", "/work/scripts/analyze.py"], timeoutSeconds: 10 } },
    maxReadBytes: 1024, maxWriteBytes: 1024, maxOutputBytes: 1024, maxImageBytes: 1024 } };
const connection = { domain: "local.invalid", protocol: "http" };
const events = [];
const files = new Map();
const calls = [];
const sandbox = { id: "fake-sandbox", files: {
  async createDirectories() { calls.push("mkdir"); },
  async writeFiles(entries) { for (const entry of entries) files.set(entry.path, entry.data); },
  async readBytes(path, options) { const data = files.get(path); if (!data) throw new Error("missing file"); return data.subarray(0, options.limit); },
  async *readBytesStream(path, options) { const data = files.get(path); if (!data) throw new Error("missing file");
    const end = Number(options.range.split("-")[1]); yield data.subarray(0, end + 1); },
}, commands: { async run() { calls.push("command"); return { complete: {}, exitCode: 0, logs: { stdout: [], stderr: [] } }; } },
async kill() { calls.push("kill"); }, async close() { calls.push("close"); } };

const runner = createOpenSandboxAgentRunner({ connection, profile,
  auth: { async accessToken() { throw new Error("Model must not be used by smoke"); } },
  async createSandbox() { calls.push("create"); return sandbox; },
  async prepare({ sandbox }) { await sandbox.files.writeFiles([{ path: "/work/input.csv", data: Buffer.from("category,amount\nA,1\n") }]); },
  agentRunnerFactory: tools => ({ async run(_request) {
    const find = name => tools.find(tool => tool.name === name);
    const signal = new AbortController().signal;
    const input = await find("read_file").execute({ path: "input.csv" }, signal);
    assert.equal(input.content, "category,amount\nA,1\n");
    await find("write_file").execute({ path: "scripts/analyze.py", content: "print(1)" }, signal);
    await find("exec_allowed").execute({ name: "analyze" }, signal);
    files.set("/work/summary.json", Buffer.from('{"total":1}'));
    return { output: { model: "fake" } };
  } }),
  async finish({ sandbox, result, request }) {
    const bytes = await readBoundedSandboxBytes(sandbox, "/work/summary.json", 1024, request.signal);
    assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()), { total: 1 });
    return { ...result, output: { total: 1 } };
  },
});
const result = await runner.run({ runId: "run-smoke", stepRunId: "step-smoke", attemptId: "attempt-smoke",
  signal: new AbortController().signal,
  definition: { id: "smoke", revision: "1", model: "fake", reasoningEffort: "low", promptRevision: "1",
    skillsRevision: "none", permissionsRevision: "1", config: openSandboxAgentConfig(profile, connection) },
  input: {}, async emit(type) { events.push(type); } });
assert.deepEqual(result.output, { total: 1 });
assert.deepEqual(calls, ["create", "mkdir", "command", "kill", "close"]);
assert.deepEqual(result.metadata.sandboxCleanup, { remoteKill: "succeeded", clientClose: "succeeded" });
assert.ok(events.includes("sandbox.create_intent") && events.includes("sandbox.started") && events.includes("sandbox.stopped"));
console.log(JSON.stringify({ state: "smoke-passed", modelCalls: 0, remoteSandboxes: 0, events }));
