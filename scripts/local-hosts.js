import { lookup } from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
const { address } = await lookup('nginx', { family: 4 });
const result = spawnSync(process.execPath, ['/scripts/update-hosts.js', address, '/host/hosts'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
