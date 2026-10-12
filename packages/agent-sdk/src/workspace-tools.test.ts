import { execPath } from "node:process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "./workspace-tools.js";

const roots: string[] = [];
async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function getTool(tools: Awaited<ReturnType<typeof createWorkspaceTools>>, name: string) {
  const selected = tools.find(tool => tool.name === name);
  if (!selected) throw new Error(`Missing tool ${name}`);
  return selected;
}
const args = (value: unknown) => value as never;

describe("createWorkspaceTools", () => {
  it("reads workspace and reference roots but limits writes to approved prefixes", async () => {
    const root = await directory("workspace-tools-");
    const reference = await directory("workspace-reference-");
    await mkdir(join(root, "frames-spec"));
    await writeFile(join(reference, "guide.md"), "reference text");
    const tools = await createWorkspaceTools({ root, readRoots: [reference], writePaths: ["frames-spec/"] });
    const read = getTool(tools, "read_file");
    const write = getTool(tools, "write_file");
    const listing = await getTool(tools, "list_directory").execute(args({ root: "workspace", path: "." }), new AbortController().signal);
    expect(listing).toMatchObject({ entries: [{ name: "frames-spec", type: "directory" }] });

    expect(await read.execute(args({ root: "read-0", path: "guide.md" }), new AbortController().signal))
      .toMatchObject({ root: "read-0", content: "reference text" });
    await expect(write.execute(args({ path: "frames-spec/one.py", content: "print('ok')" }), new AbortController().signal))
      .resolves.toMatchObject({ path: "frames-spec/one.py" });
    expect(await readFile(join(root, "frames-spec/one.py"), "utf8")).toBe("print('ok')");
    await expect(write.execute(args({ path: "outside.py", content: "no" }), new AbortController().signal))
      .rejects.toThrow("outside approved write paths");
    await expect(write.execute(args({ path: "../escape.py", content: "no" }), new AbortController().signal))
      .rejects.toThrow("traversal");
  });

  it("rejects traversal and symlinks whose targets leave the selected root", async () => {
    const root = await directory("workspace-tools-");
    const outside = await directory("workspace-outside-");
    await writeFile(join(outside, "private.txt"), "private");
    await symlink(join(outside, "private.txt"), join(root, "escape.txt"));
    const tools = await createWorkspaceTools({ root });
    const read = getTool(tools, "read_file");
    await expect(read.execute(args({ root: "workspace", path: "../private.txt" }), new AbortController().signal))
      .rejects.toThrow("traversal");
    await expect(read.execute(args({ root: "workspace", path: "escape.txt" }), new AbortController().signal))
      .rejects.toThrow("escapes its bound root");
  });

  it("returns actual image pixels as a visual tool result", async () => {
    const root = await directory("workspace-tools-");
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    await writeFile(join(root, "frame.png"), png);
    const tools = await createWorkspaceTools({ root });
    const result = await getTool(tools, "read_image").execute(args({ root: "workspace", path: "frame.png" }), new AbortController().signal);
    expect(result).toMatchObject({ kind: "siwc_visual_tool_result", value: { mimeType: "image/png" },
      images: [{ mimeType: "image/png", base64: png.toString("base64"), detail: "high" }] });
  });

  it("executes only registered commands and does not pass arguments through unless enabled", async () => {
    const root = await directory("workspace-tools-");
    const tools = await createWorkspaceTools({ root, commands: {
      fixed: { command: execPath, args: ["-e", "process.stdout.write('fixed')"] },
      literal: { command: execPath, args: ["-e", "process.stdout.write(process.argv[1] ?? '')"], allowAdditionalArgs: true },
    } });
    const execute = getTool(tools, "exec_allowed");
    await expect(execute.execute(args({ name: "unknown" }), new AbortController().signal)).rejects.toThrow("Unauthorized workspace command");
    await expect(execute.execute(args({ name: "fixed", args: ["ignored"] }), new AbortController().signal))
      .rejects.toThrow("Additional arguments are not allowed");
    await expect(execute.execute(args({ name: "fixed" }), new AbortController().signal))
      .resolves.toMatchObject({ command: "fixed", exitCode: 0, stdout: "fixed", stderr: "" });
    await expect(execute.execute(args({ name: "literal", args: ["; process.exit(99)"] }), new AbortController().signal))
      .resolves.toMatchObject({ command: "literal", exitCode: 0, stdout: "; process.exit(99)" });
  });

  it("cancels a running command and does not wait for its normal completion", async () => {
    const root = await directory("workspace-tools-");
    const tools = await createWorkspaceTools({ root, commands: {
      wait: { command: execPath, args: ["-e", "setTimeout(() => {}, 30000)"] },
    } });
    const execute = getTool(tools, "exec_allowed");
    const controller = new AbortController();
    const aborted = new Promise<void>(resolve => {
      const interval = setInterval(() => { if (controller.signal.aborted) { clearInterval(interval); resolve(); } }, 2);
    });
    const running = execute.execute(args({ name: "wait" }), controller.signal);
    const rejection = expect(running).rejects.toThrow("run canceled");
    setTimeout(() => controller.abort(new Error("run canceled")), 30);
    await aborted;
    await rejection;
  });
});
