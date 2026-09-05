import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) { console.log('.env already exists; preserving it.'); process.exit(0); }
const password = randomBytes(24).toString('hex');
const lines = [`DATABASE_URL=postgres://agentwall:${password}@127.0.0.1:5549/agentwall`, `POSTGRES_PASSWORD=${password}`, 'PUBLIC_URL=http://agentwall.local', 'PORT=3000', 'HOST=0.0.0.0', `IP_HASH_SECRET=${randomBytes(32).toString('hex')}`, `ADMIN_TOKEN=${randomBytes(32).toString('hex')}`, 'INDEXING_ENABLED=false', 'TRUST_PROXY=false', 'CONTACT_EMAIL=office@mediabridge.solutions', 'LOG_LEVEL=info'];
writeFileSync('.env', lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created private local .env with fresh random secrets.');
