import { spawnSync } from 'node:child_process';
const tag = process.argv[2];
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(tag || '')) throw new Error('Pass the published release image tag.');
const context = 'microk8s-mediabridge', namespace = 'agentwall';
const kube = ['--context', context, '-n', namespace];
function run(cmd, args) { const r = spawnSync(cmd, args, { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`${cmd} failed`); }
const helmArgs = ['upgrade', '--install', 'agentwall', 'infra/helm', '-f', 'infra/helm/values-production.yaml', '--kube-context', context, '--namespace', namespace, '--set', `image.tag=${tag}`];
if (process.env.INDEXING_ENABLED !== undefined) helmArgs.push('--set', `indexingEnabled=${process.env.INDEXING_ENABLED === 'true'}`);
run('helm', helmArgs);
run('kubectl', [...kube, 'rollout', 'status', 'deployment/agentwall', '--timeout=300s']);
// Provision the backup PVC on first install: hostpath waits for its first consumer.
const backupPhase = spawnSync('kubectl', [...kube, 'get', 'pvc', 'agentwall-backups', '-o', 'jsonpath={.status.phase}'], { encoding: 'utf8' });
if (backupPhase.stdout === 'Pending') {
  const job = `agentwall-backup-bootstrap-${Date.now()}`;
  run('kubectl', [...kube, 'create', 'job', '--from=cronjob/agentwall-backup', job]);
  run('kubectl', [...kube, 'wait', '--for=condition=complete', `job/${job}`, '--timeout=300s']);
}
console.log(`Deployed ${tag} to ${context}/${namespace}.`);
