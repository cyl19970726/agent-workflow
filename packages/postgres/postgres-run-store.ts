import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ArtifactDraft, ArtifactRef, AttemptRecord, EventDraft, RunRecord, RunStore,
  StepRecord, StepResultCommit, StepResultReceipt, WorkflowEvent,
} from "@signal-room/workflow";
import { artifactPayloadSha256, canonicalWorkflowValue } from "@signal-room/workflow";

type Queryable = Pool | PoolClient;
type Table = "aw_runs" | "aw_steps" | "aw_attempts";
type Stored<T> = { document: T };
const json = (value: unknown): string => JSON.stringify(canonicalWorkflowValue(value));

/** Additive, repeatable schema migration. The advisory lock serializes concurrent migrators. */
export async function migratePostgresWorkflowStore(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4832941, 1)");
    await client.query(`CREATE TABLE IF NOT EXISTS aw_schema_migrations (
      component text PRIMARY KEY, version integer NOT NULL CHECK (version > 0)
    )`);
    const applied = await client.query<{ version: number }>(
      "SELECT version FROM aw_schema_migrations WHERE component = $1", ["workflow-run-store"]);
    // Bump this version and add the upgrade DDL whenever the ledger schema changes.
    if (applied.rows[0]?.version === 1) {
      await client.query("COMMIT");
      return;
    }
    if (applied.rows[0]) throw new Error("Unsupported workflow run store schema version");
    await client.query(`
      CREATE TABLE IF NOT EXISTS aw_runs (
        workspace_id text NOT NULL, id text NOT NULL, parent_run_id text,
        next_event_seq bigint NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
        created_at bigint GENERATED ALWAYS AS IDENTITY,
        document jsonb NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, parent_run_id) REFERENCES aw_runs(workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS aw_runs_parent_idx ON aw_runs(workspace_id, parent_run_id);
      CREATE TABLE IF NOT EXISTS aw_steps (
        workspace_id text NOT NULL, run_id text NOT NULL, id text NOT NULL,
        created_at bigint GENERATED ALWAYS AS IDENTITY,
        document jsonb NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, run_id, id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES aw_runs(workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS aw_steps_run_idx ON aw_steps(workspace_id, run_id, created_at);
      CREATE TABLE IF NOT EXISTS aw_attempts (
        workspace_id text NOT NULL, run_id text NOT NULL, step_run_id text NOT NULL, id text NOT NULL,
        created_at bigint GENERATED ALWAYS AS IDENTITY,
        document jsonb NOT NULL,
        PRIMARY KEY (workspace_id, id),
        UNIQUE (workspace_id, run_id, step_run_id, id),
        FOREIGN KEY (workspace_id, run_id, step_run_id) REFERENCES aw_steps(workspace_id, run_id, id)
      );
      CREATE INDEX IF NOT EXISTS aw_attempts_step_idx ON aw_attempts(workspace_id, step_run_id, created_at);
      CREATE TABLE IF NOT EXISTS aw_events (
        workspace_id text NOT NULL, run_id text NOT NULL, seq bigint NOT NULL,
        id text NOT NULL, step_run_id text, attempt_id text,
        document jsonb NOT NULL,
        PRIMARY KEY (workspace_id, run_id, seq),
        UNIQUE (workspace_id, id),
        CHECK (attempt_id IS NULL OR step_run_id IS NOT NULL),
        FOREIGN KEY (workspace_id, run_id) REFERENCES aw_runs(workspace_id, id),
        FOREIGN KEY (workspace_id, run_id, step_run_id) REFERENCES aw_steps(workspace_id, run_id, id),
        FOREIGN KEY (workspace_id, run_id, step_run_id, attempt_id)
          REFERENCES aw_attempts(workspace_id, run_id, step_run_id, id)
      );
      CREATE TABLE IF NOT EXISTS aw_artifacts (
        workspace_id text NOT NULL, run_id text NOT NULL, step_run_id text NOT NULL,
        attempt_id text NOT NULL, id text NOT NULL,
        created_at bigint GENERATED ALWAYS AS IDENTITY,
        document jsonb NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, run_id, step_run_id, attempt_id)
          REFERENCES aw_attempts(workspace_id, run_id, step_run_id, id)
      );
      CREATE INDEX IF NOT EXISTS aw_artifacts_run_idx ON aw_artifacts(workspace_id, run_id, created_at);
      CREATE TABLE IF NOT EXISTS aw_artifact_dependencies (
        workspace_id text NOT NULL, artifact_id text NOT NULL, dependency_id text NOT NULL,
        PRIMARY KEY (workspace_id, artifact_id, dependency_id),
        FOREIGN KEY (workspace_id, artifact_id) REFERENCES aw_artifacts(workspace_id, id),
        FOREIGN KEY (workspace_id, dependency_id) REFERENCES aw_artifacts(workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS aw_step_commits (
        workspace_id text NOT NULL, run_id text NOT NULL, step_run_id text NOT NULL,
        attempt_id text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
        receipt jsonb NOT NULL,
        PRIMARY KEY (workspace_id, run_id, idempotency_key),
        UNIQUE (workspace_id, attempt_id),
        FOREIGN KEY (workspace_id, run_id, step_run_id, attempt_id)
          REFERENCES aw_attempts(workspace_id, run_id, step_run_id, id)
      );
    `);
    await client.query("INSERT INTO aw_schema_migrations(component, version) VALUES ($1, $2)", ["workflow-run-store", 1]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/** Workspace identity must come from trusted server context, never a request body. */
export class PostgresWorkflowRunStore implements RunStore {
  private readonly workspaceId: string;
  private readonly transaction?: PoolClient;
  private get db(): Queryable { return this.transaction ?? this.pool; }
  constructor(private readonly pool: Pool, options: { workspaceId: string; transaction?: PoolClient }) {
    if (!options?.workspaceId || options.workspaceId.trim() !== options.workspaceId) {
      throw new Error("A trusted, nonempty workspaceId is required");
    }
    this.workspaceId = options.workspaceId;
    this.transaction = options.transaction;
  }

  /** Participate in a caller-owned transaction; the caller must commit/rollback it. */
  inTransaction(client: PoolClient): PostgresWorkflowRunStore {
    return new PostgresWorkflowRunStore(this.pool, { workspaceId: this.workspaceId, transaction: client });
  }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.transaction) return work(this.transaction);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async read<T>(db: Queryable, table: Table, id: string): Promise<T | undefined> {
    const result = await db.query<Stored<T>>(`SELECT document FROM ${table} WHERE workspace_id = $1 AND id = $2`, [this.workspaceId, id]);
    return result.rows[0]?.document;
  }

  private async patch(table: Table, id: string, patch: object): Promise<void> {
    await this.tx(async (db) => {
      const current = await db.query<Stored<Record<string, unknown>>>(
        `SELECT document FROM ${table} WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [this.workspaceId, id]);
      if (!current.rows[0]) throw new Error(`Workflow record not found: ${id}`);
      await db.query(`UPDATE ${table} SET document = $3::jsonb WHERE workspace_id = $1 AND id = $2`,
        [this.workspaceId, id, json({ ...current.rows[0].document, ...patch })]);
    });
  }

  async createRun(input: Omit<RunRecord, "id">): Promise<RunRecord> {
    const record = { ...input, id: randomUUID() };
    if (record.parentStepRunId) {
      if (!record.parentRunId) throw new Error("Parent step requires a parent run");
      const parent = await this.db.query(
        "SELECT 1 FROM aw_steps WHERE workspace_id=$1 AND run_id=$2 AND id=$3",
        [this.workspaceId, record.parentRunId, record.parentStepRunId]);
      if (!parent.rowCount) throw new Error("Parent step does not belong to parent run");
    }
    await this.db.query("INSERT INTO aw_runs(workspace_id, id, parent_run_id, document) VALUES ($1, $2, $3, $4::jsonb)",
      [this.workspaceId, record.id, record.parentRunId ?? null, json(record)]);
    return record;
  }
  getRun(id: string): Promise<RunRecord | undefined> { return this.read(this.db, "aw_runs", id); }
  async listRuns(filter?: Parameters<RunStore["listRuns"]>[0]): Promise<RunRecord[]> {
    const params: unknown[] = [this.workspaceId];
    let sql = "SELECT document FROM aw_runs WHERE workspace_id = $1";
    if (filter?.parentRunId !== undefined) { params.push(filter.parentRunId); sql += ` AND parent_run_id = $${params.length}`; }
    if (filter?.metadata && Object.keys(filter.metadata).length) {
      params.push(json(filter.metadata)); sql += ` AND document->'metadata' @> $${params.length}::jsonb`;
    }
    const result = await this.db.query<Stored<RunRecord>>(`${sql} ORDER BY created_at DESC`, params);
    return result.rows.map((row) => row.document);
  }
  updateRun(id: string, patch: Parameters<RunStore["updateRun"]>[1]): Promise<void> { return this.patch("aw_runs", id, patch); }
  async createStep(input: Omit<StepRecord, "id">): Promise<StepRecord> {
    const record = { ...input, id: randomUUID() };
    await this.db.query("INSERT INTO aw_steps(workspace_id, run_id, id, document) VALUES ($1, $2, $3, $4::jsonb)",
      [this.workspaceId, record.runId, record.id, json(record)]);
    return record;
  }
  async listSteps(runId: string): Promise<StepRecord[]> {
    const result = await this.db.query<Stored<StepRecord>>(
      "SELECT document FROM aw_steps WHERE workspace_id = $1 AND run_id = $2 ORDER BY created_at", [this.workspaceId, runId]);
    return result.rows.map((row) => row.document);
  }
  async findReusableStep(query: Parameters<RunStore["findReusableStep"]>[0]): Promise<StepRecord | undefined> {
    const steps = await this.listSteps(query.runId);
    return steps.reverse().find((step) => step.state === "succeeded" && step.validation === "valid"
      && (["runId", "workflowId", "workflowRevision", "key", "kind", "inputFingerprint", "configFingerprint"] as const)
        .every((key) => step[key] === query[key]));
  }
  updateStep(id: string, patch: Parameters<RunStore["updateStep"]>[1]): Promise<void> { return this.patch("aw_steps", id, patch); }
  async createAttempt(input: Omit<AttemptRecord, "id">): Promise<AttemptRecord> {
    const record = { ...input, id: randomUUID() };
    await this.db.query(
      "INSERT INTO aw_attempts(workspace_id, run_id, step_run_id, id, document) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [this.workspaceId, record.runId, record.stepRunId, record.id, json(record)]);
    return record;
  }
  async listAttempts(stepRunId: string): Promise<AttemptRecord[]> {
    const result = await this.db.query<Stored<AttemptRecord>>(
      "SELECT document FROM aw_attempts WHERE workspace_id = $1 AND step_run_id = $2 ORDER BY created_at", [this.workspaceId, stepRunId]);
    return result.rows.map((row) => row.document);
  }
  updateAttempt(id: string, patch: Parameters<RunStore["updateAttempt"]>[1]): Promise<void> { return this.patch("aw_attempts", id, patch); }

  private async lockRun(db: PoolClient, runId: string): Promise<void> {
    const result = await db.query("SELECT id FROM aw_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [this.workspaceId, runId]);
    if (!result.rowCount) throw new Error("Workflow run not found");
  }
  private async insertEvent(db: PoolClient, draft: EventDraft): Promise<WorkflowEvent> {
    if (!draft.type?.trim()) throw new Error("Event type is required");
    if (draft.parentRunId) {
      const parent = await db.query("SELECT 1 FROM aw_runs WHERE workspace_id=$1 AND id=$2",
        [this.workspaceId, draft.parentRunId]);
      if (!parent.rowCount) throw new Error("Event parent run not found");
    }
    const counter = await db.query<{ next_event_seq: string }>(
      "UPDATE aw_runs SET next_event_seq = next_event_seq + 1 WHERE workspace_id = $1 AND id = $2 RETURNING next_event_seq",
      [this.workspaceId, draft.runId]);
    if (!counter.rows[0]) throw new Error("Workflow run not found");
    const seq = Number(counter.rows[0].next_event_seq) - 1;
    if (!Number.isSafeInteger(seq)) throw new Error("Event sequence exceeds JavaScript safe integer range");
    const event = { ...draft, id: randomUUID(), seq, timestamp: new Date().toISOString() };
    await db.query(
      "INSERT INTO aw_events(workspace_id, run_id, seq, id, step_run_id, attempt_id, document) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [this.workspaceId, event.runId, seq, event.id, event.stepRunId ?? null, event.attemptId ?? null, json(event)]);
    return event;
  }
  appendEvent(draft: EventDraft): Promise<WorkflowEvent> {
    return this.tx(async (db) => { await this.lockRun(db, draft.runId); return this.insertEvent(db, draft); });
  }
  async listEvents(runId: string, afterSeq = 0): Promise<WorkflowEvent[]> {
    const result = await this.db.query<Stored<WorkflowEvent>>(
      "SELECT document FROM aw_events WHERE workspace_id = $1 AND run_id = $2 AND seq > $3 ORDER BY seq",
      [this.workspaceId, runId, afterSeq]);
    return result.rows.map((row) => row.document);
  }

  private async insertArtifact(db: PoolClient, draft: ArtifactDraft): Promise<ArtifactRef> {
    const { payload, ...metadata } = draft;
    const canonicalPayload = canonicalWorkflowValue(payload);
    if (await artifactPayloadSha256(canonicalPayload) !== draft.sha256) throw new Error("Artifact payload SHA-256 mismatch");
    const producer = draft.producedBy;
    const match = await db.query<{ document: AttemptRecord; step_document: StepRecord }>(
      `SELECT a.document, s.document AS step_document FROM aw_attempts a
       JOIN aw_steps s ON s.workspace_id=a.workspace_id AND s.run_id=a.run_id AND s.id=a.step_run_id
       WHERE a.workspace_id=$1 AND a.run_id=$2 AND a.step_run_id=$3 AND a.id=$4`,
      [this.workspaceId, producer.workflowRunId, producer.stepRunId, producer.attemptId]);
    if (!match.rowCount) throw new Error("Artifact provenance does not identify its producing attempt");
    if (match.rows[0]?.document.state !== "running" || match.rows[0]?.step_document.state !== "running") {
      throw new Error("Artifact producer attempt must be running");
    }
    for (const dependency of draft.dependsOn) {
      const found = await db.query<Stored<ArtifactRef>>(
        "SELECT document FROM aw_artifacts WHERE workspace_id=$1 AND id=$2", [this.workspaceId, dependency.artifactId]);
      if (!found.rows[0] || found.rows[0].document.revision !== dependency.revision
        || found.rows[0].document.sha256 !== dependency.sha256) throw new Error("Artifact dependency mismatch");
    }
    const artifact: ArtifactRef = { ...metadata, id: randomUUID() };
    await db.query(
      "INSERT INTO aw_artifacts(workspace_id,run_id,step_run_id,attempt_id,id,document,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
      [this.workspaceId, producer.workflowRunId, producer.stepRunId, producer.attemptId, artifact.id, json(artifact), json(canonicalPayload)]);
    for (const dependency of draft.dependsOn) {
      await db.query("INSERT INTO aw_artifact_dependencies(workspace_id,artifact_id,dependency_id) VALUES ($1,$2,$3)",
        [this.workspaceId, artifact.id, dependency.artifactId]);
    }
    return artifact;
  }
  publishArtifact(draft: ArtifactDraft): Promise<ArtifactRef> {
    return this.tx(async (db) => { await this.lockRun(db, draft.producedBy.workflowRunId); return this.insertArtifact(db, draft); });
  }
  async getArtifact(id: string): Promise<ArtifactRef | undefined> {
    const result = await this.db.query<Stored<ArtifactRef>>(
      "SELECT document FROM aw_artifacts WHERE workspace_id=$1 AND id=$2", [this.workspaceId, id]);
    return result.rows[0]?.document;
  }
  async getArtifactPayload(id: string): Promise<unknown> {
    const result = await this.db.query<{ document: ArtifactRef; payload: unknown }>(
      "SELECT document, payload FROM aw_artifacts WHERE workspace_id=$1 AND id=$2", [this.workspaceId, id]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (await artifactPayloadSha256(row.payload) !== row.document.sha256) throw new Error("Artifact payload integrity check failed");
    return row.payload;
  }
  async listArtifacts(runId: string): Promise<ArtifactRef[]> {
    const result = await this.db.query<Stored<ArtifactRef>>(
      "SELECT document FROM aw_artifacts WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at", [this.workspaceId, runId]);
    return result.rows.map((row) => row.document);
  }

  async commitStepResult(commit: StepResultCommit): Promise<StepResultReceipt> {
    if (!commit.idempotencyKey?.trim()) throw new Error("Step commit idempotency key is required");
    const canonical = canonicalWorkflowValue(commit);
    const requestHash = await artifactPayloadSha256(canonical);
    return this.tx(async (db) => {
      const relation = await db.query<{ run_id: string }>(
        "SELECT run_id FROM aw_steps WHERE workspace_id=$1 AND id=$2", [this.workspaceId, commit.stepRunId]);
      const runId = relation.rows[0]?.run_id;
      if (!runId) throw new Error("Workflow step not found");
      await this.lockRun(db, runId);
      const existing = await db.query<{ request_hash: string; receipt: StepResultReceipt }>(
        "SELECT request_hash, receipt FROM aw_step_commits WHERE workspace_id=$1 AND run_id=$2 AND idempotency_key=$3",
        [this.workspaceId, runId, commit.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new Error("Step commit idempotency conflict");
        return existing.rows[0].receipt;
      }
      const step = await db.query<Stored<StepRecord>>(
        "SELECT document FROM aw_steps WHERE workspace_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE",
        [this.workspaceId, runId, commit.stepRunId]);
      const attempt = await db.query<Stored<AttemptRecord>>(
        "SELECT document FROM aw_attempts WHERE workspace_id=$1 AND run_id=$2 AND step_run_id=$3 AND id=$4 FOR UPDATE",
        [this.workspaceId, runId, commit.stepRunId, commit.attemptId]);
      if (!step.rows[0] || !attempt.rows[0] || step.rows[0].document.state !== "running"
        || attempt.rows[0].document.state !== "running") throw new Error("Step commit requires a running producer attempt");
      if (commit.artifact) {
        const by = commit.artifact.producedBy;
        if (by.workflowRunId !== runId || by.stepRunId !== commit.stepRunId || by.attemptId !== commit.attemptId) {
          throw new Error("Artifact provenance does not match step commit");
        }
      }
      let output = commit.output;
      let artifact: ArtifactRef | undefined;
      if (commit.artifact) {
        artifact = await this.insertArtifact(db, commit.artifact);
        output = artifact;
        await this.insertEvent(db, { runId, stepRunId: commit.stepRunId, attemptId: commit.attemptId,
          type: "artifact.published", data: artifact });
      }
      for (const event of commit.events) {
        if (event.runId !== runId || event.stepRunId !== commit.stepRunId
          || event.attemptId !== commit.attemptId) throw new Error("Step completion event provenance mismatch");
        await this.insertEvent(db, event);
      }
      await db.query("UPDATE aw_steps SET document=$4::jsonb WHERE workspace_id=$1 AND run_id=$2 AND id=$3",
        [this.workspaceId, runId, commit.stepRunId, json({ ...step.rows[0].document, state: commit.state,
          validation: commit.validation, output })]);
      await db.query("UPDATE aw_attempts SET document=$5::jsonb WHERE workspace_id=$1 AND run_id=$2 AND step_run_id=$3 AND id=$4",
        [this.workspaceId, runId, commit.stepRunId, commit.attemptId,
          json({ ...attempt.rows[0].document, state: commit.state })]);
      const receipt: StepResultReceipt = artifact ? { output, artifact } : { output };
      await db.query(
        "INSERT INTO aw_step_commits(workspace_id,run_id,step_run_id,attempt_id,idempotency_key,request_hash,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [this.workspaceId, runId, commit.stepRunId, commit.attemptId, commit.idempotencyKey, requestHash, json(receipt)]);
      return receipt;
    });
  }
}
