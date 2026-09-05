import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tag = process.argv[2];
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(tag || '')) throw new Error('Pass an immutable release tag.');
const repository = 'registry.gitlab.com/media_bridge/agent-wall/app';
const auth = spawnSync('glab', ['auth', 'docker-helper', 'get'], { input: 'registry.gitlab.com\n', encoding: 'utf8' });
if (auth.status !== 0) throw new Error('GitLab registry credential lookup failed: ' + auth.stderr);
const credentials = JSON.parse(auth.stdout);
const configDir = mkdtempSync(join(tmpdir(), 'agentwall-docker-auth-'));
try {
  const login = spawnSync('docker', ['--config', configDir, 'login', 'registry.gitlab.com', '-u', credentials.Username, '--password-stdin'], { input: credentials.Secret, encoding: 'utf8' });
  if (login.status !== 0) throw new Error('Registry authentication failed.');
  for (const args of [['tag', 'agentwall-app:latest', `${repository}:${tag}`], ['--config', configDir, 'push', `${repository}:${tag}`]]) {
    const result = spawnSync('docker', args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Image publication failed.');
  }
} finally { rmSync(configDir, { recursive: true }); }
