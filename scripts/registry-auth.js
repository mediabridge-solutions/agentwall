import { spawnSync } from 'node:child_process';

export function redactRegistryDiagnostic(value, credentials = {}) {
  let text = String(value || '');
  const { Username: user, Secret: secret } = credentials;
  for (const sensitive of [secret, secret && encodeURIComponent(secret), user && secret && Buffer.from(`${user}:${secret}`).toString('base64')].filter(Boolean)) {
    text = text.split(sensitive).join('[REDACTED]');
  }
  return text
    .replace(/(authorization\s*[:=]\s*(?:basic|bearer)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[REDACTED]')
    .replace(/glpat-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .slice(0, 4000).trim();
}

export function registryLogin(configDir, run = spawnSync) {
  const registry = 'registry.gitlab.com';
  const auth = run('glab', ['auth', 'docker-helper', 'get'], { input: `${registry}\n`, encoding: 'utf8', timeout: 30000 });
  if (auth.status !== 0) throw new Error(`GitLab credential helper failed (exit ${auth.status ?? 'none'}, code ${auth.error?.code || 'none'}): ${redactRegistryDiagnostic(auth.stderr) || 'No diagnostic returned.'}`);
  let credentials;
  try { credentials = JSON.parse(auth.stdout); } catch { throw new Error('GitLab credential helper returned invalid JSON (credential output withheld).'); }
  if (typeof credentials?.Username !== 'string' || !credentials.Username || typeof credentials.Secret !== 'string' || !credentials.Secret) {
    throw new Error('GitLab credential helper returned missing credentials (output withheld).');
  }
  const login = run('docker', ['--config', configDir, 'login', registry, '-u', credentials.Username, '--password-stdin'], { input: credentials.Secret, encoding: 'utf8', timeout: 45000 });
  if (login.status !== 0) {
    const detail = redactRegistryDiagnostic(login.stderr || login.stdout, credentials) || 'No Docker diagnostic returned.';
    throw new Error(`Docker registry login failed (exit ${login.status ?? 'none'}, code ${login.error?.code || 'none'}): ${detail}`);
  }
}
