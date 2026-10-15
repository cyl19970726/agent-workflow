/** Opt-in real container acceptance. No model or database calls. Never run from default CI. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Sandbox, SandboxManager } from "@alibaba-group/opensandbox";
import { createOpenSandboxAgentRunner, openSandboxAgentConfig } from "@signal-room/workflow-opensandbox";

for (const key of ["OPEN_SANDBOX_DOMAIN", "OPEN_SANDBOX_IMAGE_DIGEST", "OPEN_SANDBOX_API_KEY"]) {
  if (!process.env[key]) throw new Error(`Set ${key} for the opt-in real container check`);
}
const connection = { domain: process.env.OPEN_SANDBOX_DOMAIN,
  protocol: process.env.OPEN_SANDBOX_PROTOCOL ?? "http", apiKey: process.env.OPEN_SANDBOX_API_KEY };
assert.ok(["http", "https"].includes(connection.protocol));
const manager = SandboxManager.create({ connectionConfig: { ...connection, disableMetrics: true, requestTimeoutSeconds: 15 } });
const marker = `workflow-live-${randomUUID()}`;
const sandboxIds = [];
const evidence = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmUAAAAASUVORK5CYII=", "base64");
const CSV = "category,amount\r\nA,1\r\nB,2\r\nA,2\r\nB,3\r\n";
const profile = { image: process.env.OPEN_SANDBOX_IMAGE_DIGEST, ttlSeconds: 120,
  resource: { cpu: "1", memory: "1Gi" },
  tools: { workspaceRoot: "/work", writePrefixes: ["scripts"],
    commands: { analyze: { argv: ["python", "/work/scripts/analyze.py"], timeoutSeconds: 30 } },
    maxReadBytes: 4096, maxWriteBytes: 8192, maxOutputBytes: 4096, maxImageBytes: 4096 } };

async function exercise(name, work, signal = new AbortController().signal) {
  let current;
  const events = [];
  const runner = createOpenSandboxAgentRunner({ connection, profile,
    auth: { async accessToken() { throw new Error("This acceptance must never call a model"); } },
    async createSandbox(options) {
      current = await Sandbox.create(options);
      sandboxIds.push(current.id);
      return current;
    },
    async prepare({ sandbox }) {
      await sandbox.files.writeFiles([
        { path: "/work/input.csv", data: Buffer.from(CSV), mode: 600 },
        { path: "/work/empty.txt", data: new Uint8Array(0), mode: 600 },
        { path: "/work/pixel.png", data: png, mode: 600 },
      ]);
    },
    agentRunnerFactory: tools => ({ async run(request) {
      const tool = name => {
        const found = tools.find(item => item.name === name);
        assert.ok(found, `Missing tool ${name}`);
        return args => found.execute(args, request.signal);
      };
      return work(tool, current, request.signal);
    } }),
  });
  return runner.run({ runId: marker, stepRunId: name, attemptId: randomUUID(), signal,
    definition: { id: name, revision: "1", model: "unused", reasoningEffort: "low", promptRevision: "1",
      skillsRevision: "none", permissionsRevision: "1", config: openSandboxAgentConfig(profile, connection) },
    input: { csv: CSV }, async emit(type, data) { events.push({ type, data }); },
  });
}

try {
  const result = await exercise("file-command-pixels", async tool => {
    const material = await tool("read_file")({ path: "input.csv" });
    assert.equal(material.content, CSV);
    assert.equal((await tool("read_file")({ path: "empty.txt" })).content, "");
    await assert.rejects(tool("write_file")({ path: "input.csv", content: "overwrite" }), /denied/);
    await assert.rejects(tool("read_file")({ path: "../etc/passwd" }), /traversal/);
    await tool("write_file")({ path: "scripts/analyze.py", content: [
      "import csv, json", "totals = {}", "for row in csv.DictReader(open('/work/input.csv')):",
      "    totals[row['category']] = totals.get(row['category'], 0) + int(row['amount'])",
      "json.dump({'totals': totals}, open('/work/summary.json', 'w'))", "print('computed')",
    ].join("\n") });
    const execution = await tool("exec_allowed")({ name: "analyze" });
    assert.equal(execution.exitCode, 0);
    assert.match(execution.stdout, /computed/);
    const file = await tool("read_file")({ path: "/work/summary.json" });
    assert.deepEqual(JSON.parse(file.content), { totals: { A: 3, B: 5 } });
    const visual = await tool("read_image")({ path: "pixel.png" });
    assert.equal(visual.kind, "siwc_visual_tool_result");
    assert.equal(visual.images[0].base64, png.toString("base64"));
    return { output: JSON.parse(file.content), validation: "valid" };
  });
  assert.deepEqual(result.metadata.sandboxCleanup, { remoteKill: "succeeded", clientClose: "succeeded" });
  evidence.push("real file roundtrip, fixed Python command, validated JSON and actual image bytes");

  const controller = new AbortController();
  await assert.rejects(exercise("cancel-running-command", async (tool, sandbox) => {
    await tool("write_file")({ path: "scripts/analyze.py", content:
      "import time\nopen('/work/started', 'w').write('started')\ntime.sleep(60)\n" });
    const pending = tool("exec_allowed")({ name: "analyze" });
    // Attach a rejection handler immediately, while checking proof of actual command execution.
    const settled = pending.then(value => ({ value }), error => ({ error }));
    let started = false;
    for (let count = 0; count < 50; count++) {
      try { started = (await sandbox.files.readFile("/work/started")) === "started"; } catch { /* not created yet */ }
      if (started) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    controller.abort(new Error("acceptance-cancel"));
    const outcome = await settled;
    assert.ok(started, "Cancellation must follow actual remote execution");
    assert.ok(outcome.error, "Canceled command must not report success");
    throw outcome.error;
  }, controller.signal));
  evidence.push("canceled an actually running remote command");

  await assert.rejects(exercise("bounded-output-terminal", async tool => {
    await tool("write_file")({ path: "scripts/analyze.py", content: "print('x' * 20000)" });
    await assert.rejects(tool("exec_allowed")({ name: "analyze" }), /limit/);
    await assert.rejects(tool("exec_allowed")({ name: "analyze" }), /unknown|aborted|terminal/i);
    return { output: "must not be accepted after terminal failure" };
  }), /unknown|aborted|terminal/i);
  evidence.push("oversized output fails closed; no subsequent command or successful result");

  const remaining = await manager.listSandboxInfos({ metadata: { workflowRunId: marker } });
  assert.deepEqual(remaining.items, [], "Every tested remote environment must be deleted");
  evidence.push("provider metadata query confirms no test environments remain");
  console.log(JSON.stringify({ state: "passed", modelCalls: 0, createdSandboxes: sandboxIds.length, evidence }, null, 2));
} finally {
  // Cleanup is scoped to IDs created by this invocation; never sweep other work.
  for (const id of sandboxIds) {
    try { await manager.getSandboxInfo(id); await manager.killSandbox(id); }
    catch (error) { if (error.statusCode !== 404) throw error; }
  }
  await manager.close();
}
