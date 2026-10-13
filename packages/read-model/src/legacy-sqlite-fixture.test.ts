import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("historical SQLite record fixture", () => {
  it("preserves the pre-extraction run, attempt, and artifact as read-only evidence", () => {
    const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/pre-extraction-sqlite-records.json", import.meta.url), "utf8")) as {
      fixturePurpose: string;
      source: string;
      records: Record<string, { id?: string; state?: string; sha256?: string }>;
    };
    expect(fixture.fixturePurpose).toContain("read-only historical record evidence");
    expect(fixture.source).toBe("pre-extraction self-media adapter c460d1cd");
    expect(fixture.records.run).toMatchObject({ id: "legacy-run-1", state: "succeeded" });
    expect(fixture.records.step).toMatchObject({ id: "legacy-step-1", state: "succeeded" });
    expect(fixture.records.attempt).toMatchObject({ id: "legacy-attempt-1", state: "succeeded" });
    expect(fixture.records.artifact).toMatchObject({ id: "legacy-artifact-1", sha256: expect.stringMatching(/^[a-f\d]{64}$/) });
    expect(fixture.records.artifactPayload).toEqual({ candidate: "retained", evidenceRefs: ["source:1"] });
  });
});
