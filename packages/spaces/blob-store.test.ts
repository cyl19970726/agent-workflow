import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresBlobStore } from './blob-store.js';

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PostgreSQL blob migration', () => {
  async function inFreshSchema(test: (admin: Pool, scoped: Pool, schema: string) => Promise<void>) {
    const schema = `blob_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url! });
    const scoped = new Pool({ connectionString: url!, options: `-c search_path=${schema}`, max: 12 });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await test(admin, scoped, schema);
    } finally {
      await scoped.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }

  it('waits for an in-flight table creation before checking the target schema', async () => {
    await inFreshSchema(async (admin, scoped, schema) => {
      const holder = await scoped.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(4832941, 3)');
        await holder.query('CREATE TABLE ws_blob_bytes (key text PRIMARY KEY, bytes bytea NOT NULL, sha256 text NOT NULL)');
        const appName = `blob_migrate_${randomUUID().replaceAll('-', '')}`;
        const contenderPool = new Pool({ connectionString: url!, options: `-c search_path=${schema} -c application_name=${appName}` });
        try {
          const contender = new PostgresBlobStore(contenderPool).migrate().then(() => null, error => error as Error);
          let blocked = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const activity = await admin.query<{ wait_event_type: string | null }>(
              'SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1 AND state=$2', [appName, 'active']);
            if (activity.rows.some(row => row.wait_event_type === 'Lock')) { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await holder.query('COMMIT');
          expect(await contender).toBeNull();
        } finally {
          await holder.query('ROLLBACK');
          await contenderPool.end();
        }
      } finally {
        holder.release();
      }
    });
  });

  it('initializes one empty schema concurrently and retains content-addressed reads', async () => {
    await inFreshSchema(async (_admin, scoped) => {
      const store = new PostgresBlobStore(scoped);
      await Promise.all(Array.from({ length: 8 }, () => store.migrate()));
      const bytes = new TextEncoder().encode('concurrent blob migration');
      await store.put('example', bytes);
      expect(await store.get('example')).toEqual(bytes);
    });
  });
});
