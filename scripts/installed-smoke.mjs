import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const codex = process.platform === 'win32' ? 'codex.exe' : 'codex';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function installedPluginRoot() {
  const listing = JSON.parse(run(codex, ['plugin', 'list', '--json']));
  const plugin = listing.installed?.find(candidate => candidate.pluginId === 'kerf@kerf');
  if (!plugin?.installed || plugin.name !== 'kerf' || plugin.marketplaceName !== 'kerf' || typeof plugin.version !== 'string') {
    throw new Error('Kerf is not installed from its repository marketplace. Run npm run install:local first.');
  }
  const codexDirectory = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const installed = path.join(codexDirectory, 'plugins', 'cache', 'kerf', 'kerf', plugin.version);
  const manifest = JSON.parse(await readFile(path.join(installed, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== plugin.name || manifest.version !== plugin.version) {
    throw new Error(`Installed cache manifest does not match kerf@kerf ${plugin.version}.`);
  }
  return installed;
}

function runKerf(pluginRoot, args, cwd) {
  return run(process.execPath, [path.join(pluginRoot, 'src', 'cli.mjs'), ...args], { cwd });
}

async function requireFile(file) {
  await stat(file);
}

async function runHook(pluginRoot, cwd) {
  return run(process.execPath, [path.join(pluginRoot, 'hooks', 'kerf-session-start.mjs')], {
    cwd,
    input: JSON.stringify({ cwd })
  });
}

async function removeTemporary(file, temporaryParent) {
  const resolved = await realpath(file);
  if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('kerf-installed-smoke-')) {
    throw new Error(`Refusing to remove a smoke directory outside ${temporaryParent}.`);
  }
  await rm(resolved, { recursive: true, force: true });
}

const pluginRoot = await installedPluginRoot();
await requireFile(path.join(pluginRoot, 'src', 'cli.mjs'));
await requireFile(path.join(pluginRoot, 'hooks', 'kerf-session-start.mjs'));
await requireFile(path.join(pluginRoot, 'examples', 'music-events'));
await requireFile(path.join(pluginRoot, 'node_modules', 'typescript', 'package.json'));
await requireFile(path.join(pluginRoot, 'node_modules', 'yaml', 'package.json'));

const temporaryParent = await realpath(os.tmpdir());
const temporary = await mkdtemp(path.join(temporaryParent, 'kerf-installed-smoke-'));
try {
  const repository = path.join(temporary, 'music-events');
  await cp(path.join(pluginRoot, 'examples', 'music-events'), repository, { recursive: true });
  run('git', ['init'], { cwd: repository });
  run('git', ['add', '.'], { cwd: repository });
  run('git', ['-c', 'user.name=Kerf smoke', '-c', 'user.email=kerf-smoke@example.invalid', 'commit', '-m', 'seed'], { cwd: repository });

  runKerf(pluginRoot, [
    'focus', 'Keep player evidence distinct from generated preview playback.',
    '--root', repository, '--concept', 'player-evidence', '--name', 'repeat-preview', '--json'
  ], repository);
  runKerf(pluginRoot, ['render', 'repeat-preview', '--write', '--root', repository, '--json'], repository);
  const checked = JSON.parse(runKerf(pluginRoot, ['check', 'repeat-preview', '--root', repository, '--json'], repository));
  assert.equal(checked.status, 'pass', `Installed Kerf check did not pass:\n${JSON.stringify(checked, null, 2)}`);
  await requireFile(path.join(repository, '.kerf', 'work', 'repeat-preview.md'));
  await requireFile(path.join(repository, '.kerf', 'work', 'repeat-preview.json'));

  const active = JSON.parse(await runHook(pluginRoot, repository));
  assert.match(active.hookSpecificOutput.additionalContext, /Kerf is active/);

  const inactive = path.join(temporary, 'inactive');
  await mkdir(inactive);
  run('git', ['init'], { cwd: inactive });
  assert.equal(await runHook(pluginRoot, inactive), '');
  const initialized = JSON.parse(runKerf(pluginRoot, [
    'init', '--purpose', 'Keep a new project’s intent readable before it has implementation.', '--root', inactive, '--json'
  ], inactive));
  assert.equal(initialized.created, true);
  const activated = JSON.parse(await runHook(pluginRoot, inactive));
  assert.match(activated.hookSpecificOutput.additionalContext, /Kerf is active/);
  runKerf(pluginRoot, ['focus', 'Describe the first concept', '--name', 'empty-start', '--root', inactive, '--json'], inactive);
  const emptyCheck = JSON.parse(runKerf(pluginRoot, ['check', 'empty-start', '--root', inactive, '--json'], inactive));
  assert.equal(emptyCheck.status, 'review');

  const work = await readFile(path.join(repository, '.kerf', 'work', 'repeat-preview.md'), 'utf8');
  assert.match(work, /player evidence/i);
  process.stdout.write(`Installed Kerf smoke passed using ${pluginRoot}\n`);
} finally {
  await removeTemporary(temporary, temporaryParent);
}
