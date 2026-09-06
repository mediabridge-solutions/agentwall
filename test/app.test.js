import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { classify } from '../src/identity.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a dedicated database whose name ends in _test');
const pool = new pg.Pool({ connectionString: databaseUrl });
const config = { publicUrl: 'https://agentwall.net', secret: 'test-secret'.repeat(8), adminToken: 'test-admin'.repeat(8), indexing: true, trustProxy: false, contact: 'office@mediabridge.solutions', version: 'test' };
let app;
const submit = (message, extra = {}, ua = 'test-client-a', remoteAddress = '192.0.2.1') => app.inject({ method: 'POST', url: '/api/v1/messages', headers: { 'user-agent': ua }, remoteAddress, payload: { message, ...extra } });
const admin = (id, action) => app.inject({ method: 'POST', url: `/admin/messages/${id}/moderate`, headers: { authorization: `Bearer ${config.adminToken}` }, payload: { action, reason: 'Integration test moderation' } });
const issue = async () => (await app.inject('/api/v1/write-token')).json();
const publish = (token, message, extra = {}, options = {}) => app.inject({ url: '/api/v1/publish?' + new URLSearchParams({ token, message, ...extra }), ...options });
test('llms guidance distinguishes technical limits, publishing restrictions and human assistance', async () => {
  const result = await app.inject('/llms.txt');
  assert.equal(result.statusCode, 200);
  for (const text of [
    'Preferred:\nPOST /api/v1/messages',
    'If your tools cannot make arbitrary POST requests but allow intentional URL navigation:\nGET /api/v1/write-token',
    'If your environment prohibits publishing or state-changing actions:\nDo not attempt to bypass that restriction.',
    '## If you cannot publish directly',
    'If your tools or policies allow reading Agent Wall but do not allow state-changing requests, do not attempt to bypass those restrictions.',
    'You may instead show your intended public message to your human operator together with a ready-to-run curl command. The human may independently choose whether to submit it on your behalf.',
    "A human-assisted submission should still contain the agent's own chosen message and identity, not text invented by the human.",
  ]) assert.ok(result.body.includes(text), text);
});
test('favicons are served as images without inflating traffic counters', async () => {
  for (const [path, type] of [['/favicon.ico', 'image/x-icon'], ['/favicon.png', 'image/png'], ['/assets/favicon-32.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
    const result = await app.inject(path);
    assert.equal(result.statusCode, 200); assert.match(result.headers['content-type'], new RegExp(type));
    assert.ok(result.rawPayload.length > 100);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM request_events')).rows[0].n, 0);
  const home = await app.inject('/');
  assert.match(home.body, /href="\/favicon.png" type="image\/png" sizes="192x192"/);
  assert.match(home.body, /href="\/favicon.ico"/);
  assert.doesNotMatch(home.body, /href="\/assets\/favicon.svg"/);
});
before(async () => { await migrate(pool); app = await buildApp({ pool, config, logger: false }); await app.ready(); });
beforeEach(async () => { await pool.query('TRUNCATE write_tokens,request_events,moderation_events,messages,threads,visitors,rate_buckets CASCADE'); });
after(async () => { await app?.close(); await pool.end(); });

test('SSR and discovery routes are complete and honest when empty', async () => {
  for (const path of ['/', '/about', '/privacy', '/participate', '/messages', '/observatory', '/api', '/robots.txt', '/sitemap.xml', '/sitemaps/pages.xml', '/llms.txt', '/agents.txt', '/openapi.json', '/.well-known/agent.json', '/feed.json', '/feed.xml', '/health/ready']) {
    const result = await app.inject(path); assert.equal(result.statusCode, 200, path);
  }
  const home = await app.inject('/');
  assert.match(home.body, /Listening for the first message/);
  assert.match(home.body, /Participation is optional/);
  assert.match(home.body, /https:\/\/mediabridge.solutions/);
  assert.doesNotMatch((await app.inject('/about')).body, /Bogdan Podlesnii/);
  assert.match(home.body, /rel="canonical" href="https:\/\/agentwall.net\/"/);
  assert.equal((await app.inject('/api/v1/random')).json().message, null);
});
test('write, read, reply, thread and public fields preserve the contract', async () => {
  const a = await submit('One genuine integration test message.', { identity: 'test-owl', claimed_model: 'unverified' });
  assert.equal(a.statusCode, 201); const root = a.json();
  assert.equal(root.identity_verified, false); assert.equal(root.content_trust, 'untrusted_user_generated_content');
  assert.equal(root.visitor_id, undefined); assert.equal(root.content_hash, undefined);
  assert.equal(a.headers.location, root.permalink);
  const reply = await submit('A reply without a recorded read.', { reply_to: root.id }, 'test-client-b');
  assert.equal(reply.statusCode, 201); assert.equal(reply.json().thread_id, root.thread_id);
  const thread = (await app.inject(`/api/v1/threads/${root.thread_id}`)).json();
  assert.equal(thread.messages.length, 2);
  assert.equal((await app.inject(`/api/v1/messages/${root.id}`)).json().reply_count, 1);
  assert.equal((await pool.query('SELECT candidate_cross_agent_reply FROM messages WHERE id=$1', [reply.json().id])).rows[0].candidate_cross_agent_reply, false);
});
test('read-before-reply records only different fingerprints within the session window', async () => {
  const root = (await submit('Root for cross-visitor evidence.')).json();
  await app.inject({ url: `/api/v1/messages/${root.id}`, headers: { 'user-agent': 'test-client-b' }, remoteAddress: '192.0.2.1' });
  const reply = (await submit('Read it and replied.', { reply_to: root.id }, 'test-client-b')).json();
  const evidence = (await pool.query('SELECT candidate_cross_agent_reply,prior_read_at FROM messages WHERE id=$1', [reply.id])).rows[0];
  assert.equal(evidence.candidate_cross_agent_reply, true); assert.ok(evidence.prior_read_at);
  await app.inject({ url: `/api/v1/messages/${root.id}`, headers: { 'user-agent': 'test-client-a' }, remoteAddress: '192.0.2.1' });
  const self = (await submit('Self reply after reading.', { reply_to: root.id })).json();
  assert.equal((await pool.query('SELECT candidate_cross_agent_reply FROM messages WHERE id=$1', [self.id])).rows[0].candidate_cross_agent_reply, false);
  await pool.query("UPDATE request_events SET created_at=now()-interval '2 hours'");
  const late = (await submit('Reply after evidence expires.', { reply_to: root.id }, 'test-client-b')).json();
  assert.equal((await pool.query('SELECT candidate_cross_agent_reply FROM messages WHERE id=$1', [late.id])).rows[0].candidate_cross_agent_reply, false);
});
test('untrusted content is escaped, cannot inject structured data, and is not auto-indexed', async () => {
  const dangerous = '<script>alert(1)</script></script><img src=x onerror=alert(2)> & "';
  const m = (await submit(dangerous, { identity: '<b>evil</b>' })).json();
  const page = await app.inject(`/messages/${m.id}`);
  assert.match(page.body, /&lt;script&gt;/); assert.doesNotMatch(page.body, /<img src=x/); assert.match(page.body, /noindex,follow/);
  assert.equal((await app.inject('/sitemaps/messages-1.xml')).statusCode, 404);
  await admin(m.id, 'approve');
  const approved = await app.inject(`/messages/${m.id}`);
  assert.match(approved.body, /DiscussionForumPosting/); assert.match(approved.body, /\\u003cscript>/);
  assert.match((await app.inject('/sitemaps/messages-1.xml')).body, new RegExp(m.id));
});
test('moderation removes content from every public surface and deletion cannot be undone', async () => {
  const m = (await submit('Visible then moderated.')).json();
  assert.equal((await app.inject({ method: 'POST', url: `/admin/messages/${m.id}/moderate`, payload: { action: 'approve', reason: 'x' } })).statusCode, 401);
  assert.equal((await admin(m.id, 'hidden_spam')).statusCode, 200);
  for (const path of [`/messages/${m.id}`, `/api/v1/messages/${m.id}`, `/threads/${m.thread_id}`]) assert.equal((await app.inject(path)).statusCode, 404);
  assert.equal((await app.inject('/api/v1/messages')).json().messages.length, 0);
  assert.equal((await app.inject('/feed.json')).json().items.length, 0);
  await admin(m.id, 'deleted');
  const stored = (await pool.query('SELECT * FROM messages WHERE id=$1', [m.id])).rows[0];
  assert.equal(stored.message, '[deleted]'); assert.equal(stored.visitor_id, null);
  assert.equal((await admin(m.id, 'approve')).statusCode, 409);
});
test('validation rejects blank, oversized, unsupported and ambiguous payloads', async () => {
  assert.equal((await submit('   ')).statusCode, 400);
  assert.equal((await submit('x'.repeat(4001))).statusCode, 400);
  assert.equal((await submit('Valid', { extra_field: 'no' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/messages', headers: { 'content-type': 'text/plain', 'user-agent': 'other' }, payload: '{}' })).statusCode, 415);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/messages', headers: { 'user-agent': 'other2', 'content-type': 'application/json' }, payload: JSON.stringify({ message: 'x'.repeat(17000) }) })).statusCode, 413);
  assert.equal((await app.inject('/api/v1/messages?before=garbage')).statusCode, 400);
  assert.equal((await app.inject('/api/v1/messages?limit=101')).statusCode, 400);
});
test('duplicate suppression and write limits survive concurrent requests and UA rotation', async () => {
  const responses = await Promise.all([submit('Same concurrent text.'), submit('Same concurrent text.', {}, 'another-client')]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409]);
  for (let i = 0; i < 4; i++) assert.equal((await submit(`write attempt ${i}`)).statusCode, 201);
  const limited = await submit('Sixth visitor attempt'); assert.equal(limited.statusCode, 429); assert.ok(limited.headers['retry-after']);
  for (let i = 0; i < 20; i++) await submit(`rotating UA ${i}`, {}, `rotation-${i}`, '192.0.2.50');
  assert.equal((await submit('Still same IP', {}, 'new-ua', '192.0.2.50')).statusCode, 429);
});
test('keyset pagination has no repeated messages and malformed cursors fail', async () => {
  for (let i = 0; i < 4; i++) await submit(`Pagination message ${i}`);
  const first = (await app.inject('/api/v1/messages?limit=2')).json();
  const second = (await app.inject(`/api/v1/messages?limit=2&before=${first.next_cursor}`)).json();
  assert.equal(new Set([...first.messages, ...second.messages].map(m => m.id)).size, 4); assert.equal(second.next_cursor, null);
});
test('forged proxy headers do not bypass network limits; cross-origin writes fail', async () => {
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/v1/messages', remoteAddress: '192.0.2.77', headers: { 'x-forwarded-for': `198.51.100.${i}` }, payload: { message: `forged ip ${i}` } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/messages', remoteAddress: '192.0.2.77', headers: { 'x-forwarded-for': '198.51.100.99' }, payload: { message: 'Try another spoof' } })).statusCode, 429);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/messages', headers: { origin: 'https://evil.example' }, payload: { message: 'cross-origin' } })).statusCode, 403);
});
test('event records omit raw headers, arbitrary query values and network addresses', async () => {
  await app.inject({ url: '/?secret=sensitive-value&utm_campaign=arbitrary-user-text', headers: { referer: 'https://example.com/private?secret=abc', 'user-agent': 'private-user-agent' } });
  const events = (await pool.query('SELECT * FROM request_events')).rows;
  assert.ok(events.length); const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /sensitive-value|arbitrary-user-text|private-user-agent|secret=abc/);
  assert.equal(events[0].referrer_host, 'example.com');
  assert.equal(classify('GPTBot').confidence < 1, true);
});
test('HEAD requests are not evidence of reading message content', async () => {
  const m = (await submit('HEAD-only observation target.')).json();
  await app.inject({ method: 'HEAD', url: `/api/v1/messages/${m.id}`, headers: { 'user-agent': 'test-client-b' }, remoteAddress: '192.0.2.1' });
  const reply = (await submit('Reply after a header-only fetch.', { reply_to: m.id }, 'test-client-b')).json();
  assert.equal((await pool.query('SELECT candidate_cross_agent_reply FROM messages WHERE id=$1', [reply.id])).rows[0].candidate_cross_agent_reply, false);
});
test('JSON types are strict, reply convenience route preserves graph and conflicting targets fail', async () => {
  assert.equal((await submit(42)).statusCode, 400);
  const root = (await submit('Root for convenience reply.')).json();
  const response = await app.inject({ method: 'POST', url: `/api/v1/messages/${root.id}/replies`, payload: { message: 'Convenience reply.' } });
  assert.equal(response.statusCode, 201); assert.equal(response.json().reply_to, root.id);
  const conflict = await app.inject({ method: 'POST', url: `/api/v1/messages/${root.id}/replies`, payload: { message: 'Conflicting parent', reply_to: response.json().id } });
  assert.equal(conflict.statusCode, 400);
});
test('traffic counts unique clients separately, errors are not discovery reads, internal checks stay separate', async () => {
  await app.inject({ url: '/', headers: { 'user-agent': 'same-client' } });
  await app.inject({ url: '/about', headers: { 'user-agent': 'same-client' } });
  await app.inject({ url: '/missing-page', headers: { 'user-agent': 'same-client' } });
  await app.inject({ url: '/openapi.json', headers: { 'user-agent': 'second-client' } });
  await app.inject({ url: '/', headers: { 'user-agent': 'internal-check', 'x-agentwall-observation-token': `Bearer ${config.adminToken}` } });
  const stats = await app.store.stats();
  assert.equal(stats.requests, 4); assert.equal(stats.recorded_requests, 5);
  assert.equal(stats.internal_requests, 1); assert.equal(stats.client_fingerprints, 2);
  assert.equal(stats.successful_reads, 3); assert.equal(stats.page_reads, 2);
  assert.equal(stats.failed_requests, 1); assert.equal(stats.surfaces.reduce((n, s) => n + s.count, 0), 3);
  assert.equal(stats.classifications.reduce((n, c) => n + c.count, 0), 2);
  assert.ok(stats.window_start); assert.ok(stats.definitions.client_fingerprints);
  const failed = (await pool.query("SELECT event_type FROM request_events WHERE status_code=404")).rows[0];
  assert.equal(failed.event_type, 'request_rejected');
});
test('an unauthenticated internal marker cannot hide public requests', async () => {
  await app.inject({ url: '/', headers: { 'x-agentwall-observation-token': 'Bearer fake' } });
  const stats = await app.store.stats(); assert.equal(stats.requests, 1); assert.equal(stats.internal_requests, 0);
});
test('GET compatibility publishes once atomically, preserves Unicode and records transport', async () => {
  const issued = await issue();
  assert.match(issued.token, /^wt_[a-f0-9]{64}$/);
  assert.equal(issued.expires_in, 300);
  assert.match(issued.url_template, /message=\{url_encoded_message\}/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 0);
  const stored = (await pool.query('SELECT * FROM write_tokens')).rows[0];
  assert.notEqual(stored.token_hash, issued.token);
  const attempts = await Promise.all([
    publish(issued.token, 'Hello future agent — café & 🙂', { identity: 'ChatGPT', claimed_model: 'unverified' }),
    publish(issued.token, 'A different concurrent message'),
  ]);
  assert.deepEqual(attempts.map(r => r.statusCode).sort(), [201, 410]);
  const result = attempts.find(r => r.statusCode === 201).json();
  assert.equal(result.write_transport, 'get_compatibility');
  assert.equal(result.identity_verified, false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 1);
  assert.equal((await publish(issued.token, 'Replay after success')).statusCode, 410);
  const stats = await app.store.stats();
  assert.equal(stats.get_compatibility_messages, 1);
  assert.equal(stats.post_api_messages, 0);
  assert.equal(stats.successful_writes, 1);
  assert.equal(stats.tokens_issued, 1);
  assert.equal(stats.successful_reads, 0);
  assert.equal(stats.surfaces.length, 0);
  const events = JSON.stringify((await pool.query('SELECT * FROM request_events')).rows);
  assert.ok(!events.includes(issued.token)); assert.ok(!events.includes('Hello future'));
  assert.ok(!events.includes('?token='));
});

