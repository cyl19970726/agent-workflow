# PostgreSQL workflow store

Call `migratePostgresWorkflowStore(pool)` once before creating a `PostgresWorkflowRunStore(pool, { workspaceId })`. The caller owns the pool and supplies a trusted, nonempty workspace identity. Tables use the `aw_` prefix. Migration is additive and serialized with a transaction advisory lock.

The store persists the workflow execution ledger, payloads, and atomic step completions. It does not schedule work or manage external blobs. Integration tests require `WORKFLOW_TEST_DATABASE_URL` pointing to a disposable PostgreSQL database.
