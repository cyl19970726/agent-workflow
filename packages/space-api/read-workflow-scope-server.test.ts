import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SpaceOverview, WorkflowSpaceService } from "@signal-room/workflow-spaces";
import { createWorkflowSpaceApiHandler } from "./server.js";

const space = { id: "s", purpose: "Post analysis", owner: "alice", status: "active", createdAt: "2026-01-01T00:00:00Z" } as SpaceOverview["space"];
const entry = { workflowId: "post.review", codeRevision: "1", storageContract: { nodes: {}, schemas: [], hash: "storage" },
  process: { revision: "1", hash: "process", nodes: [], edges: [], results: [] } };
const version = { id: "review-version", spaceId: "s", revision: "1", createdAt: "2026-01-01T00:00:00Z",
  changeReason: "review", hash: "hash", config: {}, entrypoints: { post: entry } } as unknown as SpaceOverview["workflows"][number];
const run = { runId: "review-run", spaceId: "s", workflowVersionId: version.id, entrypoint: "post", caseId: "case",
  inputManifestId: "manifest", configHash: "config", effectiveConfig: {} } as SpaceOverview["runs"][number];
const selectedCase = { id: "case", spaceId: "s", title: "Source post", objective: "Review", constraints: [] } as SpaceOverview["cases"][number];
const active: Server[] = [];
afterEach(async () => Promise.all(active.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))));

async function serve(auxiliaryWorkflowIds: string[]) {
  const calls: Array<unknown[]> = [];
  const service = {
    listSpaces: async () => [space], readRun: async () => run, readWorkflowVersion: async () => version,
    readCase: async () => selectedCase, readManifest: async () => ({ id: "manifest", spaceId: "s", caseId: "case", assets: {}, hash: "manifest-hash" }),
    readAssetsByIds: async () => [], runAssets: async () => [], getExecutionTask: async () => undefined,
    resolvePresentation: async () => null, validationPlans: async () => [],
    caseRunsPage: async (...args: unknown[]) => { calls.push(args); return [run]; },
    versionRunStats: async (...args: unknown[]) => { calls.push(args); return { runCount: 1, caseCount: 1 }; },
    spaceSummary: async () => ({ space, versionCount: 2, caseCount: 1, runCount: 1, assetCount: 0,
      latestVersionId: "primary-version", adoptedVersionId: null }),
    overview: async () => ({ space, workflows: [version], cases: [selectedCase], runs: [run], assets: [],
      reviews: [], adoptions: [], validationPlans: [], executionTasks: [] }),
  } as unknown as WorkflowSpaceService;
  const handler = createWorkflowSpaceApiHandler({ cursorSecret: "test-secret-32-bytes-long-123456789",
    resolveHost: () => ({ principal: { id: "alice", kind: "human" }, cacheScope: "session", service,
      scope: { workflowId: "post.analyze", entrypoint: "post", auxiliaryWorkflowIds } }) });
  const server = createServer(async (request, response) => { if (!await handler(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  active.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow-spaces/v1/spaces/s`, calls };
}

describe("auxiliary workflow reads", () => {
  it("reads only explicitly allowed child versions and runs, including exact Case pagination", async () => {
    const allowed = await serve(["post.review"]);
    const headers = { authorization: "alice" };
    expect((await fetch(`${allowed.url}/versions/review-version`, { headers })).status).toBe(200);
    expect((await fetch(`${allowed.url}/runs/review-run`, { headers })).status).toBe(200);
    const caseRuns = await fetch(`${allowed.url}/cases/case/runs`, { headers });
    expect(caseRuns.status).toBe(200);
    expect(await caseRuns.json()).toMatchObject({ items: [{ id: "review-run" }] });
    expect(allowed.calls.some(args => Array.isArray(args[2]) && (args[2] as string[]).includes("post.review"))).toBe(true);
    expect(allowed.calls.some(args => args[0] === "s" && args[1] === "review-version" && args[3] === "post.review")).toBe(true);
    const summary = await fetch(`${allowed.url}/summary`, { headers });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ counts: { runs: 1 }, latestVersionId: "primary-version" });

    const denied = await serve([]);
    expect((await fetch(`${denied.url}/versions/review-version`, { headers })).status).not.toBe(200);
    expect((await fetch(`${denied.url}/runs/review-run`, { headers })).status).not.toBe(200);
    expect((await fetch(`${denied.url}/cases/case/runs`, { headers })).status).not.toBe(200);
  });
});
