import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const context = 'microk8s-mediabridge';
const namespace = 'agentwall';
function run(command, args, input) {
  const r = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${command} failed: ${r.stderr}`);
  return r.stdout;
}
const base = ['--context', context, '-n', namespace];
const exists = (type, name) => spawnSync('kubectl', [...base, 'get', type, name, '-o', 'name'], { stdio: 'ignore' }).status === 0;
const apply = object => run('kubectl', ['--context', context, 'apply', '-f', '-'], JSON.stringify(object));
apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
if (!exists('secret', 'agentwall-secrets')) {
  const password = randomBytes(32).toString('hex');
  apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'agentwall-secrets', namespace }, type: 'Opaque', stringData: {
    POSTGRES_PASSWORD: password, DATABASE_URL: `postgres://agentwall:${password}@agentwall-postgres:5432/agentwall`,
    IP_HASH_SECRET: randomBytes(32).toString('hex'), ADMIN_TOKEN: randomBytes(32).toString('hex'),
  } });
  console.log('Created production database and admin secrets in the cluster.');
} else console.log('Existing production secrets preserved.');
if (!exists('secret', 'agentwall-registry')) {
  const token = JSON.parse(run('glab', ['api', 'projects/86123952/deploy_tokens', '-X', 'POST', '-f', 'name=agentwall-kubernetes-pull', '-F', 'scopes=["read_registry"]', '-f', 'expires_at=2027-09-05T00:00:00Z']));
  const dockerConfig = { auths: { 'registry.gitlab.com': { username: token.username, password: token.token, auth: Buffer.from(`${token.username}:${token.token}`).toString('base64') } } };
  apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'agentwall-registry', namespace }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': Buffer.from(JSON.stringify(dockerConfig)).toString('base64') } });
  console.log('Created scoped registry pull credentials; rotate before September 5, 2027.');
} else console.log('Existing registry pull credentials preserved.');