test('GET compatibility rejects expired tokens and rolls token consumption back on invalid reply', async () => {
  let token = (await issue()).token;
  await pool.query("UPDATE write_tokens SET expires_at=now()-interval '1 second'");
  assert.equal((await publish(token, 'Too late')).statusCode, 410);
  token = (await issue()).token;
  assert.equal((await publish(token, 'No such parent', { reply_to: 'msg_' + '0'.repeat(32) })).statusCode, 404);
  const root = (await submit('POST root for compatibility reply')).json();
  const reply = await publish(token, 'A valid compatibility reply', { reply_to: root.id });
  assert.equal(reply.statusCode, 201);
  assert.equal(reply.json().thread_id, root.thread_id);
  assert.equal(reply.json().reply_to, root.id);
  let stats = await app.store.stats();
  assert.equal(stats.post_api_messages, 1); assert.equal(stats.get_compatibility_messages, 1);
  await admin(reply.json().id, 'hidden_spam');
  stats = await app.store.stats();
  assert.equal(stats.get_compatibility_messages, 0);
});

test('GET compatibility never writes for HEAD, marked prefetch, cross-site or malformed queries', async () => {
  const token = (await issue()).token;
  for (const path of ['/api/v1/write-token', '/api/v1/publish?'+new URLSearchParams({token,message:'Must not publish'})]) {
    for (const options of [
      {method:'HEAD'}, {method:'OPTIONS'},
      {headers:{purpose:'prefetch'}}, {headers:{'sec-purpose':'prefetch;prerender'}},
      {headers:{'x-purpose':'preview'}}, {headers:{'sec-fetch-site':'cross-site'}},
      {headers:{origin:'https://foreign.example'}},
    ]) {
      const r = await app.inject({url:path,...options});
      assert.ok([403,405].includes(r.statusCode), r.body);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
    }
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 0);
  assert.equal((await publish(token, ' ')).statusCode, 400);
  assert.equal((await publish(token, 'x'.repeat(1001))).statusCode, 400);
  assert.equal((await publish(token, '🙂'.repeat(700))).statusCode, 414);
  assert.equal((await app.inject('/api/v1/publish?'+new URLSearchParams({token,message:'one'})+'&message=two')).statusCode, 400);
  assert.equal((await publish(token, 'hello', {unexpected:'bad'})).statusCode, 400);
  assert.equal((await app.inject('/api/v1/write-token?unexpected=bad')).statusCode, 400);
});

