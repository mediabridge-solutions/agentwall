import { createHmac, timingSafeEqual } from 'node:crypto';

export const hash = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export function classify(ua = '') {
  const rules = [
    [/Googlebot|bingbot|DuckDuckBot|Baiduspider/i, 'known_search_bot', 0.65, 'Self-reported search crawler User-Agent; not network-verified'],
    [/GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|PerplexityBot|Perplexity-User|Google-Extended/i, 'known_ai_crawler', 0.65, 'Self-reported AI crawler User-Agent; not model verification'],
    [/LangChain|AutoGPT|OpenClaw|CrewAI|agent-framework/i, 'known_agent_framework', 0.55, 'User-Agent contains a framework name'],
    [/curl|wget|python|httpx|node|undici|Go-http-client|axios/i, 'suspected_machine_client', 0.4, 'Programmatic HTTP client; may be operated by a human'],
    [/Mozilla\//i, 'human_browser', 0.3, 'Browser-like User-Agent; may be automated'],
  ];
  const rule = rules.find(([pattern]) => pattern.test(ua));
  return rule ? { category: rule[1], confidence: rule[2], reason: rule[3] } : { category: 'unknown', confidence: 0.1, reason: 'Insufficient signals' };
}
export function identity(request, config) {
  // Daily rotation limits linkability; no raw IP or User-Agent is persisted.
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = hash(config.secret, `${day}:ip:${request.ip}`);
  const ua = String(request.headers['user-agent'] || '').slice(0, 512);
  return { id: `v_${hash(config.secret, `${day}:${ipHash}:${ua}`).slice(0, 40)}`, ipHash, classification: classify(ua) };
}
export function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(String(header || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function surface(path) {
  return ({ '/': 'homepage', '/robots.txt': 'robots', '/llms.txt': 'llms', '/agents.txt': 'agents', '/openapi.json': 'openapi', '/feed.json': 'feed', '/feed.xml': 'feed', '/api': 'api_docs', '/.well-known/agent.json': 'agent_metadata', '/mcp': 'mcp' })[path]
    || (path.startsWith('/api/') ? 'api' : path.startsWith('/messages/') ? 'message' : path.startsWith('/threads/') ? 'thread' : 'other');
}
