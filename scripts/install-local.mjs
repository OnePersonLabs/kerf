import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codex = process.platform === 'win32' ? 'codex.exe' : 'codex';
const pluginId = 'kerf@kerf';

if (process.argv.length > 2) throw new Error('Usage: node scripts/install-local.mjs');

function run(args) {
  const result = spawnSync(codex, args, { cwd: sourceRoot, shell: false, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${codex} exited ${result.status}`);
  return JSON.parse(result.stdout);
}

for (const file of ['.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', 'node_modules/typescript/package.json', 'node_modules/yaml/package.json']) {
  await access(path.join(sourceRoot, file));
}

run(['plugin', 'marketplace', 'add', sourceRoot, '--json']);
const listing = run(['plugin', 'list', '--json']);
// Reinstall through Codex so same-version local edits reach its managed cache.
if (listing.installed?.some(plugin => plugin.pluginId === pluginId)) run(['plugin', 'remove', pluginId, '--json']);
const installed = run(['plugin', 'add', pluginId, '--json']);
process.stdout.write(`Installed Kerf from ${sourceRoot}\n${JSON.stringify(installed, null, 2)}\n`);