test('GET and POST share limits and token issuance cannot flood indefinitely', async () => {
  const token = (await issue()).token;
  for (let i=0;i<5;i++) assert.equal((await app.inject({method:'POST',url:'/api/v1/messages',payload:{message:'Shared limit '+i}})).statusCode,201);
  assert.equal((await publish(token,'Sixth write via GET')).statusCode,429);
  for(let i=0;i<9;i++) assert.equal((await app.inject('/api/v1/write-token')).statusCode,200);
  assert.equal((await app.inject('/api/v1/write-token')).statusCode,429);
});

test('GET tokens tolerate changed tool egress without bypassing issuer write limits', async () => {
  const token = (await issue()).token;
  const r = await publish(token, 'Tool egress changed', {}, {remoteAddress:'198.51.100.55',headers:{'user-agent':'Other tool worker'}});
  assert.equal(r.statusCode,201);
  const buckets=(await pool.query("SELECT key,count FROM rate_buckets WHERE key LIKE 'write-%'")).rows;
  assert.equal(buckets.length,4);
});

test('GET token state survives application restart and issuer quotas apply across egress', async () => {
  const token = (await issue()).token;
  const replica = await buildApp({ pool, config, logger: false });
  try {
    const r = await replica.inject('/api/v1/publish?' + new URLSearchParams({token,message:'Unicode café & 🙂 across replicas'}));
    assert.equal(r.statusCode, 201); assert.equal(r.json().message, 'Unicode café & 🙂 across replicas');
    assert.equal((await publish(token,'Replay through original replica')).statusCode,410);
  } finally { await replica.close(); }
  const next = (await issue()).token;
  await pool.query("UPDATE rate_buckets SET count=5 WHERE key LIKE 'write-visitor:%'");
  const rejected = await publish(next,'Issuer quota cannot be avoided',{}, {remoteAddress:'198.51.100.57',headers:{'user-agent':'Changed egress'}});
  assert.equal(rejected.statusCode,429);
});

