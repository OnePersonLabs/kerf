import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { stringify } from 'yaml';
import { atomicWrite, writablePath } from './io.mjs';

const execute = promisify(execFile);
export async function repositoryRoot(directory = process.cwd()) {
  try {
    const { stdout } = await execute('git', ['rev-parse', '--show-toplevel'], { cwd: path.resolve(directory), windowsHide: true });
    return path.resolve(stdout.trim());
  } catch (error) {
    throw new Error(`Kerf needs a local Git repository at ${directory}. Initialize Git first.`, { cause: error });
  }
}

export async function initialize(root, purpose) {
  const projectPath = await writablePath(root, '.kerf/project.md');
  let created = false;
  try { await readFile(projectPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const title = path.basename(root);
    await atomicWrite(projectPath, `---\n${stringify({ title, concepts: [] })}---\n\n# ${title}\n\n${purpose?.trim() || 'Kerf is active. No conceptual purpose has been recorded yet.'}\n`);
    created = true;
  }
  for (const directory of ['concepts', 'lenses', 'work']) await mkdir(await writablePath(root, `.kerf/${directory}`), { recursive: true });
  const ignorePath = await writablePath(root, '.gitignore');
  let ignore = '';
  try { ignore = await readFile(ignorePath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = ignore.split(/\r?\n/);
  const additions = ['/.kerf/index/', '/.kerf/work/'].filter(line => !lines.includes(line) && !lines.includes(line.slice(1)));
  if (additions.length) await atomicWrite(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`);
  return { root, created, project: '.kerf/project.md', message: created ? 'Kerf is active. Describe the concepts that matter, then focus a change.' : 'Kerf was already active; existing meaning was preserved.' };
}
