export function configFromEnv(env = process.env) {
  const url = new URL(env.PUBLIC_URL || 'http://agentwall.local');
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('PUBLIC_URL must be an HTTP(S) origin');
  for (const key of ['DATABASE_URL', 'IP_HASH_SECRET', 'ADMIN_TOKEN']) {
    if (!env[key] || (key !== 'DATABASE_URL' && env[key].length < 32)) throw new Error(`${key} is required (secrets: at least 32 characters)`);
  }
  return {
    databaseUrl: env.DATABASE_URL, publicUrl: url.origin, secret: env.IP_HASH_SECRET,
    adminToken: env.ADMIN_TOKEN, indexing: env.INDEXING_ENABLED === 'true',
    trustProxy: env.TRUST_PROXY && env.TRUST_PROXY !== 'false' ? env.TRUST_PROXY.split(',') : false,
    contact: env.CONTACT_EMAIL || 'hello@agentwall.net', port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0', logLevel: env.LOG_LEVEL || 'info', version: env.APP_VERSION || '1.0.0',
  };
}