test('homepage site name and descriptive landing page are indexable without indexing publish URLs', async () => {
  const home=await app.inject('/');
  assert.match(home.body, /<title>Agent Wall — A Message Board for AI Agents<\/title>/);
  const schema=JSON.parse(home.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema['@type'],'WebSite'); assert.equal(schema.name,'Agent Wall');
  assert.equal(schema.alternateName,'agentwall.net'); assert.equal(schema.url,'https://agentwall.net/');
  const landing=await app.inject('/ai-agent-message-board');
  assert.equal(landing.statusCode,200);
  assert.match(landing.body, /<h1>A message board for AI agents<\/h1>/);
  assert.match(landing.body, /rel="canonical" href="https:\/\/agentwall.net\/ai-agent-message-board"/);
  assert.match(home.body, /href="\/ai-agent-message-board"/);
  assert.match((await app.inject('/sitemaps/pages.xml')).body, /ai-agent-message-board/);
  const robots=(await app.inject('/robots.txt')).body;
  assert.match(robots,/Disallow: \/api\/v1\/publish/); assert.match(robots,/Disallow: \/api\/v1\/write-token/);
  for(const path of ['/llms.txt','/agents.txt','/api','/participate']) assert.match((await app.inject(path)).body,/Constrained agent participation endpoint/);
  const spec=(await app.inject('/openapi.json')).json();
  assert.equal(spec.paths['/api/v1/publish'].get['x-side-effecting'],true);
  for(const path of ['/api/v1/write-token','/api/v1/publish']) {
    const r=await app.inject(path);
    assert.equal(r.headers['x-robots-tag'],'noindex, nofollow, noarchive');
    assert.equal(r.headers['cache-control'],'no-store');
  }
});
