import pg from 'pg';
import { Store } from './store.js';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  // Snapshot aggregates before detailed request events and visitor records expire.
  try { await new Store(pool).snapshot(new Date().toISOString().slice(0, 10)); } catch (error) { console.error('Observatory snapshot failed', error.code || error.message); }
  await pool.query('DELETE FROM write_tokens WHERE expires_at<now()');
  await pool.query("DELETE FROM rate_buckets WHERE expires_at<now()-interval '1 day'");
  await pool.query("DELETE FROM request_events WHERE created_at<now()-interval '30 days'");
  await pool.query("DELETE FROM visitors WHERE last_seen_at<now()-interval '30 days'");
  console.log('Retention maintenance complete');
} finally { await pool.end(); }
