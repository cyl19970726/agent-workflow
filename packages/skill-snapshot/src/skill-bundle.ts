import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FrozenSkillFile {
  path: string;
  contentBase64: string;
  mode: number;
  sha256: string;
  bytes: number;
}

export interface FrozenSkillBundle {
  kind: "skill_bundle";
  /** Absolute path of the SKILL.md that was supplied (or found in a supplied directory). */
  path: string;
  name: string;
  content: string;
  sha256: string;
  files: FrozenSkillFile[];
}

export interface MaterializedSkillFile {
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}

export interface MaterializedSkill {
  root: string;
  entrypoint: string;
  sha256: string;
  files: MaterializedSkillFile[];
}

const ENTRYPOINT = "SKILL.md";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeRelativePath(value: string): boolean {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !value.startsWith("/")
    && !value.includes("\\")
    && !/^[A-Za-z]:/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function safeName(directoryName: string): string {
  const normalized = directoryName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return normalized === "" ? "skill" : normalized;
}

function bundleDigest(files: readonly FrozenSkillFile[]): string {
  // JSON makes separators unambiguous while keeping the on-disk representation portable.
  return sha256(JSON.stringify(files.map((file) => ({
    path: file.path, mode: file.mode, contentBase64: file.contentBase64
  }))));
}

function readFileAt(logicalPath: string, rootReal: string): { data: Buffer; mode: number } {
  let resolved: string;
  try {
    resolved = fs.realpathSync(logicalPath);
  } catch (error) {
    throw new Error(`SKILL_BUNDLE_UNREADABLE:${logicalPath}:${String(error)}`);
  }
  if (!isWithin(rootReal, resolved)) throw new Error(`SKILL_BUNDLE_EXTERNAL_SYMLINK:${logicalPath}`);
  const stat = fs.statSync(logicalPath);
  if (!stat.isFile()) throw new Error(`SKILL_BUNDLE_UNSUPPORTED_ENTRY:${logicalPath}`);
  return { data: fs.readFileSync(logicalPath), mode: stat.mode & 0o777 };
}

/** Capture every non-metadata file in a skill package without depending on its source afterwards. */
export function snapshotSkill(skillPath: string): FrozenSkillBundle {
  const supplied = path.resolve(skillPath);
  let suppliedStat: fs.Stats;
  try { suppliedStat = fs.statSync(supplied); } catch (error) {
    throw new Error(`SKILL_BUNDLE_SOURCE_NOT_FOUND:${supplied}:${String(error)}`);
  }
  const entrypoint = suppliedStat.isDirectory() ? path.join(supplied, ENTRYPOINT) : supplied;
  if (path.basename(entrypoint) !== ENTRYPOINT) throw new Error(`SKILL_BUNDLE_ENTRYPOINT_REQUIRED:${entrypoint}`);
  const root = path.dirname(entrypoint);
  const rootReal = fs.realpathSync(root);
  const entryStat = readFileAt(entrypoint, rootReal);
  const files: FrozenSkillFile[] = [];

  const visit = (logicalDirectory: string, relativeDirectory: string, ancestors: ReadonlySet<string>): void => {
    let realDirectory: string;
    try { realDirectory = fs.realpathSync(logicalDirectory); } catch (error) {
      throw new Error(`SKILL_BUNDLE_UNREADABLE:${logicalDirectory}:${String(error)}`);
    }
    if (!isWithin(rootReal, realDirectory)) throw new Error(`SKILL_BUNDLE_EXTERNAL_SYMLINK:${logicalDirectory}`);
    if (ancestors.has(realDirectory)) throw new Error(`SKILL_BUNDLE_SYMLINK_CYCLE:${logicalDirectory}`);
    const nextAncestors = new Set(ancestors).add(realDirectory);
    for (const name of fs.readdirSync(logicalDirectory).sort()) {
      if (name === ".git" || name === ".DS_Store") continue;
      const logicalPath = path.join(logicalDirectory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const lstat = fs.lstatSync(logicalPath);
      if (lstat.isDirectory()) {
        visit(logicalPath, relativePath, nextAncestors);
        continue;
      }
      if (lstat.isSymbolicLink()) {
        const target = fs.realpathSync(logicalPath);
        if (!isWithin(rootReal, target)) throw new Error(`SKILL_BUNDLE_EXTERNAL_SYMLINK:${logicalPath}`);
        if (fs.statSync(logicalPath).isDirectory()) {
          visit(logicalPath, relativePath, nextAncestors);
          continue;
        }
      }
      const file = readFileAt(logicalPath, rootReal);
      files.push({ path: relativePath, contentBase64: file.data.toString("base64"), mode: file.mode,
        sha256: sha256(file.data), bytes: file.data.byteLength });
    }
  };

  visit(root, "", new Set());
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const entry = files.find((file) => file.path === ENTRYPOINT);
  if (!entry) throw new Error(`SKILL_BUNDLE_ENTRYPOINT_REQUIRED:${entrypoint}`);
  // Read above first so an entrypoint symlink gets the same containment checks even if traversal is changed later.
  void entryStat;
  const content = Buffer.from(entry.contentBase64, "base64").toString("utf8");
  const bundle: FrozenSkillBundle = { kind: "skill_bundle", path: entrypoint, name: safeName(path.basename(root)), content,
    sha256: bundleDigest(files), files };
  validateFrozenSkillBundle(bundle);
  return bundle;
}

function validBase64(value: string): boolean {
  try { return Buffer.from(value, "base64").toString("base64") === value; } catch { return false; }
}

/** Reject malformed or altered bundles before any materialization writes occur. */
export function validateFrozenSkillBundle(bundle: FrozenSkillBundle): void {
  if (!bundle || bundle.kind !== "skill_bundle") throw new Error("SKILL_BUNDLE_INVALID_KIND");
  if (typeof bundle.path !== "string" || bundle.path.includes("\0") || !path.isAbsolute(bundle.path) || path.basename(bundle.path) !== ENTRYPOINT) throw new Error("SKILL_BUNDLE_INVALID_ENTRYPOINT");
  if (typeof bundle.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundle.name)) throw new Error("SKILL_BUNDLE_INVALID_NAME");
  if (typeof bundle.content !== "string") throw new Error("SKILL_BUNDLE_INVALID_CONTENT");
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) throw new Error("SKILL_BUNDLE_INVALID_FILES");
  const seen = new Set<string>();
  const caseFolded = new Set<string>();
  const componentSpellings = new Map<string, string>();
  const componentCollisions: string[] = [];
  for (const file of bundle.files) {
    if (!file || !safeRelativePath(file.path) || seen.has(file.path)) throw new Error(`SKILL_BUNDLE_INVALID_PATH:${file?.path}`);
    seen.add(file.path);
    const folded = file.path.toLowerCase();
    if (caseFolded.has(folded)) throw new Error(`SKILL_BUNDLE_CASE_COLLISION:${file.path}`);
    caseFolded.add(folded);
    const segments = file.path.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const component = segments[index]!;
      const location = segments.slice(0, index + 1).map((part) => part.toLowerCase()).join("/");
      const prior = componentSpellings.get(location);
      if (prior !== undefined && prior !== component) componentCollisions.push(file.path);
      componentSpellings.set(location, component);
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error(`SKILL_BUNDLE_INVALID_MODE:${file.path}`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || !validBase64(file.contentBase64)) {
      throw new Error(`SKILL_BUNDLE_INVALID_FILE:${file.path}`);
    }
    const data = Buffer.from(file.contentBase64, "base64");
    if (data.byteLength !== file.bytes || sha256(data) !== file.sha256) throw new Error(`SKILL_BUNDLE_TAMPERED_FILE:${file.path}`);
  }
  for (const filePath of seen) {
    const segments = filePath.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      if (seen.has(segments.slice(0, length).join("/"))) throw new Error(`SKILL_BUNDLE_PREFIX_COLLISION:${filePath}`);
      if (caseFolded.has(segments.slice(0, length).join("/").toLowerCase())) throw new Error(`SKILL_BUNDLE_PREFIX_COLLISION:${filePath}`);
    }
  }
  if (componentCollisions.length > 0) throw new Error(`SKILL_BUNDLE_CASE_COMPONENT_COLLISION:${componentCollisions[0]}`);
  const entry = bundle.files.find((file) => file.path === ENTRYPOINT);
  if (!entry || Buffer.from(entry.contentBase64, "base64").toString("utf8") !== bundle.content) throw new Error("SKILL_BUNDLE_INVALID_CONTENT");
  if (!/^[a-f0-9]{64}$/.test(bundle.sha256) || bundle.sha256 !== bundleDigest(bundle.files)) throw new Error("SKILL_BUNDLE_TAMPERED_DIGEST");
}

