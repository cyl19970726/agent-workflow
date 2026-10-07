import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface BlobStore {
  /** Immutable content-addressed write. Return only after the bytes are durable. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}
export const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Portable baseline for small integration/media fixtures. No local file is the original.
 * Large production media should use a private object provider implementing BlobStore. */
export class PostgresBlobStore implements BlobStore {
  constructor(private readonly pool: Pool, readonly maxBytes = 16 * 1024 * 1024) {}
  async migrate(): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(4832941, 3)');
      const existing = await db.query<{ table_name: string | null }>(
        "SELECT to_regclass(format('%I.%I', current_schema(), 'ws_blob_bytes'))::text AS table_name",
      );
      if (!existing.rows[0]?.table_name) {
        await db.query('CREATE TABLE ws_blob_bytes (key text PRIMARY KEY, bytes bytea NOT NULL, sha256 text NOT NULL)');
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > this.maxBytes) throw new Error('Blob exceeds PostgreSQL baseline size limit; configure a managed object provider');
    const hash = bytesHash(bytes);
    await this.pool.query('INSERT INTO ws_blob_bytes(key,bytes,sha256) VALUES ($1,$2,$3) ON CONFLICT(key) DO NOTHING', [key,Buffer.from(bytes),hash]);
    const stored = await this.get(key);
    if (bytesHash(stored) !== hash) throw new Error('Immutable blob key conflict');
  }
  async get(key: string): Promise<Uint8Array> {
    const result = await this.pool.query<{bytes: Buffer; sha256: string}>('SELECT bytes,sha256 FROM ws_blob_bytes WHERE key=$1', [key]);
    const row = result.rows[0];
    if (!row || bytesHash(row.bytes) !== row.sha256) throw new Error('Blob missing or integrity check failed');
    return new Uint8Array(row.bytes);
  }
}
