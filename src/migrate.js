import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(81203921)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const folder = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(folder)).filter(n => n.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(new URL(name, folder), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.query('SELECT pg_advisory_unlock(81203921)'); client.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { await migrate(pool); console.log('Migrations complete'); } finally { await pool.end(); }
}
