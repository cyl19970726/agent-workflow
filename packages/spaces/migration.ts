import type { Pool } from 'pg';
import { migratePostgresWorkflowStore } from '@signal-room/workflow-postgres';

/** Additive schema. Domain IDs are independent from the ledger's technical partition. */
export async function migrateWorkflowSpaces(pool: Pool): Promise<void> {
  await migratePostgresWorkflowStore(pool);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(4832941, 2)');
    const applied=await db.query<{version:number}>(
      'SELECT version FROM aw_schema_migrations WHERE component=$1',['workflow-spaces']);
    // Bump this version and add the upgrade DDL whenever the Space schema changes.
    if(applied.rows[0]?.version===1){await db.query('COMMIT');return;}
    if(applied.rows[0])throw new Error('Unsupported workflow spaces schema version');
    await db.query(`
      CREATE TABLE IF NOT EXISTS ws_spaces (
        id text PRIMARY KEY, document jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ws_members (
        space_id text NOT NULL REFERENCES ws_spaces(id), principal_id text NOT NULL,
        role text NOT NULL CHECK(role IN ('owner','creator','operator','viewer')),
        PRIMARY KEY(space_id,principal_id)
      );
      CREATE TABLE IF NOT EXISTS ws_schemas (
        space_id text NOT NULL REFERENCES ws_spaces(id), namespace text NOT NULL, revision text NOT NULL,
        hash text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(space_id,namespace,revision),
        UNIQUE(space_id,namespace,revision,hash)
      );
      CREATE TABLE IF NOT EXISTS ws_schema_dependencies (
        space_id text NOT NULL, namespace text NOT NULL, revision text NOT NULL,
        dependency_namespace text NOT NULL, dependency_revision text NOT NULL, dependency_hash text NOT NULL,
        PRIMARY KEY(space_id,namespace,revision,dependency_namespace,dependency_revision),
        FOREIGN KEY(space_id,namespace,revision) REFERENCES ws_schemas(space_id,namespace,revision),
        FOREIGN KEY(space_id,dependency_namespace,dependency_revision,dependency_hash) REFERENCES ws_schemas(space_id,namespace,revision,hash)
      );
      CREATE TABLE IF NOT EXISTS ws_workflows (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, predecessor_id text,
        hash text NOT NULL, document jsonb NOT NULL, archival jsonb, PRIMARY KEY(space_id,id),
        FOREIGN KEY(space_id,predecessor_id) REFERENCES ws_workflows(space_id,id)
      );
      ALTER TABLE ws_workflows ADD COLUMN IF NOT EXISTS archival jsonb;
      CREATE TABLE IF NOT EXISTS ws_presentations (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, revision text NOT NULL,
        hash text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(space_id,id,revision),
        UNIQUE(space_id,id,revision,hash)
      );
      CREATE TABLE IF NOT EXISTS ws_presentation_bindings (
        space_id text NOT NULL, id text NOT NULL, workflow_version_id text NOT NULL,
        entrypoint text NOT NULL, presentation_id text NOT NULL, presentation_revision text NOT NULL,
        presentation_hash text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL,
        ordinal bigint GENERATED ALWAYS AS IDENTITY, document jsonb NOT NULL, PRIMARY KEY(space_id,id),
        FOREIGN KEY(space_id,workflow_version_id) REFERENCES ws_workflows(space_id,id),
        FOREIGN KEY(space_id,presentation_id,presentation_revision,presentation_hash)
          REFERENCES ws_presentations(space_id,id,revision,hash)
      );
      ALTER TABLE ws_presentation_bindings
        ADD COLUMN IF NOT EXISTS ordinal bigint GENERATED ALWAYS AS IDENTITY;
      CREATE INDEX IF NOT EXISTS ws_presentation_bindings_target_idx
        ON ws_presentation_bindings(space_id,workflow_version_id,entrypoint,ordinal);
      CREATE TABLE IF NOT EXISTS ws_cases (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_assets (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, namespace text NOT NULL,
        head_id text, next_version integer NOT NULL DEFAULT 1, PRIMARY KEY(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_blobs (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_asset_versions (
        space_id text NOT NULL, id text NOT NULL, asset_id text NOT NULL, version integer NOT NULL,
        namespace text NOT NULL, schema_revision text NOT NULL, schema_hash text NOT NULL,
        run_id text, step_run_id text, attempt_id text, document jsonb NOT NULL,
        PRIMARY KEY(space_id,id), UNIQUE(space_id,asset_id,version),
        CHECK((run_id IS NULL AND step_run_id IS NULL AND attempt_id IS NULL) OR (run_id IS NOT NULL AND step_run_id IS NOT NULL AND attempt_id IS NOT NULL)),
        FOREIGN KEY(space_id,asset_id) REFERENCES ws_assets(space_id,id),
        FOREIGN KEY(space_id,namespace,schema_revision,schema_hash) REFERENCES ws_schemas(space_id,namespace,revision,hash),
        FOREIGN KEY(space_id,run_id,step_run_id,attempt_id) REFERENCES aw_attempts(workspace_id,run_id,step_run_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_runtime_artifacts (
        space_id text NOT NULL, artifact_id text NOT NULL, version_id text NOT NULL, PRIMARY KEY(space_id,artifact_id),
        FOREIGN KEY(space_id,artifact_id) REFERENCES aw_artifacts(workspace_id,id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_asset_dependencies (
        space_id text NOT NULL, version_id text NOT NULL, dependency_id text NOT NULL, PRIMARY KEY(space_id,version_id,dependency_id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id),
        FOREIGN KEY(space_id,dependency_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_asset_blobs (
        space_id text NOT NULL, version_id text NOT NULL, blob_id text NOT NULL, PRIMARY KEY(space_id,version_id,blob_id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id),
        FOREIGN KEY(space_id,blob_id) REFERENCES ws_blobs(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_manifests (
        space_id text NOT NULL, id text NOT NULL, case_id text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(space_id,id),
        UNIQUE(space_id,case_id,id), FOREIGN KEY(space_id,case_id) REFERENCES ws_cases(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_manifest_assets (
        space_id text NOT NULL, manifest_id text NOT NULL, slot text NOT NULL, version_id text NOT NULL,
        PRIMARY KEY(space_id,manifest_id,slot), FOREIGN KEY(space_id,manifest_id) REFERENCES ws_manifests(space_id,id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_runs (
        space_id text NOT NULL, run_id text NOT NULL, workflow_version_id text NOT NULL, case_id text NOT NULL,
        manifest_id text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(space_id,run_id),
        FOREIGN KEY(space_id,run_id) REFERENCES aw_runs(workspace_id,id),
        FOREIGN KEY(space_id,workflow_version_id) REFERENCES ws_workflows(space_id,id),
        FOREIGN KEY(space_id,case_id,manifest_id) REFERENCES ws_manifests(space_id,case_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_execution_limits (
        space_id text PRIMARY KEY REFERENCES ws_spaces(id), concurrency integer NOT NULL CHECK(concurrency > 0)
      );
      CREATE TABLE IF NOT EXISTS ws_execution_tasks (
        space_id text NOT NULL, run_id text NOT NULL, workflow_version_id text NOT NULL,
        entrypoint text NOT NULL, input_manifest_id text NOT NULL, case_id text NOT NULL,
        executor_key text NOT NULL, request_hash text NOT NULL, status text NOT NULL
          CHECK(status IN ('queued','running','cancel_requested','interrupted','completed','failed','canceled')),
        owner text, claim_token text, lease_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        error text, PRIMARY KEY(space_id,run_id),
        FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id)
      );
      CREATE INDEX IF NOT EXISTS ws_execution_claim_idx ON ws_execution_tasks(space_id,status,created_at);
      CREATE TABLE IF NOT EXISTS ws_sessions (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, role text NOT NULL, parent_id text,
        next_seq integer NOT NULL DEFAULT 1, document jsonb NOT NULL, PRIMARY KEY(space_id,id),
        FOREIGN KEY(space_id,parent_id) REFERENCES ws_sessions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_contexts (
        space_id text NOT NULL, id text NOT NULL, run_id text NOT NULL, step_run_id text NOT NULL, attempt_id text NOT NULL,
        session_id text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(space_id,id), UNIQUE(space_id,attempt_id),
        FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id),
        FOREIGN KEY(space_id,session_id) REFERENCES ws_sessions(space_id,id),
        FOREIGN KEY(space_id,run_id,step_run_id,attempt_id) REFERENCES aw_attempts(workspace_id,run_id,step_run_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_context_inputs (
        space_id text NOT NULL, context_id text NOT NULL, slot text NOT NULL, version_id text NOT NULL,
        PRIMARY KEY(space_id,context_id,slot), FOREIGN KEY(space_id,context_id) REFERENCES ws_contexts(space_id,id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_session_events (
        space_id text NOT NULL, id text NOT NULL, session_id text NOT NULL, seq integer NOT NULL,
        context_id text NOT NULL, dedup_key text NOT NULL, request_hash text NOT NULL, document jsonb NOT NULL,
        PRIMARY KEY(space_id,id), UNIQUE(space_id,session_id,seq), UNIQUE(space_id,context_id,dedup_key),
        FOREIGN KEY(space_id,session_id) REFERENCES ws_sessions(space_id,id),
        FOREIGN KEY(space_id,context_id) REFERENCES ws_contexts(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_output_bindings (
        space_id text NOT NULL, context_id text NOT NULL, slot text NOT NULL, version_id text NOT NULL,
        PRIMARY KEY(space_id,context_id,slot), FOREIGN KEY(space_id,context_id) REFERENCES ws_contexts(space_id,id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_relation_events (
        space_id text NOT NULL, id text NOT NULL, run_id text NOT NULL, case_id text NOT NULL,
        from_version_id text, to_version_id text, previous_id text,
        ordinal bigint GENERATED ALWAYS AS IDENTITY, document jsonb NOT NULL,
        PRIMARY KEY(space_id,id),
        FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id),
        FOREIGN KEY(space_id,case_id) REFERENCES ws_cases(space_id,id),
        FOREIGN KEY(space_id,from_version_id) REFERENCES ws_asset_versions(space_id,id),
        FOREIGN KEY(space_id,to_version_id) REFERENCES ws_asset_versions(space_id,id),
        FOREIGN KEY(space_id,previous_id) REFERENCES ws_relation_events(space_id,id)
      );
      CREATE INDEX IF NOT EXISTS ws_relation_from_idx ON ws_relation_events(space_id,from_version_id,ordinal);
      CREATE INDEX IF NOT EXISTS ws_relation_to_idx ON ws_relation_events(space_id,to_version_id,ordinal);
      CREATE INDEX IF NOT EXISTS ws_relation_previous_idx ON ws_relation_events(space_id,previous_id);
      CREATE INDEX IF NOT EXISTS ws_relation_run_idx ON ws_relation_events(space_id,run_id,ordinal);
      CREATE TABLE IF NOT EXISTS ws_process_decisions (
        space_id text NOT NULL, run_id text NOT NULL, step_run_id text NOT NULL, attempt_id text NOT NULL,
        event_seq bigint NOT NULL, document jsonb NOT NULL,
        PRIMARY KEY(space_id,step_run_id,attempt_id),
        FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id),
        FOREIGN KEY(space_id,run_id,step_run_id) REFERENCES aw_steps(workspace_id,run_id,id),
        FOREIGN KEY(space_id,attempt_id) REFERENCES aw_attempts(workspace_id,id),
        FOREIGN KEY(space_id,run_id,event_seq) REFERENCES aw_events(workspace_id,run_id,seq)
      );
      CREATE INDEX IF NOT EXISTS ws_process_decisions_run_idx ON ws_process_decisions(space_id,run_id,event_seq);
      CREATE TABLE IF NOT EXISTS ws_commits (
        space_id text NOT NULL REFERENCES ws_spaces(id), scope text NOT NULL, idempotency_key text NOT NULL,
        request_hash text NOT NULL, receipt jsonb NOT NULL, PRIMARY KEY(space_id,scope,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS ws_transitions (
        space_id text NOT NULL, id text NOT NULL, version_id text NOT NULL, document jsonb NOT NULL,
        ordinal bigint GENERATED ALWAYS AS IDENTITY, PRIMARY KEY(space_id,id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_knowledge (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, entry_id text NOT NULL, previous_id text,
        document jsonb NOT NULL, PRIMARY KEY(space_id,id),
        FOREIGN KEY(space_id,previous_id) REFERENCES ws_knowledge(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_knowledge_heads (
        space_id text NOT NULL, entry_id text NOT NULL, revision_id text NOT NULL, PRIMARY KEY(space_id,entry_id),
        FOREIGN KEY(space_id,revision_id) REFERENCES ws_knowledge(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_knowledge_assets (
        space_id text NOT NULL, knowledge_id text NOT NULL, version_id text NOT NULL, PRIMARY KEY(space_id,knowledge_id,version_id),
        FOREIGN KEY(space_id,knowledge_id) REFERENCES ws_knowledge(space_id,id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_knowledge_messages (
        space_id text NOT NULL, knowledge_id text NOT NULL, message_id text NOT NULL, PRIMARY KEY(space_id,knowledge_id,message_id),
        FOREIGN KEY(space_id,knowledge_id) REFERENCES ws_knowledge(space_id,id),
        FOREIGN KEY(space_id,message_id) REFERENCES ws_session_events(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_reviews (
        space_id text NOT NULL, id text NOT NULL, run_id text NOT NULL, baseline_id text, session_id text, document jsonb NOT NULL,
        PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id),
        FOREIGN KEY(space_id,baseline_id) REFERENCES ws_reviews(space_id,id),
        FOREIGN KEY(space_id,session_id) REFERENCES ws_sessions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_review_assets (
        space_id text NOT NULL, review_id text NOT NULL, version_id text NOT NULL, PRIMARY KEY(space_id,review_id,version_id),
        FOREIGN KEY(space_id,review_id) REFERENCES ws_reviews(space_id,id),
        FOREIGN KEY(space_id,version_id) REFERENCES ws_asset_versions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_comparisons (
        space_id text NOT NULL, id text NOT NULL, baseline_id text NOT NULL, candidate_id text NOT NULL, document jsonb NOT NULL,
        PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,baseline_id) REFERENCES ws_reviews(space_id,id),
        FOREIGN KEY(space_id,candidate_id) REFERENCES ws_reviews(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_iterations (
        space_id text NOT NULL, id text NOT NULL, workflow_version_id text NOT NULL, document jsonb NOT NULL,
        PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,workflow_version_id) REFERENCES ws_workflows(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_iteration_reviews (
        space_id text NOT NULL, iteration_id text NOT NULL, review_id text NOT NULL, PRIMARY KEY(space_id,iteration_id,review_id),
        FOREIGN KEY(space_id,iteration_id) REFERENCES ws_iterations(space_id,id),
        FOREIGN KEY(space_id,review_id) REFERENCES ws_reviews(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_iteration_runs (
        space_id text NOT NULL, iteration_id text NOT NULL, run_id text NOT NULL, PRIMARY KEY(space_id,iteration_id,run_id),
        FOREIGN KEY(space_id,iteration_id) REFERENCES ws_iterations(space_id,id),
        FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id)
      );
      CREATE TABLE IF NOT EXISTS ws_adoptions (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL, slot text NOT NULL,
        target_workflow_id text, target_asset_id text, comparison_id text, document jsonb NOT NULL,
        PRIMARY KEY(space_id,id), CHECK((target_workflow_id IS NULL) <> (target_asset_id IS NULL)),
        FOREIGN KEY(space_id,target_workflow_id) REFERENCES ws_workflows(space_id,id),
        FOREIGN KEY(space_id,target_asset_id) REFERENCES ws_asset_versions(space_id,id),
        FOREIGN KEY(space_id,comparison_id) REFERENCES ws_comparisons(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_adoption_heads (
        space_id text NOT NULL, slot text NOT NULL, adoption_id text NOT NULL, PRIMARY KEY(space_id,slot),
        FOREIGN KEY(space_id,adoption_id) REFERENCES ws_adoptions(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_validation_plans (
        space_id text NOT NULL REFERENCES ws_spaces(id), id text NOT NULL,
        status text NOT NULL CHECK(status IN ('draft','frozen')), document jsonb NOT NULL,
        PRIMARY KEY(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_validation_runs (
        space_id text NOT NULL, plan_id text NOT NULL, entry_id text NOT NULL,
        attempt integer NOT NULL CHECK(attempt > 0), run_id text NOT NULL,
        linked_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(space_id,plan_id,entry_id,attempt),
        UNIQUE(space_id,plan_id,run_id),
        FOREIGN KEY(space_id,plan_id) REFERENCES ws_validation_plans(space_id,id),
        FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id)
      );
      CREATE TABLE IF NOT EXISTS ws_validation_reviews (
        space_id text NOT NULL, plan_id text NOT NULL, entry_id text NOT NULL,
        run_id text NOT NULL, review_id text NOT NULL,
        linked_at timestamptz NOT NULL DEFAULT now(), policy_verified boolean, policy_differences jsonb,
        expected_profile_hash text, observed_profile_hash text,
        PRIMARY KEY(space_id,plan_id,entry_id,review_id),
        UNIQUE(space_id,plan_id,review_id),
        FOREIGN KEY(space_id,plan_id) REFERENCES ws_validation_plans(space_id,id),
        FOREIGN KEY(space_id,run_id) REFERENCES ws_runs(space_id,run_id),
        FOREIGN KEY(space_id,review_id) REFERENCES ws_reviews(space_id,id)
      );
      ALTER TABLE ws_validation_reviews ADD COLUMN IF NOT EXISTS policy_verified boolean;
      ALTER TABLE ws_validation_reviews ADD COLUMN IF NOT EXISTS policy_differences jsonb;
      ALTER TABLE ws_validation_reviews ADD COLUMN IF NOT EXISTS expected_profile_hash text;
      ALTER TABLE ws_validation_reviews ADD COLUMN IF NOT EXISTS observed_profile_hash text;
      CREATE TABLE IF NOT EXISTS ws_validation_comparisons (
        space_id text NOT NULL, plan_id text NOT NULL, id text NOT NULL,
        comparison_id text NOT NULL, document jsonb NOT NULL,
        PRIMARY KEY(space_id,plan_id,id), UNIQUE(space_id,plan_id,comparison_id),
        FOREIGN KEY(space_id,plan_id) REFERENCES ws_validation_plans(space_id,id),
        FOREIGN KEY(space_id,comparison_id) REFERENCES ws_comparisons(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_validation_issues (
        space_id text NOT NULL, plan_id text NOT NULL, id text NOT NULL,
        document jsonb NOT NULL, PRIMARY KEY(space_id,plan_id,id),
        FOREIGN KEY(space_id,plan_id) REFERENCES ws_validation_plans(space_id,id)
      );
      CREATE TABLE IF NOT EXISTS ws_validation_exclusions (
        space_id text NOT NULL, plan_id text NOT NULL, entry_id text NOT NULL,
        rule text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(space_id,plan_id,entry_id),
        FOREIGN KEY(space_id,plan_id) REFERENCES ws_validation_plans(space_id,id)
      );
      CREATE INDEX IF NOT EXISTS ws_versions_run_idx ON ws_asset_versions(space_id,run_id);
      CREATE INDEX IF NOT EXISTS ws_sessions_events_idx ON ws_session_events(space_id,session_id,seq);
    `);
    await db.query('INSERT INTO aw_schema_migrations(component,version) VALUES($1,$2)',['workflow-spaces',1]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
