import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

export function slug(value) {
  const result = String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72).replace(/-$/, '');
  if (!result) throw new Error('Use a descriptive name containing letters or numbers.');
  return result;
}

export function assertKey(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 100) {
    throw new Error(`Invalid name ${JSON.stringify(value)}. Use a short descriptive lower-case name with hyphens.`);
  }
  return value;
}

const stopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with']);
export function words(value) {
  return [...new Set(String(value).normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter(word => word.length > 1 && word.length <= 64 && !stopWords.has(word));
}

export function safePath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || relativePath.includes('\\')
    || relativePath.includes(':') || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new Error(`Expected a repository-relative forward-slash path: ${JSON.stringify(relativePath)}`);
  }
  const target = path.resolve(root, relativePath);
  const rel = path.relative(path.resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Path leaves the repository: ${relativePath}`);
  return target;
}

// Kerf's own writes must not follow a link outside the selected repository.
export async function writablePath(root, relativePath) {
  const target = safePath(root, relativePath);
  const boundary = await realpath(root);
  let cursor = target;
  for (;;) {
    try {
      await lstat(cursor);
      const resolved = await realpath(cursor);
      const rel = path.relative(boundary, resolved);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Linked path leaves the repository: ${relativePath}`);
      return target;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cursor = path.dirname(cursor);
    }
  }
}

export async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.pending`;
  await writeFile(pending, text, 'utf8');
  await rename(pending, file);
}

export const writeJson = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && arguments.length > 1) return fallback;
    throw error;
  }
}

export const matches = (file, pattern) => path.posix.matchesGlob(file, pattern);
