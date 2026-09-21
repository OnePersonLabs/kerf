import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { assertKey, atomicWrite, hash, matches, readJson, safePath, words, writablePath, writeJson } from './io.mjs';
import { isSourcePath, observeSource } from './observe.mjs';

const execFile = promisify(execFileCallback);
const INDEX_VERSION = 1;
const INDEX_ROOT = '.kerf/index';
const PENDING = `${INDEX_ROOT}/.pending.json`;

function emptyManifest() {
  return { version: INDEX_VERSION, head: null, dirtyPaths: [], inputs: {}, concepts: {} };
}

function normalPath(value) {
  if (typeof value !== 'string') throw new Error('Expected a repository-relative path.');
  const result = value.replaceAll('\\', '/').replace(/^\.\//, '');
  safePath('.', result);
  return result;
}

function isConceptPath(file) {
  return file.startsWith('.kerf/concepts/') && file.endsWith('.md');
}

function isProjectPath(file) {
  return file === '.kerf/project.md';
}

function isInternalPath(file) {
  return file.startsWith('.kerf/') && !isConceptPath(file) && !isProjectPath(file);
}

function isObservedPath(file) {
  return !isInternalPath(file) && !isConceptPath(file) && !isProjectPath(file);
}

function stringList(value, field, { keys = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Expected ${field} to be an array of non-empty strings.`);
  }
  const result = [...new Set(value.map(item => item.trim()))].sort();
  if (keys) result.forEach(assertKey);
  return result;
}

function frontmatter(text, file) {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { metadata: {}, body: text };
  const metadata = YAML.parse(match[1]);
  if (metadata === null || metadata === undefined) return { metadata: {}, body: text.slice(match[0].length) };
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(`${file} frontmatter must be a YAML mapping.`);
  return { metadata, body: text.slice(match[0].length) };
}

function firstHeading(body) {
  return body.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() ?? null;
}

function parseConcept(file, text, fileHash) {
  const parsed = frontmatter(text, file);
  const key = assertKey(parsed.metadata.key);
  const title = typeof parsed.metadata.title === 'string' && parsed.metadata.title.trim()
    ? parsed.metadata.title.trim()
    : firstHeading(parsed.body) ?? key;
  return {
    key,
    title,
    path: file,
    hash: fileHash,
    aliases: stringList(parsed.metadata.aliases, `${file} aliases`),
    requires: stringList(parsed.metadata.requires, `${file} requires`, { keys: true }),
    governs: stringList(parsed.metadata.governs, `${file} governs`, { keys: true }),
    files: stringList(parsed.metadata.files, `${file} files`),
    lenses: stringList(parsed.metadata.lenses, `${file} lenses`),
    metadata: parsed.metadata,
  };
}

function parseProject(file, text, fileHash) {
  const parsed = frontmatter(text, file);
  return {
    path: file,
    hash: fileHash,
    metadata: {
      concepts: stringList(parsed.metadata.concepts, `${file} concepts`, { keys: true }),
      entrypoints: stringList(parsed.metadata.entrypoints, `${file} entrypoints`),
    },
  };
}

function termsForConcept(concept) {
  return [...new Set(words([concept.key, concept.title, ...concept.aliases].join(' ')))].sort();
}

function blankRelation(key) {
  return { key, requires: [], governs: [], dependents: [], governors: [] };
}

function sorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameList(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasGlob(value) {
  return /[*?{}[\]]/.test(value);
}

async function git(root, args, { optional = false } = {}) {
  try {
    const { stdout } = await execFile('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (optional) return null;
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Git ${args.join(' ')} failed: ${detail}`);
  }
}

function nulPaths(output) {
  return output.split('\0').filter(Boolean).map(normalPath);
}

function statusPaths(output) {
  const entries = output.split('\0');
  const paths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.add(normalPath(entry.slice(3)));
    if (status.includes('R') || status.includes('C')) {
      const oldPath = entries[index + 1];
      if (oldPath) paths.add(normalPath(oldPath));
      index += 1;
    }
  }
  return paths;
}

async function gitHead(root) {
  const result = await git(root, ['rev-parse', '--verify', 'HEAD'], { optional: true });
  return result?.trim() || null;
}

