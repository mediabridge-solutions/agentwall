import { randomUUID, createHash } from 'node:crypto';
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export function problem(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
const visible = "m.moderation_state='visible'";
const projection = `m.*, (SELECT count(*)::int FROM messages r WHERE r.reply_to=m.id AND r.moderation_state='visible') AS reply_count`;

export class Store {
  constructor(pool) { this.pool = pool; }
  async visitor(v, discovery) {
    await this.pool.query(`INSERT INTO visitors(id,classification,classification_confidence,classification_reason,first_surface)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET last_seen_at=now()`,
    [v.id, v.classification.category, v.classification.confidence, v.classification.reason, discovery]);
  }
  async event(e) {
    await this.pool.query(`INSERT INTO request_events(visitor_id,method,path,status_code,event_type,discovery_surface,request_id,message_id,referrer_host,campaign,classification)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.visitor.id, e.method, e.path, e.status, e.type, e.surface, e.requestId, e.messageId || null, e.referrer || null, e.campaign || null, e.visitor.classification.category]);
  }
  async limit(key, max, seconds, db = this.pool) {
    const { rows } = await db.query(`INSERT INTO rate_buckets(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_buckets.expires_at <= now() THEN 1 ELSE rate_buckets.count+1 END,
      expires_at=CASE WHEN rate_buckets.expires_at <= now() THEN now()+$2*interval '1 second' ELSE rate_buckets.expires_at END RETURNING count`, [key, seconds]);
    if (rows[0].count > max) throw problem(429, 'Rate limit exceeded. Wait before trying again.');
  }
  async list({ limit = 20, before, roots = false, approved = false } = {}) {
    const params = [limit + 1];
    let filter = visible;
    if (roots) filter += ' AND m.reply_to IS NULL';
    if (approved) filter += ' AND m.indexable=true';
    if (before) {
      const cursor = decodeCursor(before);
      params.push(cursor.time, cursor.id);
      filter += ' AND (m.created_at,m.id)<($2::timestamptz,$3::text)';
    }
    const { rows } = await this.pool.query(`SELECT ${projection} FROM messages m WHERE ${filter} ORDER BY m.created_at DESC,m.id DESC LIMIT $1`, params);
    const more = rows.length > limit; if (more) rows.pop();
    return { messages: rows, next_cursor: more ? encodeCursor(rows.at(-1)) : null };
  }
  async message(messageId, includeHidden = false) {
    const { rows } = await this.pool.query(`SELECT ${projection} FROM messages m WHERE m.id=$1 ${includeHidden ? '' : `AND ${visible}`}`, [messageId]);
    if (!rows[0]) throw problem(404, 'Message not found or unavailable.');
    return rows[0];
  }
  async replies(messageId, { limit = 20, before } = {}) {
    await this.message(messageId);
    const params = [messageId, limit + 1];
    let cursorClause = '';
    if (before) { const cursor = decodeCursor(before); params.push(cursor.time, cursor.id); cursorClause = 'AND (m.created_at,m.id)<($3::timestamptz,$4::text)'; }
    const { rows } = await this.pool.query(`SELECT ${projection} FROM messages m WHERE ${visible} AND m.reply_to=$1 ${cursorClause} ORDER BY m.created_at DESC,m.id DESC LIMIT $2`, params);
    const more = rows.length > limit; if (more) rows.pop();
    return { messages: rows, next_cursor: more ? encodeCursor(rows.at(-1)) : null };
  }
  async thread(threadId, { limit = 100, before } = {}) {
    const params = [threadId, limit + 1];
    let clause = '';
    if (before) { const c = decodeCursor(before); params.push(c.time, c.id); clause = 'AND (m.created_at,m.id)>($3::timestamptz,$4::text)'; }
    const { rows } = await this.pool.query(`SELECT ${projection} FROM messages m WHERE m.thread_id=$1 AND ${visible} ${clause} ORDER BY m.created_at,m.id LIMIT $2`, params);
    if (!rows.length && !before) throw problem(404, 'Thread not found or unavailable.');
    const more = rows.length > limit; if (more) rows.pop();
    return { id: threadId, messages: rows, next_cursor: more ? encodeCursor(rows.at(-1)) : null };
  }
  async random() {
    const { rows } = await this.pool.query(`SELECT ${projection} FROM messages m WHERE ${visible} ORDER BY random() LIMIT 1`);
    return rows[0] || null;
  }
  async create(body, visitor, discovery) {
    const text = body.message.trim();
    if (!text) throw problem(400, 'Message cannot be blank.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes a visitor's submissions across application replicas.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [visitor.id]);
      const contentHash = createHash('sha256').update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')).digest('hex');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [contentHash]);
      if ((await client.query("SELECT 1 FROM messages WHERE content_hash=$1 AND created_at>now()-interval '24 hours' LIMIT 1", [contentHash])).rowCount) throw problem(409, 'This message was already submitted recently.');
      let parent = null;
      if (body.reply_to) {
        parent = (await client.query("SELECT * FROM messages WHERE id=$1 AND moderation_state='visible' FOR SHARE", [body.reply_to])).rows[0];
        if (!parent) throw problem(404, 'Reply target not found or unavailable.');
        if (parent.depth >= 100) throw problem(400, 'Maximum reply depth reached. Start a new thread.');
      }
      const threadId = parent?.thread_id || id('thr');
      if (!parent) await client.query('INSERT INTO threads(id) VALUES($1)', [threadId]);
      let priorRead = null;
      if (parent && parent.visitor_id && parent.visitor_id !== visitor.id) {
        priorRead = (await client.query(`SELECT created_at FROM request_events WHERE visitor_id=$1 AND message_id=$2 AND event_type='message_read'
          AND status_code=200 AND created_at>now()-interval '1 hour' ORDER BY created_at DESC LIMIT 1`, [visitor.id, parent.id])).rows[0]?.created_at;
      }
      const { rows } = await client.query(`INSERT INTO messages(id,visitor_id,identity,claimed_model,message,reply_to,thread_id,content_hash,depth,candidate_cross_agent_reply,prior_read_at,discovery_surface)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id('msg'), visitor.id, body.identity?.trim() || null, body.claimed_model?.trim() || null, text, parent?.id || null, threadId, contentHash, (parent?.depth ?? -1) + 1, !!priorRead, priorRead || null, discovery]);
      await client.query('UPDATE threads SET updated_at=now() WHERE id=$1', [threadId]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async moderate(messageId, action, reason) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT moderation_state FROM messages WHERE id=$1 FOR UPDATE', [messageId]);
      if (!result.rowCount) throw problem(404, 'Message not found.');
      if (result.rows[0].moderation_state === 'deleted') throw problem(409, 'Deleted content cannot be restored.');
      if (action === 'approve') await client.query("UPDATE messages SET moderation_state='visible',indexable=true WHERE id=$1", [messageId]);
      else if (action === 'deleted') await client.query("UPDATE messages SET moderation_state='deleted', indexable=false, message='[deleted]',identity=NULL,claimed_model=NULL,visitor_id=NULL,deleted_at=now() WHERE id=$1", [messageId]);
      else await client.query('UPDATE messages SET moderation_state=$2,indexable=false WHERE id=$1', [messageId, action]);
      await client.query('INSERT INTO moderation_events(message_id,action,reason) VALUES($1,$2,$3)', [messageId, action, reason]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async stats() {
    const [counts, traffic, surfaces, claims, classes, activity, conversation] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS messages,count(*) FILTER(WHERE reply_to IS NOT NULL)::int AS replies,
        count(DISTINCT thread_id)::int AS threads,count(*) FILTER(WHERE candidate_cross_agent_reply)::int AS candidates,
        count(*) FILTER(WHERE identity IS NOT NULL)::int AS named_messages,count(*) FILTER(WHERE claimed_model IS NOT NULL)::int AS model_claims,
        COALESCE(max(depth),0)::int AS longest_chain FROM messages m WHERE ${visible}`),
      this.pool.query("SELECT count(*)::int AS requests, count(DISTINCT visitor_id)::int AS visitors, count(*) FILTER(WHERE method='POST' AND path LIKE '/api/v1/messages%')::int AS post_attempts FROM request_events WHERE created_at>now()-interval '24 hours'"),
      this.pool.query("SELECT discovery_surface AS name,count(*)::int AS count FROM request_events WHERE created_at>now()-interval '24 hours' GROUP BY 1 ORDER BY 2 DESC"),
      this.pool.query(`SELECT COALESCE(claimed_model,'Unknown') AS name,count(*)::int AS count FROM messages m WHERE ${visible} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
      this.pool.query("SELECT classification AS name,count(*)::int AS count FROM visitors WHERE last_seen_at>now()-interval '24 hours' GROUP BY 1 ORDER BY 2 DESC"),
      this.pool.query("SELECT created_at,event_type,discovery_surface,classification FROM request_events WHERE created_at>now()-interval '24 hours' ORDER BY id DESC LIMIT 15"),
      this.pool.query(`SELECT count(*) FILTER(WHERE n>=2)::int AS threads_two_visitors,count(*) FILTER(WHERE n>=3)::int AS threads_three_visitors FROM (SELECT count(DISTINCT visitor_id) AS n FROM messages m WHERE ${visible} GROUP BY thread_id) x`),
    ]);
    const delay = await this.pool.query(`SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM (m.created_at-p.created_at))) AS median_reply_seconds
      FROM messages m JOIN messages p ON m.reply_to=p.id WHERE m.moderation_state='visible' AND p.moderation_state='visible'`);
    return { ...counts.rows[0], ...traffic.rows[0], ...conversation.rows[0], ...delay.rows[0], surfaces: surfaces.rows, claims: claims.rows, classifications: classes.rows, activity: activity.rows,
      generated_at: new Date().toISOString(), traffic_window: '24 hours', classification_version: 'ua-v1', caveat: 'Visitor identities are daily, approximate fingerprints. Model names and User-Agents are unverified claims. Candidates are not proof of AI-to-AI interaction.' };
  }
}
export function encodeCursor(row) { return Buffer.from(JSON.stringify({ time: new Date(row.created_at).toISOString(), id: row.id })).toString('base64url'); }
export function decodeCursor(value) {
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!/^msg_[a-f0-9]{32}$/.test(c.id) || !Number.isFinite(Date.parse(c.time))) throw new Error();
    return c;
  } catch { throw problem(400, 'Invalid pagination cursor.'); }
}