/** Materialize a validated snapshot in a fresh, exact attempt directory. */
export function materializeSkill(bundle: FrozenSkillBundle, destination: string): MaterializedSkill {
  validateFrozenSkillBundle(bundle);
  if (typeof destination !== "string" || destination.includes("\0") || !path.isAbsolute(destination)) throw new Error(`SKILL_BUNDLE_DESTINATION_ABSOLUTE_REQUIRED:${destination}`);
  const root = path.resolve(destination);
  try {
    fs.lstatSync(root);
    throw new Error(`SKILL_BUNDLE_DESTINATION_EXISTS:${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  const files: MaterializedSkillFile[] = [];
  try {
    for (const file of bundle.files) {
      const output = path.join(root, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      const mode = (file.mode & 0o111) === 0 ? 0o600 : 0o700;
      fs.writeFileSync(output, Buffer.from(file.contentBase64, "base64"), { mode });
      fs.chmodSync(output, mode);
      files.push({ path: file.path, sha256: file.sha256, bytes: file.bytes, mode });
    }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, entrypoint: path.join(root, ENTRYPOINT), sha256: bundle.sha256, files };
}

function materializedFiles(bundle: FrozenSkillBundle): MaterializedSkillFile[] {
  return bundle.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes,
    mode: (file.mode & 0o111) === 0 ? 0o600 : 0o700 }));
}

function verifyExistingStage(bundle: FrozenSkillBundle, root: string): MaterializedSkill {
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(root); } catch (error) { throw new Error(`SKILL_BUNDLE_STAGE_UNREADABLE:${root}:${String(error)}`); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`SKILL_BUNDLE_STAGE_INVALID_ROOT:${root}`);
  const actual = new Map<string, MaterializedSkillFile>();
  const visit = (directory: string, relative: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const fullPath = path.join(directory, name);
      const relativePath = relative === "" ? name : `${relative}/${name}`;
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`SKILL_BUNDLE_STAGE_SYMLINK:${relativePath}`);
      if (stat.isDirectory()) { visit(fullPath, relativePath); continue; }
      if (!stat.isFile()) throw new Error(`SKILL_BUNDLE_STAGE_UNSUPPORTED_ENTRY:${relativePath}`);
      const data = fs.readFileSync(fullPath);
      actual.set(relativePath, { path: relativePath, sha256: sha256(data), bytes: data.byteLength, mode: stat.mode & 0o777 });
    }
  };
  visit(root, "");
  const expected = materializedFiles(bundle);
  if (actual.size !== expected.length) throw new Error(`SKILL_BUNDLE_STAGE_TREE_MISMATCH:${root}`);
  for (const file of expected) {
    const found = actual.get(file.path);
    if (!found || found.sha256 !== file.sha256 || found.bytes !== file.bytes || found.mode !== file.mode) {
      throw new Error(`SKILL_BUNDLE_STAGE_TREE_MISMATCH:${file.path}`);
    }
  }
  return { root, entrypoint: path.join(root, ENTRYPOINT), sha256: bundle.sha256, files: expected };
}

/** Stage under a working directory, safely reusing only an exact prior materialization. */
export function stageSkill(bundle: FrozenSkillBundle, workingDirectory: string): MaterializedSkill {
  validateFrozenSkillBundle(bundle);
  if (typeof workingDirectory !== "string" || workingDirectory.includes("\0") || !path.isAbsolute(workingDirectory)) {
    throw new Error(`SKILL_BUNDLE_WORKING_DIRECTORY_ABSOLUTE_REQUIRED:${workingDirectory}`);
  }
  const workingRoot = path.resolve(workingDirectory);
  let workingStat: fs.Stats;
  try { workingStat = fs.lstatSync(workingRoot); } catch (error) { throw new Error(`SKILL_BUNDLE_WORKING_DIRECTORY_UNREADABLE:${workingRoot}:${String(error)}`); }
  if (workingStat.isSymbolicLink() || !workingStat.isDirectory()) throw new Error(`SKILL_BUNDLE_WORKING_DIRECTORY_INVALID:${workingRoot}`);
  const parent = path.join(workingRoot, ".agents");
  const skills = path.join(parent, "skills");
  ensurePrivateStageDirectory(parent);
  ensurePrivateStageDirectory(skills);
  const destination = path.join(skills, bundle.name);
  try {
    fs.lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return materializeSkill(bundle, destination);
    throw error;
  }
  return verifyExistingStage(bundle, destination);
}

function ensurePrivateStageDirectory(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`SKILL_BUNDLE_STAGE_PARENT_INVALID:${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}