async function currentGitPaths(root) {
  return new Set(nulPaths(await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])));
}

async function changedGitPaths(root, previousHead, head, dirtyPaths) {
  const changed = new Set(dirtyPaths);
  if (previousHead !== head) {
    if (previousHead && head) {
      const revisionPaths = nulPaths(await git(root, ['diff', '--no-renames', '--name-only', '-z', previousHead, head]));
      revisionPaths.forEach(file => changed.add(file));
    } else {
      return { paths: null, dirtyPaths };
    }
  }
  return { paths: changed, dirtyPaths };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function existsFile(root, file) {
  try {
    const handle = await open(safePath(root, file), 'r');
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

async function inputStamp(root, file) {
  try {
    const details = await stat(safePath(root, file));
    return details.isFile() ? { size: details.size, modified: details.mtimeMs } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameStamp(left, right) {
  return Boolean(left && right && left.size === right.size && left.modified === right.modified);
}

function indexRelative(group, file = '') {
  return file ? `${INDEX_ROOT}/${group}/${file}.json` : `${INDEX_ROOT}/${group}.json`;
}

function queryName(spec) {
  const source = spec.kind === 'terms' ? spec.terms.join('-')
    : spec.kind === 'files' ? spec.patterns.join('-')
      : spec.kind === 'bound' || spec.kind === 'consumers' ? spec.path
        : spec.concept;
  const clean = String(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 96);
  return clean || 'empty';
}

function normalizeQuery(spec) {
  if (!spec || typeof spec !== 'object' || typeof spec.kind !== 'string') throw new Error('A query needs a kind.');
  if (spec.kind === 'terms') {
    const terms = sorted((Array.isArray(spec.terms) ? spec.terms : []).flatMap(words));
    return { kind: 'terms', terms };
  }
  if (spec.kind === 'files') {
    if (!Array.isArray(spec.patterns) || spec.patterns.some(pattern => typeof pattern !== 'string' || !pattern)) throw new Error('A files query needs string patterns.');
    return { kind: 'files', patterns: sorted(spec.patterns) };
  }
  if (spec.kind === 'bound' || spec.kind === 'consumers') return { kind: spec.kind, path: normalPath(spec.path) };
  if (spec.kind === 'governors' || spec.kind === 'dependents') return { kind: spec.kind, concept: assertKey(spec.concept) };
  throw new Error(`Unknown query kind ${JSON.stringify(spec.kind)}.`);
}

/**
 * Incrementally synchronize Kerf's disposable observations. The only broad
 * operation is first construction or explicit recovery. A warm sync starts
 * from Git's delta and reads only changed inputs before consulting shards.
 */
export async function syncIndex(root, { rebuild = false } = {}) {
  const repository = path.resolve(root);
  const stats = { conceptsParsed: 0, sourcesParsed: 0, inputFilesRead: 0, indexFilesRead: 0 };
  const changed = new Set();
  const indexFile = relative => safePath(repository, `${INDEX_ROOT}/${relative}`);
  const readIndex = async (relative, fallback) => {
    stats.indexFilesRead += 1;
    return readJson(indexFile(relative), fallback);
  };
  const writeIndex = async (relative, value) => writeJson(await writablePath(repository, `${INDEX_ROOT}/${relative}`), value);
  const removeIndex = async relative => rm(await writablePath(repository, `${INDEX_ROOT}/${relative}`), { force: true, recursive: false });
  const pendingPath = indexFile('.pending.json');
  const indexDirectory = await writablePath(repository, INDEX_ROOT);
  const writablePending = await writablePath(repository, PENDING);
  let pending;
  try {
    pending = await readJson(pendingPath, null);
  } catch (error) {
    if (error instanceof SyntaxError) pending = { malformed: true };
    else throw error;
  }

  if (pending && !rebuild) {
    throw new Error(`Kerf found an ${pending.malformed ? 'incomplete' : 'interrupted'} index update. Run \`kerf rebuild\` before using the index.`);
  }
  if (pending && !pending.malformed && processIsAlive(pending.pid)) {
    throw new Error('Another Kerf index update is active. Wait for it to finish before rebuilding.');
  }
  if (pending) await unlink(writablePending);

  let manifest = rebuild ? emptyManifest() : await readIndex('manifest.json', null);
  if (!manifest) manifest = emptyManifest();
  if (manifest.version !== INDEX_VERSION || !manifest.inputs || !manifest.concepts) {
    throw new Error('Kerf cannot read this index version. Run `kerf rebuild`.');
  }

  const head = await gitHead(repository);
  const dirtyPaths = statusPaths(await git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const deltaState = rebuild || !manifest.head && !Object.keys(manifest.inputs).length
    ? { paths: null, dirtyPaths }
    : await changedGitPaths(repository, manifest.head, head, dirtyPaths);
  let delta = deltaState.paths;
  let currentPaths;
  if (rebuild || delta === null || !Object.keys(manifest.inputs).length) {
    currentPaths = await currentGitPaths(repository);
    delta = new Set(currentPaths);
    Object.keys(manifest.inputs).forEach(file => delta.add(file));
  } else {
    currentPaths = new Set(Object.keys(manifest.inputs));
  }
  for (const file of [...delta, ...(manifest.dirtyPaths ?? [])]) {
      if (await existsFile(repository, file)) currentPaths.add(file);
      else currentPaths.delete(file);
  }

  [...(manifest.dirtyPaths ?? [])].forEach(file => delta.add(file));

  const observedPaths = new Set([...currentPaths].filter(isObservedPath));
  // A target appearing or disappearing can change how an otherwise unchanged
  // importer resolves a relative specifier. Candidate shards make that a
  // bounded refresh instead of a repository-wide reparse.
  const resolutionRefresh = new Set();
  const resolutionTargets = new Set();
  for (const changedPath of delta) {
    if (!isObservedPath(changedPath)) continue;
    const currentStamp = await inputStamp(repository, changedPath);
    if (!sameStamp(manifest.inputs[changedPath]?.stamp, currentStamp)) resolutionTargets.add(changedPath);
  }
  for (const changedPath of resolutionTargets) {
    const candidates = await readIndex(`candidates/${changedPath}.json`, null);
    for (const importer of candidates?.sources ?? []) {
      if (currentPaths.has(importer)) resolutionRefresh.add(importer);
    }
  }
  resolutionRefresh.forEach(file => delta.add(file));
  const prepared = [];
  for (const file of [...delta].sort()) {
    const previous = manifest.inputs[file];
    const stamp = await inputStamp(repository, file);
    if (!stamp) {
      if (previous) prepared.push({ kind: 'delete', path: file, previous });
      continue;
    }
    if (isInternalPath(file)) continue;
    if (previous?.hash && sameStamp(previous.stamp, stamp) && !resolutionRefresh.has(file)) continue;
    const buffer = await readFile(safePath(repository, file));
    stats.inputFilesRead += 1;
    const fileHash = hash(buffer);
    if (previous?.hash === fileHash && !resolutionRefresh.has(file)) {
      previous.stamp = stamp;
      continue;
    }
    const text = (isConceptPath(file) || isProjectPath(file) || isSourcePath(file)) ? buffer.toString('utf8') : null;
    if (isConceptPath(file)) {
      const concept = parseConcept(file, text, fileHash);
      stats.conceptsParsed += 1;
      prepared.push({ kind: 'concept', path: file, previous, concept, stamp });
    } else if (isProjectPath(file)) {
      prepared.push({ kind: 'project', path: file, previous, project: parseProject(file, text, fileHash), stamp });
    } else {
      const observation = isSourcePath(file)
        ? observeSource(file, text, observedPaths)
        : { path: file, imports: [], exports: [], unknowns: [], candidates: [] };
      if (isSourcePath(file)) stats.sourcesParsed += 1;
      prepared.push({ kind: 'file', path: file, previous, record: { path: file, hash: fileHash, ...observation }, stamp });
    }
  }

  const deletionPaths = new Set(prepared.filter(entry => entry.kind === 'delete').map(entry => entry.path));
  const newKeys = new Map();
  for (const entry of prepared.filter(candidate => candidate.kind === 'concept')) {
    const other = newKeys.get(entry.concept.key);
    if (other && other !== entry.path) throw new Error(`Both ${other} and ${entry.path} declare concept ${entry.concept.key}.`);
    newKeys.set(entry.concept.key, entry.path);
    const existing = manifest.concepts[entry.concept.key];
    if (existing && existing.path !== entry.path && !deletionPaths.has(existing.path)) {
      throw new Error(`Concept ${entry.concept.key} is already declared by ${existing.path}.`);
    }
  }

  // Validate everything before marking the index pending. A user typo should
  // not turn a previously valid index into a recovery operation.
  await mkdir(indexDirectory, { recursive: true });
  let marker;
  try {
    marker = await open(writablePending, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another Kerf index update is already active. Wait for it or run `kerf rebuild` after an interruption.');
    throw error;
  }
  await marker.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), rebuild }, null, 2)}\n`, 'utf8');
  await marker.close();
  if (rebuild) {
    // `indexDirectory` passed writablePath before this recursive operation;
    // the lock is already held, so no other index operation can observe a
    // half-cleared derived tree as a valid index.
    const entries = await readdir(indexDirectory, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.name !== '.pending.json')
      .map(entry => rm(path.join(indexDirectory, entry.name), { recursive: true, force: true })));
  }

  const conceptRecord = key => readIndex(`concepts/${key}.json`, null);
  const relation = async key => {
    const value = await readIndex(`relations/${key}.json`, null);
    return value ? { ...blankRelation(key), ...value, key } : blankRelation(key);
  };
  const writeRelation = async value => writeIndex(`relations/${value.key}.json`, {
    ...value,
    requires: sorted(value.requires),
    governs: sorted(value.governs),
    dependents: sorted(value.dependents),
    governors: sorted(value.governors),
  });
  const updateTerm = async (term, key, present) => {
    const value = await readIndex(`terms/${term}.json`, { term, concepts: [] });
    const concepts = new Set(value.concepts);
    if (present) concepts.add(key); else concepts.delete(key);
    if (concepts.size) await writeIndex(`terms/${term}.json`, { term, concepts: sorted(concepts) });
    else await removeIndex(`terms/${term}.json`);
  };
  const updateBinding = async (file, key, present) => {
    const value = await readIndex(`bindings/${file}.json`, { path: file, concepts: [] });
    const concepts = new Set(value.concepts);
    if (present) concepts.add(key); else concepts.delete(key);
    if (concepts.size) await writeIndex(`bindings/${file}.json`, { path: file, concepts: sorted(concepts) });
    else await removeIndex(`bindings/${file}.json`);
  };
  const updateConsumer = async (target, source, present) => {
    const value = await readIndex(`consumers/${target}.json`, { path: target, consumers: [] });
    const consumers = new Set(value.consumers);
    if (present) consumers.add(source); else consumers.delete(source);
    if (consumers.size) await writeIndex(`consumers/${target}.json`, { path: target, consumers: sorted(consumers) });
    else await removeIndex(`consumers/${target}.json`);
  };
  const updateCandidate = async (target, source, present) => {
    const value = await readIndex(`candidates/${target}.json`, { path: target, sources: [] });
    const sources = new Set(value.sources);
    if (present) sources.add(source); else sources.delete(source);
    if (sources.size) await writeIndex(`candidates/${target}.json`, { path: target, sources: sorted(sources) });
    else await removeIndex(`candidates/${target}.json`);
  };
  const removeConceptBindings = async (key, patterns = []) => {
    const matchingObserved = [...observedPaths].filter(file => patterns.some(pattern => matches(file, pattern)));
    const declaredPaths = patterns.filter(pattern => !hasGlob(pattern));
    await Promise.all(sorted([...matchingObserved, ...declaredPaths]).map(file => updateBinding(file, key, false)));
  };
  const addConceptBindings = async concept => {
    await Promise.all([...observedPaths].sort().map(async file => {
      if (concept.files.some(pattern => matches(file, pattern))) await updateBinding(file, concept.key, true);
    }));
    // Exact authored bindings are meaningful before an implementation exists.
    // They are intentionally different from source observations, which only
    // appear after Git reports an actual repository file.
    await Promise.all(concept.files
      .filter(pattern => !hasGlob(pattern))
      .map(file => updateBinding(file, concept.key, true)));
  };
  const setRelations = async (key, before, after) => {
    const own = await relation(key);
    own.requires = after.requires;
    own.governs = after.governs;
    await writeRelation(own);
    for (const target of sorted([...before.requires, ...after.requires])) {
      const value = target === key ? own : await relation(target);
      const dependents = new Set(value.dependents);
      if (after.requires.includes(target)) dependents.add(key); else dependents.delete(key);
      value.dependents = [...dependents];
      await writeRelation(value);
    }
    for (const target of sorted([...before.governs, ...after.governs])) {
      const value = target === key ? own : await relation(target);
      const governors = new Set(value.governors);
      if (after.governs.includes(target)) governors.add(key); else governors.delete(key);
      value.governors = [...governors];
      await writeRelation(value);
    }
  };
  const removeConcept = async (key, fallback = null) => {
    const old = await conceptRecord(key) ?? fallback;
    if (!old) return;
    for (const term of termsForConcept(old)) await updateTerm(term, key, false);
    await removeConceptBindings(key, old.files);
    await setRelations(key, old, { requires: [], governs: [] });
    await removeIndex(`concepts/${key}.json`);
    delete manifest.concepts[key];
  };
  const applyFile = async entry => {
    const old = entry.previous ? await readIndex(`files/${entry.path}.json`, null) : null;
    if (old) {
      await Promise.all([...(old.imports ?? []), ...(old.exports ?? [])].map(target => updateConsumer(target, entry.path, false)));
      await Promise.all((old.candidates ?? []).map(target => updateCandidate(target, entry.path, false)));
    }
    await writeIndex(`files/${entry.path}.json`, entry.record);
    await Promise.all([...(entry.record.imports ?? []), ...(entry.record.exports ?? [])].map(target => updateConsumer(target, entry.path, true)));
    await Promise.all(entry.record.candidates.map(target => updateCandidate(target, entry.path, true)));
    manifest.inputs[entry.path] = { hash: entry.record.hash, kind: 'file', stamp: entry.stamp };
    changed.add(entry.path);
    if (!entry.previous) {
      for (const [key, value] of Object.entries(manifest.concepts)) {
        if (value.files.some(pattern => matches(entry.path, pattern))) await updateBinding(entry.path, key, true);
      }
    }
  };
  const deleteFile = async entry => {
    const old = await readIndex(`files/${entry.path}.json`, null);
    if (old) {
      await Promise.all([...(old.imports ?? []), ...(old.exports ?? [])].map(target => updateConsumer(target, entry.path, false)));
      await Promise.all((old.candidates ?? []).map(target => updateCandidate(target, entry.path, false)));
    }
    await removeIndex(`files/${entry.path}.json`);
    await removeIndex(`bindings/${entry.path}.json`);
    delete manifest.inputs[entry.path];
    changed.add(entry.path);
  };

  try {
    for (const entry of prepared.filter(entry => entry.kind === 'delete' && entry.previous.kind === 'concept')) {
      await removeConcept(entry.previous.key);
      delete manifest.inputs[entry.path];
      changed.add(entry.path);
    }
    for (const entry of prepared.filter(entry => entry.kind === 'delete' && entry.previous.kind === 'project')) {
      await removeIndex('project.json');
      delete manifest.inputs[entry.path];
      changed.add(entry.path);
    }
    for (const entry of prepared.filter(entry => entry.kind === 'delete' && entry.previous.kind === 'file')) await deleteFile(entry);
    for (const entry of prepared.filter(entry => entry.kind === 'file')) await applyFile(entry);
    for (const entry of prepared.filter(entry => entry.kind === 'concept')) {
      if (entry.previous?.key && entry.previous.key !== entry.concept.key) await removeConcept(entry.previous.key);
      const old = await conceptRecord(entry.concept.key);
      const bindingsChanged = !old || !sameList(old.files, entry.concept.files);
      if (old) {
        for (const term of termsForConcept(old)) await updateTerm(term, entry.concept.key, false);
        if (bindingsChanged) await removeConceptBindings(entry.concept.key, old.files);
      }
      for (const term of termsForConcept(entry.concept)) await updateTerm(term, entry.concept.key, true);
      await setRelations(entry.concept.key, old ?? { requires: [], governs: [] }, entry.concept);
      await writeIndex(`concepts/${entry.concept.key}.json`, entry.concept);
      manifest.inputs[entry.path] = { hash: entry.concept.hash, kind: 'concept', key: entry.concept.key, stamp: entry.stamp };
      manifest.concepts[entry.concept.key] = { path: entry.path, files: entry.concept.files };
      if (bindingsChanged) await addConceptBindings(entry.concept);
      changed.add(entry.path);
    }
    for (const entry of prepared.filter(entry => entry.kind === 'project')) {
      await writeIndex('project.json', entry.project);
      manifest.inputs[entry.path] = { hash: entry.project.hash, kind: 'project', stamp: entry.stamp };
      changed.add(entry.path);
    }
    if (!manifest.inputs['.kerf/project.md']) throw new Error('Kerf needs .kerf/project.md. Run `kerf init` in this repository.');
    manifest.head = head;
    // Retain only paths that can become an indexed input. Keeping the prior
    // dirty set is what detects a `git restore`: Git reports it as clean, but
    // the index may still hold the previous dirty hash.
    manifest.dirtyPaths = sorted([...dirtyPaths].filter(file => isObservedPath(file) || isConceptPath(file) || isProjectPath(file)));
    manifest.version = INDEX_VERSION;
    await atomicWrite(await writablePath(repository, `${INDEX_ROOT}/manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    await unlink(pendingPath);
  } catch (error) {
    // Leave the marker behind: enough shards may already have changed that an
    // explicit rebuild is safer than pretending this partial index is valid.
    throw error;
  }

  const project = async () => {
    const record = await readIndex('project.json', null);
    if (!record) throw new Error('Kerf project metadata is not indexed. Run `kerf rebuild`.');
    const text = await readFile(safePath(repository, record.path), 'utf8');
    return { path: record.path, hash: hash(text), text, metadata: record.metadata };
  };
  const concept = async key => {
    assertKey(key);
    const record = await readIndex(`concepts/${key}.json`, null);
    if (!record) return null;
    const text = await readFile(safePath(repository, record.path), 'utf8');
    return { ...record, text };
  };
  const file = async requested => {
    const relative = normalPath(requested);
    return readIndex(`files/${relative}.json`, null);
  };
  const query = async requested => {
    const spec = normalizeQuery(requested);
    let value;
    if (spec.kind === 'terms') {
      const counts = new Map();
      for (const term of spec.terms) {
        const shard = await readIndex(`terms/${term}.json`, null);
        for (const key of shard?.concepts ?? []) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      value = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([key]) => key);
    } else if (spec.kind === 'bound') {
      const observed = (await readIndex(`bindings/${spec.path}.json`, null))?.concepts ?? [];
      // Authored bindings exist before their realization. The manifest carries
      // only derived declaration metadata, so this does not load concept prose.
      const declared = Object.entries(manifest.concepts)
        .filter(([, concept]) => concept.files.some(pattern => matches(spec.path, pattern)))
        .map(([key]) => key);
      value = sorted([...observed, ...declared]);
    } else if (spec.kind === 'governors' || spec.kind === 'dependents') {
      const shard = await readIndex(`relations/${spec.concept}.json`, null);
      value = sorted(shard?.[spec.kind] ?? []);
    } else if (spec.kind === 'consumers') {
      value = sorted((await readIndex(`consumers/${spec.path}.json`, null))?.consumers ?? []);
    } else {
      value = spec.patterns.length === 0 ? [] : Object.keys(manifest.inputs)
        .filter(isObservedPath)
        .filter(filePath => spec.patterns.some(pattern => matches(filePath, pattern))).sort();
    }
    const fingerprint = hash({ spec, value: [...value].sort() });
    await writeIndex(`queries/${spec.kind}/${queryName(spec)}.json`, { spec, value, hash: fingerprint });
    return { spec, value, hash: fingerprint };
  };

  return { root: repository, stats, changes: [...changed].sort(), head, project, concept, file, query };
}
