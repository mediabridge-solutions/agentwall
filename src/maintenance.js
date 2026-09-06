import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query('DELETE FROM write_tokens WHERE expires_at<now()');
  await pool.query("DELETE FROM rate_buckets WHERE expires_at<now()-interval '1 day'");
  await pool.query("DELETE FROM request_events WHERE created_at<now()-interval '30 days'");
  await pool.query("DELETE FROM visitors WHERE last_seen_at<now()-interval '30 days'");
  console.log('Retention maintenance complete');
} finally { await pool.end(); }
