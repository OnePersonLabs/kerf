import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertKey, hash, matches, safePath, writablePath } from './io.mjs';

export async function loadLens(root, name) {
  assertKey(name);
  const relative = `.kerf/lenses/${name}.mjs`;
  const file = await writablePath(root, relative);
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const version = hash(text);
  const url = pathToFileURL(file);
  url.searchParams.set('version', version);
  const module = await import(url.href);
  const definition = module.default;
  if (!definition || typeof definition !== 'object') throw new Error(`Lens ${name} must export a default object.`);
  if (definition.select !== undefined && (!definition.select || typeof definition.select !== 'object')) throw new Error(`Lens ${name}: select must be an object.`);
  for (const list of [definition.owns ?? [], definition.select?.paths ?? [], definition.select?.importsOf ?? []]) {
    if (!Array.isArray(list) || list.some(value => typeof value !== 'string')) throw new Error(`Lens ${name}: owns, select.paths and select.importsOf must be arrays of paths.`);
  }
  for (const output of definition.owns ?? []) {
    safePath(root, output);
    if (output.startsWith('.kerf/') || output.startsWith('.git/') || output === '.git' || /[*?{}[\]]/.test(output)) throw new Error(`Lens ${name} must own exact implementation paths outside .kerf and .git: ${output}`);
  }
  for (const method of ['render', 'check']) if (definition[method] !== undefined && typeof definition[method] !== 'function') throw new Error(`Lens ${name}: ${method} must be a function.`);
  return { name, path: relative, hash: version, definition };
}

export async function runCommand(root, input) {
  if (!input || typeof input.command !== 'string' || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string')) {
    throw new Error('A check command needs { command, args: string[], cwd? }. Commands run without a shell.');
  }
  const cwd = input.cwd ? await writablePath(root, input.cwd) : root;
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, limitError;
    const timeout = setTimeout(() => { limitError = new Error(`Check command exceeded 30 seconds: ${input.command}`); child.kill(); }, 30_000);
    const collect = (field, chunk) => {
      size += chunk.length;
      if (size > 256_000) { limitError = new Error(`Check command exceeded 256 KB of output: ${input.command}`); child.kill(); return; }
      if (field === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timeout); if (limitError) reject(limitError); else resolve({ code, signal, stdout, stderr }); });
  });
}

export async function lensContext(index, lens, slice, recordQuery, recordValue) {
  const selected = new Set();
  for (const file of await recordQuery({ kind: 'files', patterns: lens.definition.select?.paths ?? [] })) selected.add(file);
  for (const target of lens.definition.select?.importsOf ?? []) {
    for (const file of await recordQuery({ kind: 'consumers', path: target })) selected.add(file);
  }
  for (const output of lens.definition.owns ?? []) selected.add(output);
  // The slice also carries source bindings declared by the selected meaning.
  for (const file of slice.files) selected.add(typeof file === 'string' ? file : file.path);
  const files = [], sources = Object.create(null);
  const read = async relative => {
    const allowed = selected.has(relative) || (lens.definition.select?.paths ?? []).some(pattern => matches(relative, pattern));
    if (!allowed) throw new Error(`Lens ${lens.name} requested undeclared input ${relative}. Add it to select.paths.`);
    const absolute = await writablePath(index.root, relative);
    try {
      const text = await readFile(absolute, 'utf8');
      recordValue({ kind: 'file', path: relative, hash: hash(text) });
      sources[relative] = text;
      return text;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      recordValue({ kind: 'file', path: relative, hash: null });
      return null;
    }
  };
  for (const relative of selected) {
    const fact = await index.file(relative);
    if (fact) files.push(fact);
    await read(relative);
  }
  return {
    concepts: slice.concepts,
    files,
    sources,
    read,
    query: recordQuery,
    run: input => runCommand(index.root, input),
  };
}

export function normalizeChecks(name, result) {
  if (!Array.isArray(result)) throw new Error(`Lens ${name} check must return an array of { status, message } results.`);
  if (!result.length) return [{ lens: name, status: 'unknown', message: 'The lens returned no observations.' }];
  return result.map(item => {
    if (!item || !['pass', 'fail', 'unknown'].includes(item.status) || typeof item.message !== 'string') throw new Error(`Lens ${name} returned an invalid check result.`);
    return { ...item, lens: name };
  });
}
