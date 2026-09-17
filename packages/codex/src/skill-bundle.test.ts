import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeSkill, snapshotSkill, stageSkill, validateFrozenSkillBundle } from "./skill-bundle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bundle-")); roots.push(root); return root; }
function fixture(): { root: string; skill: string } {
  const root = temp(); const skill = path.join(root, "my-skill");
  fs.mkdirSync(path.join(skill, "references"), { recursive: true }); fs.mkdirSync(path.join(skill, "scripts"));
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# My skill\n");
  fs.writeFileSync(path.join(skill, "references", "guide.md"), "guide");
  fs.writeFileSync(path.join(skill, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  fs.chmodSync(path.join(skill, "scripts", "run.sh"), 0o755);
  fs.writeFileSync(path.join(skill, "asset.bin"), Buffer.from([0, 255, 16, 128]));
  return { root, skill };
}

describe("skill bundles", () => {
  it("captures a full package, including binary files and executable mode, then stages after source removal", () => {
    const { skill } = fixture(); const bundle = snapshotSkill(skill);
    expect(bundle.path).toBe(path.join(skill, "SKILL.md"));
    expect(bundle.files.map((file) => file.path)).toEqual(["SKILL.md", "asset.bin", "references/guide.md", "scripts/run.sh"]);
    expect(bundle.files.find((file) => file.path === "asset.bin")?.contentBase64).toBe(Buffer.from([0, 255, 16, 128]).toString("base64"));
    fs.rmSync(skill, { recursive: true });
    const staged = materializeSkill(bundle, path.join(temp(), "attempt-skill"));
    expect(fs.readFileSync(path.join(staged.root, "asset.bin"))).toEqual(Buffer.from([0, 255, 16, 128]));
    expect(fs.statSync(path.join(staged.root, "scripts", "run.sh")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(staged.root, "references", "guide.md")).mode & 0o777).toBe(0o600);
  });

  it("changes digest when a supporting reference changes", () => {
    const { skill } = fixture(); const first = snapshotSkill(path.join(skill, "SKILL.md"));
    fs.writeFileSync(path.join(skill, "references", "guide.md"), "revised guide");
    expect(snapshotSkill(skill).sha256).not.toBe(first.sha256);
  });

  it("rejects traversals, invalid base64, tampering, and preexisting destinations before writes", () => {
    const { skill } = fixture(); const bundle = snapshotSkill(skill); const target = path.join(temp(), "target");
    expect(() => materializeSkill({ ...bundle, files: [{ ...bundle.files[0]!, path: "../escape" }] }, target)).toThrow("SKILL_BUNDLE_INVALID_PATH");
    expect(() => materializeSkill({ ...bundle, files: [...bundle.files, bundle.files[0]!] }, target)).toThrow("SKILL_BUNDLE_INVALID_PATH");
    expect(() => validateFrozenSkillBundle({ ...bundle, files: [{ ...bundle.files[0]!, path: "A" }, { ...bundle.files[1]!, path: "a/run.sh" }] })).toThrow("SKILL_BUNDLE_PREFIX_COLLISION");
    expect(() => validateFrozenSkillBundle({ ...bundle, files: [{ ...bundle.files[0]!, path: "Refs/a" }, { ...bundle.files[1]!, path: "refs/b" }] })).toThrow("SKILL_BUNDLE_CASE_COMPONENT_COLLISION");
    expect(() => validateFrozenSkillBundle({ ...bundle, files: [{ ...bundle.files[0]!, path: "bad\0path" }] })).toThrow("SKILL_BUNDLE_INVALID_PATH");
    expect(() => validateFrozenSkillBundle({ ...bundle, files: [{ ...bundle.files[0]!, path: "C:/drive" }] })).toThrow("SKILL_BUNDLE_INVALID_PATH");
    expect(() => materializeSkill({ ...bundle, files: bundle.files.map((file, index) => index ? file : { ...file, contentBase64: "!not-base64!" }) }, target)).toThrow("SKILL_BUNDLE_INVALID_FILE");
    expect(() => materializeSkill({ ...bundle, sha256: "0".repeat(64) }, target)).toThrow("SKILL_BUNDLE_TAMPERED_DIGEST");
    fs.mkdirSync(target); expect(() => materializeSkill(bundle, target)).toThrow("SKILL_BUNDLE_DESTINATION_EXISTS");
  });

  it("allows internal symlinks and rejects external symlinks", () => {
    const { root, skill } = fixture();
    fs.symlinkSync("references/guide.md", path.join(skill, "linked-guide.md"));
    expect(snapshotSkill(skill).files.some((file) => file.path === "linked-guide.md")).toBe(true);
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(skill, "outside.txt"));
    fs.writeFileSync(path.join(root, "outside.txt"), "outside");
    expect(() => snapshotSkill(skill)).toThrow("SKILL_BUNDLE_EXTERNAL_SYMLINK");
  });

  it("rejects an internal directory symlink cycle", () => {
    const { skill } = fixture();
    fs.symlinkSync(".", path.join(skill, "cycle"), "dir");
    expect(() => snapshotSkill(skill)).toThrow("SKILL_BUNDLE_SYMLINK_CYCLE");
  });

  it("reuses only an exact staged tree and rejects changed or stale trees", () => {
    const { skill } = fixture(); const bundle = snapshotSkill(skill);
    const exactWorking = temp(); const first = stageSkill(bundle, exactWorking); const second = stageSkill(bundle, exactWorking);
    expect(second).toEqual(first);

    const changedWorking = temp(); const changed = stageSkill(bundle, changedWorking);
    fs.writeFileSync(path.join(changed.root, "asset.bin"), "changed");
    expect(() => stageSkill(bundle, changedWorking)).toThrow("SKILL_BUNDLE_STAGE_TREE_MISMATCH");

    const staleWorking = temp(); const stale = stageSkill(bundle, staleWorking);
    fs.writeFileSync(path.join(stale.root, "leftover.txt"), "stale");
    expect(() => stageSkill(bundle, staleWorking)).toThrow("SKILL_BUNDLE_STAGE_TREE_MISMATCH");
  });

  it("refuses .agents and skills parent symlinks before staging", () => {
    const { skill } = fixture(); const bundle = snapshotSkill(skill);
    const external = temp(); const agentsLinkWorking = temp();
    fs.symlinkSync(external, path.join(agentsLinkWorking, ".agents"), "dir");
    expect(() => stageSkill(bundle, agentsLinkWorking)).toThrow("SKILL_BUNDLE_STAGE_PARENT_INVALID");
    expect(fs.existsSync(path.join(external, "skills", bundle.name))).toBe(false);

    const skillsLinkWorking = temp(); fs.mkdirSync(path.join(skillsLinkWorking, ".agents"));
    fs.symlinkSync(external, path.join(skillsLinkWorking, ".agents", "skills"), "dir");
    expect(() => stageSkill(bundle, skillsLinkWorking)).toThrow("SKILL_BUNDLE_STAGE_PARENT_INVALID");
    expect(fs.existsSync(path.join(external, bundle.name))).toBe(false);
  });
});
