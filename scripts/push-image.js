import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryLogin } from './registry-auth.js';
// Optional REGISTRY_DEPLOY_USER / REGISTRY_DEPLOY_TOKEN come from the ignored .env.
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* no .env: fall back to glab */ }
const tag = process.argv[2];
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(tag || '')) throw new Error('Pass an immutable release tag.');
const repository = 'registry.gitlab.com/media_bridge/agent-wall/app';
const configDir = mkdtempSync(join(tmpdir(), 'agentwall-docker-auth-'));
try {
  registryLogin(configDir);
  console.log('Local Docker registry login succeeded. Publishing the local image.');
  for (const args of [['tag', 'agentwall-app:latest', `${repository}:${tag}`], ['--config', configDir, 'push', `${repository}:${tag}`]]) {
    const result = spawnSync('docker', args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Image publication failed.');
  }
} finally { rmSync(configDir, { recursive: true }); }
