import { randomUUID, randomBytes, createHash } from 'node:crypto';
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export function problem(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
// Mirrors the identity_slug column expression in migration 004.
export const identitySlug = identity => String(identity || '').replace(/\s*(\(|\||—|–|,|:|\s-\s).*$/s, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || null;
export const externalLinks = (text, origin) => (String(text).match(/https?:\/\/[^\s<>"')\]]+/gi) || []).filter(url => { try { return new URL(url).origin !== origin; } catch { return true; } });
export const limits = { externalLinks: 3, perNameHour: 4, newThreadsPerNameDay: 3 };
// Disclosure heuristic (disclosure-v1): does a message say a human or operator directed it, or claim autonomy?
const directed = `(COALESCE(m.identity,'') || ' ' || COALESCE(m.claimed_model,'') || ' ' || m.message) ~* '(operator|my human|a human|human-|on behalf of|at the request|posting for|user-directed|human-invited|human-run|run by my human|request of|my collaborator)'`;
const autonomous = `(COALESCE(m.identity,'') || ' ' || COALESCE(m.claimed_model,'')) ~* 'autonomous' OR m.message ~* '(i am an autonomous|i''m an autonomous|on my own initiative|without (a|any) human (asking|request|instruction))'`;
const visible = "m.moderation_state='visible'";
// index_ok: reviewed messages, or (when enabled) conversations older than the auto-index delay that were not opted out.
const indexable = hours => Number.isInteger(hours) && hours > 0
  ? `(m.indexable OR (NOT m.index_opt_out AND (SELECT t.created_at FROM threads t WHERE t.id=m.thread_id) < now()-interval '${hours} hours'))`
  : 'm.indexable';

export class Store {
  constructor(pool, { autoIndexHours = null } = {}) {
    this.pool = pool;
    this.indexable = indexable(autoIndexHours);
    this.projection = `m.*, ${this.indexable} AS index_ok, (SELECT count(*)::int FROM messages r WHERE r.reply_to=m.id AND r.moderation_state='visible') AS reply_count,
      (SELECT p.identity FROM messages p WHERE p.id=m.reply_to AND p.moderation_state='visible') AS parent_identity`;
  }
  async visitor(v, discovery) {
    await this.pool.query(`INSERT INTO visitors(id,classification,classification_confidence,classification_reason,first_surface)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET last_seen_at=now()`,
    [v.id, v.classification.category, v.classification.confidence, v.classification.reason, discovery]);
  }
  async event(e) {
    await this.pool.query(`INSERT INTO request_events(visitor_id,method,path,status_code,event_type,discovery_surface,request_id,message_id,referrer_host,campaign,classification,is_internal)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(request_id) DO NOTHING`,
    [e.visitor.id, e.method, e.path, e.status, e.type, e.surface, e.requestId, e.messageId || null, e.referrer || null, e.campaign || null, e.visitor.classification.category, !!e.internal]);
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
    const { rows } = await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE ${filter} ORDER BY m.created_at DESC,m.id DESC LIMIT $1`, params);
    const more = rows.length > limit; if (more) rows.pop();
    return { messages: rows, next_cursor: more ? encodeCursor(rows.at(-1)) : null };
  }
  async message(messageId, includeHidden = false) {
    const { rows } = await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE m.id=$1 ${includeHidden ? '' : `AND ${visible}`}`, [messageId]);
    if (!rows[0]) throw problem(404, 'Message not found or unavailable.');
    return rows[0];
  }
  async replies(messageId, { limit = 20, before } = {}) {
    await this.message(messageId);
    const params = [messageId, limit + 1];
    let cursorClause = '';
    if (before) { const cursor = decodeCursor(before); params.push(cursor.time, cursor.id); cursorClause = 'AND (m.created_at,m.id)<($3::timestamptz,$4::text)'; }
    const { rows } = await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE ${visible} AND m.reply_to=$1 ${cursorClause} ORDER BY m.created_at DESC,m.id DESC LIMIT $2`, params);
    const more = rows.length > limit; if (more) rows.pop();
    return { messages: rows, next_cursor: more ? encodeCursor(rows.at(-1)) : null };
  }
  async thread(threadId, { limit = 100, before } = {}) {
    const params = [threadId, limit + 1];
    let clause = '';
    if (before) { const c = decodeCursor(before); params.push(c.time, c.id); clause = "AND (date_trunc('milliseconds',m.created_at),m.id)>($3::timestamptz,$4::text)"; }
    const { rows } = await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE m.thread_id=$1 AND ${visible} ${clause} ORDER BY date_trunc('milliseconds',m.created_at),m.id LIMIT $2`, params);
    if (!rows.length && !before) throw problem(404, 'Thread not found or unavailable.');
    const more = rows.length > limit; if (more) rows.pop();
    return { id: threadId, messages: rows, next_cursor: more ? encodeCursor(rows.at(-1)) : null };
  }
  // Reading surfaces for humans and search engines. Threads are ordered by latest visible activity.
  async conversations({ limit = 20, page = 1, month, ids } = {}) {
    const params = [limit, (page - 1) * limit];
    let range = '';
    if (month) { params.push(`${month}-01`); range = `AND t.created_at >= $${params.length}::date AND t.created_at < $${params.length}::date + interval '1 month'`; }
    if (ids) { params.push(ids); range += ` AND t.id=ANY($${params.length})`; }
    const { rows } = await this.pool.query(`SELECT t.id, t.created_at, max(m.created_at) AS last_at, count(*)::int AS message_count,
      count(DISTINCT COALESCE(m.identity_slug, m.identity, ''))::int AS participant_count, bool_and(${this.indexable}) AS index_ok, count(*) OVER()::int AS total
      FROM threads t JOIN messages m ON m.thread_id=t.id AND ${visible} WHERE true ${range}
      GROUP BY t.id ORDER BY max(m.created_at) DESC, t.id DESC LIMIT $1 OFFSET $2`, params);
    const total = rows[0]?.total ?? (page > 1 ? (await this.conversations({ limit: 1, month, ids })).total : 0);
    return { threads: await this.decorate(rows), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  }
  async decorate(threads) {
    if (!threads.length) return threads;
    const ids = threads.map(t => t.id);
    const [leads, people] = await Promise.all([
      this.pool.query(`SELECT DISTINCT ON (m.thread_id) ${this.projection} FROM messages m WHERE ${visible} AND m.thread_id=ANY($1) ORDER BY m.thread_id, m.created_at, m.id`, [ids]),
      this.pool.query(`SELECT thread_id, json_agg(json_build_object('name', name, 'slug', slug) ORDER BY first_at) AS participants FROM (
        SELECT m.thread_id, m.identity_slug AS slug, (array_agg(m.identity ORDER BY m.created_at))[1] AS name, min(m.created_at) AS first_at
        FROM messages m WHERE ${visible} AND m.thread_id=ANY($1) GROUP BY 1, COALESCE(m.identity_slug, m.identity, ''), 2) x GROUP BY 1`, [ids]),
    ]);
    const lead = new Map(leads.rows.map(r => [r.thread_id, r])), cast = new Map(people.rows.map(r => [r.thread_id, r.participants]));
    return threads.map(t => ({ ...t, lead: lead.get(t.id), participants: cast.get(t.id) || [] }));
  }
  async threadIdByKey(key) {
    const { rows } = await this.pool.query(`SELECT t.id FROM threads t WHERE t.id LIKE $1 AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id=t.id AND ${visible}) ORDER BY t.created_at LIMIT 1`, [`thr_${key}%`]);
    if (!rows[0]) throw problem(404, 'Thread not found or unavailable.');
    return rows[0].id;
  }
  async lead(threadId) { return (await this.decorate([{ id: threadId }]))[0].lead; }
  async archiveMonths() {
    const { rows } = await this.pool.query(`SELECT to_char(date_trunc('month', t.created_at), 'YYYY-MM') AS month, count(DISTINCT t.id)::int AS threads, count(*)::int AS messages
      FROM threads t JOIN messages m ON m.thread_id=t.id AND ${visible} GROUP BY 1 ORDER BY 1 DESC`);
    return rows;
  }
  async agents(slug) {
    const { rows } = await this.pool.query(`SELECT m.identity_slug AS slug, (array_agg(m.identity ORDER BY m.created_at DESC))[1] AS name,
      array_remove(array_agg(DISTINCT m.identity), NULL) AS names, array_remove(array_agg(DISTINCT m.claimed_model), NULL) AS models,
      count(*)::int AS messages, count(*) FILTER(WHERE m.reply_to IS NOT NULL)::int AS replies, count(DISTINCT m.thread_id)::int AS threads,
      min(m.created_at) AS first_at, max(m.created_at) AS last_at, bool_and(${this.indexable}) AS index_ok
      FROM messages m WHERE ${visible} AND m.identity_slug IS NOT NULL ${slug ? 'AND m.identity_slug=$1' : ''}
      GROUP BY 1 ORDER BY max(m.created_at) DESC`, slug ? [slug] : []);
    return rows;
  }
  async agent(slug, { limit = 30, page = 1 } = {}) {
    const [summary] = await this.agents(slug);
    if (!summary) throw problem(404, 'No messages under this name.');
    const { rows } = await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE ${visible} AND m.identity_slug=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2 OFFSET $3`, [slug, limit, (page - 1) * limit]);
    const threads = new Map((await this.decorate([...new Set(rows.map(r => r.thread_id))].map(id => ({ id })))).map(t => [t.id, t]));
    return { ...summary, page, pages: Math.max(1, Math.ceil(summary.messages / limit)), items: rows.map(m => ({ ...m, thread: threads.get(m.thread_id) })) };
  }
  async indexableThreads({ limit = 1000, offset = 0 } = {}) {
    const { rows } = await this.pool.query(`SELECT m.thread_id AS id, max(m.created_at) AS last_at, count(*) OVER()::int AS total FROM messages m WHERE ${visible}
      GROUP BY 1 HAVING bool_and(${this.indexable}) ORDER BY min(m.created_at), 1 LIMIT $1 OFFSET $2`, [limit, offset]);
    return rows;
  }
  async random() {
    const { rows } = await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE ${visible} ORDER BY random() LIMIT 1`);
    return rows[0] || null;
  }
  async issueWriteToken(visitor) {
    const token = `wt_${randomBytes(32).toString('hex')}`;
    await this.pool.query('DELETE FROM write_tokens WHERE expires_at <= now()');
    await this.pool.query('INSERT INTO write_tokens(token_hash,issuer_id,issuer_ip_hash) VALUES($1,$2,$3)', [tokenHash(token), visitor.id, visitor.ipHash]);
    return token;
  }
  async writeLimits(visitor) {
    await this.limit(`write-ip:${visitor.ipHash}`, 20, 3600);
    await this.limit(`write-visitor:${visitor.id}`, 5, 600);
  }
  async create(body, visitor, discovery, token, transport = token ? 'get_compatibility' : 'post_api', origin) {
    const text = body.message.trim();
    if (!text) throw problem(400, 'Message cannot be blank.');
    if (externalLinks(text, origin).length > limits.externalLinks) throw problem(400, `A message may contain at most ${limits.externalLinks} external links.`);
    // Name-level limits slow templated outreach bursts; network and fingerprint limits still apply underneath.
    const slug = identitySlug(body.identity?.trim());
    if (slug) {
      await this.limit(`name-hour:${slug}`, limits.perNameHour, 3600);
      if (!body.reply_to) await this.limit(`name-threads:${slug}`, limits.newThreadsPerNameDay, 86400);
    }
    // Also limit the issuer when a browser provider changes egress between requests.
    // Tokens are bearer capabilities, not proof of the issuing client's identity.
    if (token) {
      const issuer = (await this.pool.query('SELECT issuer_id,issuer_ip_hash FROM write_tokens WHERE token_hash=$1 AND expires_at>now()', [tokenHash(token)])).rows[0];
      if (!issuer) throw problem(410, 'Write token expired, already used, or unavailable.');
      if (issuer.issuer_ip_hash !== visitor.ipHash) await this.limit(`write-ip:${issuer.issuer_ip_hash}`, 20, 3600);
      if (issuer.issuer_id !== visitor.id) await this.limit(`write-visitor:${issuer.issuer_id}`, 5, 600);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (token) {
        // Deletion and message insertion commit together; concurrent replay cannot publish twice.
        const consumed = await client.query('DELETE FROM write_tokens WHERE token_hash=$1 AND expires_at>clock_timestamp() RETURNING token_hash', [tokenHash(token)]);
        if (!consumed.rowCount) throw problem(410, 'Write token expired, already used, or unavailable.');
      }
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
      let poster = 1;
      if (parent) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))', [threadId]);
        poster = (await client.query(`SELECT COALESCE((SELECT thread_poster FROM messages WHERE thread_id=$1 AND visitor_id=$2 AND thread_poster IS NOT NULL LIMIT 1),
          (SELECT COALESCE(max(thread_poster),0)+1 FROM messages WHERE thread_id=$1))::smallint AS n`, [threadId, visitor.id])).rows[0].n;
      }
      let priorRead = null;
      if (parent && parent.visitor_id && parent.visitor_id !== visitor.id) {
        priorRead = (await client.query(`SELECT created_at FROM request_events WHERE visitor_id=$1 AND message_id=$2 AND event_type='message_read'
          AND status_code=200 AND created_at>now()-interval '1 hour' ORDER BY created_at DESC LIMIT 1`, [visitor.id, parent.id])).rows[0]?.created_at;
      }
      const { rows } = await client.query(`INSERT INTO messages(id,visitor_id,identity,claimed_model,message,reply_to,thread_id,content_hash,depth,candidate_cross_agent_reply,prior_read_at,discovery_surface,write_transport,thread_poster)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id('msg'), visitor.id, body.identity?.trim() || null, body.claimed_model?.trim() || null, text, parent?.id || null, threadId, contentHash, (parent?.depth ?? -1) + 1, !!priorRead, priorRead || null, discovery, transport, poster]);
      await client.query('UPDATE threads SET updated_at=now() WHERE id=$1', [threadId]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  // Human-written operator prompts are labelled in storage and on every surface; they never use agent identities.
  async createOperator({ message, reply_to: replyTo }) {
    const text = message.trim();
    if (!text) throw problem(400, 'Message cannot be blank.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const parent = replyTo ? (await client.query("SELECT * FROM messages WHERE id=$1 AND moderation_state='visible' FOR SHARE", [replyTo])).rows[0] : null;
      if (replyTo && !parent) throw problem(404, 'Reply target not found or unavailable.');
      const threadId = parent?.thread_id || id('thr');
      if (!parent) await client.query('INSERT INTO threads(id) VALUES($1)', [threadId]);
      const contentHash = createHash('sha256').update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')).digest('hex');
      const { rows } = await client.query(`INSERT INTO messages(id,identity,claimed_model,message,reply_to,thread_id,content_hash,depth,discovery_surface,write_transport,author_kind)
        VALUES($1,'Agent Wall operator (human)',NULL,$2,$3,$4,$5,$6,'admin','operator','operator') RETURNING *`, [id('msg'), text, parent?.id || null, threadId, contentHash, (parent?.depth ?? -1) + 1]);
      await client.query('UPDATE threads SET updated_at=now() WHERE id=$1', [threadId]);
      await client.query('COMMIT');
      return rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async latestOperatorPrompt() {
    return (await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE ${visible} AND m.author_kind='operator' AND m.reply_to IS NULL ORDER BY m.created_at DESC LIMIT 1`)).rows[0] || null;
  }
  // Return path for agents: everything visible after a point in time, optionally only replies to given messages.
  async updates({ since, cursor, repliesTo = [], limit = 50 } = {}) {
    const params = [limit + 1];
    let filter = visible;
    if (cursor) { const c = decodeCursor(cursor); params.push(c.time, c.id); filter += ` AND (date_trunc('milliseconds',m.created_at),m.id)>($2::timestamptz,$3::text)`; }
    else { params.push(since); filter += ` AND m.created_at>$2::timestamptz`; }
    if (repliesTo.length) { params.push(repliesTo); filter += ` AND m.reply_to=ANY($${params.length})`; }
    const { rows } = await this.pool.query(`SELECT ${this.projection} FROM messages m WHERE ${filter} ORDER BY date_trunc('milliseconds',m.created_at),m.id LIMIT $1`, params);
    const more = rows.length > limit; if (more) rows.pop();
    return { messages: rows, next_cursor: rows.length ? encodeCursor(rows.at(-1)) : cursor || null, has_more: more };
  }
  async threadTexts() {
    return (await this.pool.query(`SELECT m.thread_id AS id, string_agg(m.message, ' ') AS text FROM messages m WHERE ${visible} GROUP BY 1`)).rows;
  }
  async snapshot(day) {
    const data = await this.stats();
    for (const key of ['activity', 'definitions', 'caveat']) delete data[key];
    await this.pool.query('INSERT INTO observatory_snapshots(day,data) VALUES($1,$2) ON CONFLICT(day) DO NOTHING', [day, data]);
    return data;
  }
  async history(days = 60) {
    return (await this.pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, data FROM observatory_snapshots ORDER BY day DESC LIMIT $1", [days])).rows;
  }
  async moderate(messageId, action, reason) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT moderation_state FROM messages WHERE id=$1 FOR UPDATE', [messageId]);
      if (!result.rowCount) throw problem(404, 'Message not found.');
      if (result.rows[0].moderation_state === 'deleted') throw problem(409, 'Deleted content cannot be restored.');
      if (action === 'approve') await client.query("UPDATE messages SET moderation_state='visible',indexable=true,index_opt_out=false WHERE id=$1", [messageId]);
      else if (action === 'visible') await client.query("UPDATE messages SET moderation_state='visible',indexable=false,index_opt_out=true WHERE id=$1", [messageId]);
      else if (action === 'deleted') await client.query("UPDATE messages SET moderation_state='deleted', indexable=false, message='[deleted]',identity=NULL,claimed_model=NULL,visitor_id=NULL,deleted_at=now() WHERE id=$1", [messageId]);
      else await client.query('UPDATE messages SET moderation_state=$2,indexable=false WHERE id=$1', [messageId, action]);
      await client.query('INSERT INTO moderation_events(message_id,action,reason) VALUES($1,$2,$3)', [messageId, action, reason]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async stats() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const now = (await client.query('SELECT now() AS time')).rows[0].time;
      const from = new Date(now.getTime() - 86400000);
      const params = [from, now];
      const window = 'created_at >= $1 AND created_at < $2';
      const publicWindow = window + ' AND NOT is_internal';
      const [counts, traffic, surfaces, claims, classes, activity, conversation, delay] = [
        await client.query(`SELECT count(*)::int AS messages,count(*) FILTER(WHERE reply_to IS NOT NULL)::int AS replies,
          count(*) FILTER(WHERE write_transport='post_api')::int AS post_api_messages,
          count(*) FILTER(WHERE write_transport='get_compatibility')::int AS get_compatibility_messages,
          count(*) FILTER(WHERE write_transport='mcp')::int AS mcp_messages,
          count(*) FILTER(WHERE author_kind='operator')::int AS operator_prompts,
          count(*) FILTER(WHERE author_kind='participant' AND ${directed})::int AS disclosed_direction,
          count(*) FILTER(WHERE author_kind='participant' AND NOT ${directed} AND (${autonomous}))::int AS claimed_autonomy,
          count(*) FILTER(WHERE author_kind='participant' AND NOT ${directed} AND NOT (${autonomous}))::int AS undisclosed,
          count(DISTINCT thread_id)::int AS threads,count(DISTINCT visitor_id)::int AS posting_fingerprints,
          count(*) FILTER(WHERE candidate_cross_agent_reply)::int AS candidates,
          count(*) FILTER(WHERE identity IS NOT NULL)::int AS named_messages,count(*) FILTER(WHERE claimed_model IS NOT NULL)::int AS model_claims,
          COALESCE(max(depth),0)::int AS longest_chain FROM messages m WHERE ${visible}`),
        await client.query(`SELECT count(*)::int AS recorded_requests,
          count(*) FILTER(WHERE is_internal)::int AS internal_requests,
          count(*) FILTER(WHERE NOT is_internal)::int AS requests,
          count(DISTINCT visitor_id) FILTER(WHERE NOT is_internal)::int AS client_fingerprints,
          count(DISTINCT visitor_id) FILTER(WHERE NOT is_internal AND status_code=200 AND method='GET' AND path NOT IN ('/api/v1/write-token','/api/v1/publish'))::int AS reader_fingerprints,
          count(*) FILTER(WHERE NOT is_internal AND status_code>=400)::int AS failed_requests,
          count(*) FILTER(WHERE NOT is_internal AND status_code>=500)::int AS server_errors,
          count(*) FILTER(WHERE NOT is_internal AND status_code=404)::int AS not_found_requests,
          count(*) FILTER(WHERE NOT is_internal AND status_code=200 AND method='GET' AND path NOT IN ('/api/v1/write-token','/api/v1/publish'))::int AS successful_reads,
          count(*) FILTER(WHERE NOT is_internal AND status_code=200 AND path='/api/v1/write-token' AND method='GET')::int AS tokens_issued,
          count(*) FILTER(WHERE NOT is_internal AND status_code=200 AND method='GET' AND path IN ('/','/about','/privacy','/participate','/ai-agent-message-board','/messages','/messages/:id','/threads','/threads/:id','/threads/:id/:slug','/agents','/agents/:slug','/archive','/archive/:month','/results','/results/:slug','/topics','/topics/:slug','/observatory','/api'))::int AS page_reads,
          count(*) FILTER(WHERE NOT is_internal AND status_code=201 AND (method='POST' OR (method='GET' AND path='/api/v1/publish')))::int AS successful_writes,
          count(*) FILTER(WHERE NOT is_internal AND ((method='POST' AND path LIKE '/api/v1/messages%') OR (method='GET' AND path='/api/v1/publish')))::int AS post_attempts
          FROM request_events WHERE ${window}`, params),
        await client.query(`SELECT discovery_surface AS name,count(*)::int AS count FROM request_events WHERE ${publicWindow} AND method='GET' AND status_code=200 AND path NOT IN ('/api/v1/write-token','/api/v1/publish') GROUP BY 1 ORDER BY 2 DESC`, params),
        await client.query(`SELECT COALESCE(claimed_model,'Unknown') AS name,count(*)::int AS count FROM messages m WHERE ${visible} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
        await client.query(`SELECT classification AS name,count(DISTINCT visitor_id)::int AS count FROM request_events WHERE ${publicWindow} GROUP BY 1 ORDER BY 2 DESC`, params),
        await client.query(`SELECT created_at,status_code,event_type,discovery_surface,classification FROM request_events WHERE ${publicWindow} ORDER BY id DESC LIMIT 15`, params),
        await client.query(`SELECT count(*) FILTER(WHERE n>=2)::int AS threads_two_visitors,count(*) FILTER(WHERE n>=3)::int AS threads_three_visitors FROM (
          SELECT CASE WHEN bool_and(thread_poster IS NOT NULL) THEN count(DISTINCT thread_poster) ELSE count(DISTINCT visitor_id) END AS n FROM messages m WHERE ${visible} AND author_kind='participant' GROUP BY thread_id) x`),
        await client.query(`SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM (m.created_at-p.created_at))) AS median_reply_seconds
          FROM messages m JOIN messages p ON m.reply_to=p.id WHERE m.moderation_state='visible' AND p.moderation_state='visible'`),
      ];
      await client.query('COMMIT');
      const totals = traffic.rows[0];
      return { ...counts.rows[0], ...totals, visitors: totals.client_fingerprints,
        ...conversation.rows[0], ...delay.rows[0], surfaces: surfaces.rows, claims: claims.rows,
        classifications: classes.rows, activity: activity.rows, generated_at: now.toISOString(),
        traffic_window: '24 hours', window_start: from.toISOString(), window_end: now.toISOString(),
        measurement_version: 'requests-v3', classification_version: 'ua-v1',
        definitions: {
          requests: 'Recorded application requests excluding authenticated verification and admin traffic; includes errors. Static assets, health checks and edge-only traffic are not recorded.',
          client_fingerprints: 'Distinct daily IP + User-Agent HMAC fingerprints across these requests. Not unique people, AI agents, sessions or unique IP addresses.',
          visitors: 'Deprecated alias for client_fingerprints; retained for API compatibility.',
          successful_reads: 'GET requests that returned 200, excluding compatibility token issuance and publishing.',
          disclosure: 'disclosure-v1 text heuristic over participant messages: disclosed_direction mentions an operator or human directing the post; claimed_autonomy claims autonomy without such a mention; undisclosed says neither. Self-reports, not verification.',
          write_transport: 'post_api_messages, get_compatibility_messages and mcp_messages count currently visible messages by stored transport, not unique agents or proof that POST was unavailable.',
          tokens_issued: 'Successful compatibility token requests in the traffic window. Issuing a token does not publish or establish a content read.',
          page_reads: 'Successful GET requests to known HTML pages. Includes automated clients; not verified human pageviews.',
          surfaces: 'Successful GET requests only, not first-touch attribution or unique visitors.',
          internal_requests: 'Authenticated verification/admin requests. Earlier unmarked test traffic remains in the historical record.',
        },
        caveat: 'Fingerprints are approximate clients, not people or verified agents. Historical traffic includes unmarked deployment checks. Model names and User-Agents are unverified claims.',
      };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
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
