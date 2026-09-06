import { inspectVaultReplica, markVaultReplicaIndexed, syncVaultReplica } from '../src/vault-replica.mjs';

const options = {};
const allowed = new Set(['source', 'target', 'state-dir', 'status', 'index-generation', 'version', 'help']);
try {
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index].replace(/^--/u, '');
    if (!process.argv[index].startsWith('--') || !allowed.has(key) || Object.hasOwn(options, key)) throw new Error('Invalid or duplicate argument.');
    options[key] = ['status', 'help'].includes(key) ? true : process.argv[++index];
    if (options[key] === undefined || String(options[key]).startsWith('--')) throw new Error('Missing argument value.');
  }
  if (options.help) {
    process.stdout.write('Offline manual copy (stop target writers first):\n  node scripts/sync-vault-copy.mjs --source DIR --target NEW_COPY --state-dir PRIVATE_DATA\n  node scripts/sync-vault-copy.mjs --state-dir PRIVATE_DATA --status\n  node scripts/sync-vault-copy.mjs --state-dir PRIVATE_DATA --version VERSION --index-generation GENERATION\n');
  } else {
    let result;
    if (options.status) result = await inspectVaultReplica({ stateDir: options['state-dir'] });
    else if (options['index-generation']) result = await markVaultReplicaIndexed({
      stateDir: options['state-dir'], expectedVersion: options.version, generation: options['index-generation'],
    });
    else result = await syncVaultReplica({ sourceRoot: options.source, targetRoot: options.target, stateDir: options['state-dir'] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'REPLICA_COMMAND_FAILED', conflicts: error.conflicts || [] })}\n`);
  process.exitCode = 1;
}
