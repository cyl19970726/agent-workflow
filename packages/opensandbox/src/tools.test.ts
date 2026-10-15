import { expect, it } from "vitest";
import type { Sandbox } from "@alibaba-group/opensandbox";
import { createOpenSandboxWorkspaceTools, readBoundedSandboxBytes, relativeSandboxPath,
  workspaceRelativePath } from "./tools.js";

it("rejects traversal and absolute paths before invoking remote file APIs", async () => {
  let remoteCalls = 0;
  const sandbox = { id: "test", files: { async writeFiles() { remoteCalls++; } },
    commands: {}, async kill() {}, async close() {} } as unknown as Sandbox;
  const gate = { assertOpen(signal: AbortSignal) { signal.throwIfAborted(); }, terminal() {} };
  const tools = createOpenSandboxWorkspaceTools(sandbox, {
    workspaceRoot: "/work", writePrefixes: ["scripts"], commands: {},
    maxReadBytes: 100, maxWriteBytes: 100, maxOutputBytes: 100, maxImageBytes: 100,
  }, gate);
  const write = tools.find(tool => tool.name === "write_file")!;
  for (const path of ["../secret", "/etc/passwd", "/work-other/a.py", "/work/../secret",
    "scripts/../secret", "scripts\\evil", "other/a.py"]) {
    await expect(write.execute({ path, content: "x" }, new AbortController().signal)).rejects.toThrow();
  }
  expect(remoteCalls).toBe(0);
  await expect(write.execute({ path: "/work/scripts/a.py", content: "x" }, new AbortController().signal))
    .resolves.toMatchObject({ path: "scripts/a.py" });
  expect(remoteCalls).toBe(1);
  expect(() => relativeSandboxPath("scripts/a.py")).not.toThrow();
  expect(workspaceRelativePath("/work/summary.json", "/work")).toBe("summary.json");
  for (const path of ["/etc/passwd", "/work-other/summary.json", "/work/../etc/passwd"])
    expect(() => workspaceRelativePath(path, "/work")).toThrow();
});

it("reads an absolute container path only inside the declared workspace", async () => {
  let remotePath = "";
  const sandbox = { id: "test", files: { async *readBytesStream(path: string) {
    remotePath = path;
    yield Buffer.from("ok");
  } }, commands: {}, async kill() {}, async close() {} } as unknown as Sandbox;
  const tools = createOpenSandboxWorkspaceTools(sandbox, {
    workspaceRoot: "/work", writePrefixes: [], commands: {},
    maxReadBytes: 100, maxWriteBytes: 100, maxOutputBytes: 100, maxImageBytes: 100,
  }, { assertOpen(signal) { signal.throwIfAborted(); }, terminal() {} });
  const read = tools.find(tool => tool.name === "read_file")!;
  await expect(read.execute({ path: "/work/summary.json" }, new AbortController().signal))
    .resolves.toEqual({ path: "summary.json", content: "ok" });
  expect(remotePath).toBe("/work/summary.json");
  for (const path of ["/etc/passwd", "/work-other/file", "/work/../etc/passwd"])
    await expect(read.execute({ path }, new AbortController().signal)).rejects.toThrow();
});

it("returns actual bounded image pixels", async () => {
  const png = Buffer.from("iVBORw0KGgo=", "base64");
  const sandbox = { id: "test", files: { async *readBytesStream(_path: string, opts: {range:string}) {
    expect(opts.range).toBe("bytes=0-100");
    yield png;
  } }, commands: {}, async kill() {}, async close() {} } as unknown as Sandbox;
  const tools = createOpenSandboxWorkspaceTools(sandbox, {
    workspaceRoot: "/work", writePrefixes: [], commands: {},
    maxReadBytes: 100, maxWriteBytes: 100, maxOutputBytes: 100, maxImageBytes: 100,
  }, { assertOpen(signal) { signal.throwIfAborted(); }, terminal() {} });
  const read = tools.find(tool => tool.name === "read_image")!;
  const result = await read.execute({ path: "sample.png" }, new AbortController().signal);
  expect(result).toMatchObject({ kind: "siwc_visual_tool_result", images: [{ mimeType: "image/png", base64: png.toString("base64") }] });
});

it("preserves CRLF and binary bytes through Range streaming", async () => {
  const original = Buffer.from([65, 13, 10, 0, 255, 66, 13, 10]);
  const sandbox = { files: { async *readBytesStream(_path: string, opts: {range:string}) {
    expect(opts.range).toBe("bytes=0-8");
    yield original.subarray(0, 3);
    yield original.subarray(3);
  } } } as unknown as Sandbox;
  const bytes = await readBoundedSandboxBytes(sandbox, "/work/data.bin", 8, new AbortController().signal);
  expect(Buffer.from(bytes)).toEqual(original);
});

it("stops on the first oversized streamed chunk", async () => {
  let finished = false;
  const sandbox = { files: { async *readBytesStream() {
    try { yield Buffer.alloc(5); yield Buffer.alloc(5); yield Buffer.alloc(1000); }
    finally { finished = true; }
  } } } as unknown as Sandbox;
  await expect(readBoundedSandboxBytes(sandbox, "/work/large.bin", 8, new AbortController().signal))
    .rejects.toThrow("exceeds read limit");
  expect(finished).toBe(true);
});
