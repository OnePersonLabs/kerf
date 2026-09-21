import { readFile } from 'node:fs/promises';
import { syncIndex } from './index.mjs';
import { assertKey, slug, words, hash, writeJson, readJson, atomicWrite, writablePath } from './io.mjs';
import { loadLens } from './lenses.mjs';

export const queryKey = spec => JSON.stringify(spec);

export function tracking(index) {
  const queries = new Map(), values = new Map();
  return {
    queries, values,
    value(value) { values.set(value.path, value); },
    async query(spec) {
      const key = queryKey(spec);
      if (!queries.has(key)) queries.set(key, await index.query(spec));
      return queries.get(key).value;
    },
  };
}

export async function focus(root, request, options = {}, suppliedIndex) {
  if (!request?.trim()) throw new Error('Focus needs a description of the intended change.');
  const index = suppliedIndex ?? await syncIndex(root);
  const track = tracking(index);
  const project = await index.project();
  const budget = options.budget ?? 24_000;
  if (!Number.isSafeInteger(budget) || budget < 1000) throw new Error('The focus budget must be at least 1000 characters.');
  if (project.text.length > budget) throw new Error('project.md exceeds the focus budget. Move detailed meaning into named concepts or increase --budget.');
  track.value({ kind: 'project', path: project.path, hash: project.hash });
  const name = assertKey(options.name ?? slug(request));
  const concepts = [], files = new Map(), lenses = new Map(), reasons = new Map();
  const queue = [], visited = new Set(), impacts = new Set(), propagated = new Set(), pendingFiles = [], visitedFiles = new Set(), unknowns = new Set();
  let used = project.text.length;
  const enqueue = (key, reason, direct = false) => {
    assertKey(key);
    const upgrade = direct && !impacts.has(key);
    if (direct) impacts.add(key);
    if (!reasons.has(key)) { reasons.set(key, reason); queue.push({ key, direct }); }
    else if (upgrade) queue.push({ key, direct });
  };
  const addFile = (relative, reason) => {
    if (files.has(relative)) return;
    if (files.size >= 128) { unknowns.add(`${relative} (${reason}) exceeds the 128-file boundary; resolve this consequence with a narrower focus.`); return; }
    files.set(relative, { path: relative, reason }); pendingFiles.push(relative);
  };
  const explicitConcepts = options.concepts ?? [];
  const explicitPaths = options.paths ?? [];
  for (const key of explicitConcepts) enqueue(key, 'Explicitly selected meaning', true);
  for (const relative of explicitPaths) {
    await writablePath(root, relative);
    addFile(relative, 'Explicit implementation hint');
    for (const key of await track.query({ kind: 'bound', path: relative })) enqueue(key, `Meaning bound to ${relative}`, true);
  }
  if (!explicitConcepts.length && !explicitPaths.length) {
    const candidates = await track.query({ kind: 'terms', terms: words(request) });
    for (const key of candidates.slice(0, 6)) enqueue(key, 'Candidate from request terms; inspect applicability', true);
    if (candidates.length > 6) unknowns.add(`The request has ${candidates.length} candidate concepts. Use --concept to resolve its intended boundary.`);
  }
  if (!queue.length) {
    for (const key of project.metadata?.concepts ?? []) enqueue(key, 'Project entry point; confirm applicability', true);
    unknowns.add('The request has no directly matched concept. Interpret it against the project purpose and author missing meaning if needed.');
  }
  while (queue.length || pendingFiles.length) {
    while (queue.length) {
      const { key, direct } = queue.shift();
      if (visited.has(key) && (!direct || propagated.has(key))) continue;
      const existing = concepts.find(concept => concept.key === key);
      visited.add(key);
      if (!existing && concepts.length >= 32) { unknowns.add(`Concept ${key} (${reasons.get(key)}) lies beyond the 32-concept boundary; focus it separately if consequential.`); continue; }
      const concept = existing ?? await index.concept(key);
      if (!concept) {
        track.value({ kind: 'concept', path: `.kerf/concepts/${key}.md`, key, hash: null });
        unknowns.add(`Concept ${key} is referenced but has no authored record.`); continue;
      }
      if (!existing && used + concept.text.length > budget) { unknowns.add(`Concept ${key} (${reasons.get(key)}) does not fit the remaining focus budget. Focus it explicitly or increase --budget.`); continue; }
      if (!existing) {
        used += concept.text.length;
        concepts.push({ ...concept, reason: reasons.get(key) });
      }
      track.value({ kind: 'concept', path: concept.path, key, hash: concept.hash });
      for (const dependency of concept.requires) enqueue(dependency, `${key} requires this meaning`);
      for (const governor of await track.query({ kind: 'governors', concept: key })) enqueue(governor, `Constrains ${key}`);
      if (direct) {
        propagated.add(key);
        for (const dependent of await track.query({ kind: 'dependents', concept: key })) enqueue(dependent, `Relies on ${key}; inspect consequences`, true);
        for (const target of concept.governs) enqueue(target, `${key} constrains this concept`, true);
      }
      for (const relative of await track.query({ kind: 'files', patterns: concept.files })) addFile(relative, `Realizes ${key}`);
      for (const relative of concept.files.filter(pattern => !/[*?{}[\]]/.test(pattern))) addFile(relative, `Declared realization of ${key}`);
      for (const lensName of concept.lenses) {
        if (lenses.has(lensName)) continue;
        const lens = await loadLens(root, lensName);
        if (!lens) { unknowns.add(`Lens ${lensName} is declared but missing.`); track.value({ kind: 'lens', path: `.kerf/lenses/${lensName}.mjs`, hash: null }); continue; }
        lenses.set(lensName, lens);
        track.value({ kind: 'lens', path: lens.path, hash: lens.hash });
        for (const relative of await track.query({ kind: 'files', patterns: lens.definition.select?.paths ?? [] })) addFile(relative, `Input to lens ${lensName}`);
        for (const target of lens.definition.select?.importsOf ?? []) {
          for (const relative of await track.query({ kind: 'consumers', path: target })) addFile(relative, `Consumer selected by lens ${lensName}`);
        }
        for (const relative of lens.definition.owns ?? []) addFile(relative, `Owned output of lens ${lensName}`);
      }
    }
    while (pendingFiles.length) {
      const relative = pendingFiles.shift();
      if (visitedFiles.has(relative)) continue;
      visitedFiles.add(relative);
      let file = await index.file(relative);
      if (!file) {
        try {
          const content = await readFile(await writablePath(root, relative));
          file = { path: relative, hash: hash(content), imports: [], exports: [], unknowns: ['This declared file is outside Git observation; its structural dependencies need an explicit lens or binding.'] };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      track.value({ kind: 'file', path: relative, hash: file?.hash ?? null });
      Object.assign(files.get(relative), file ?? { hash: null, imports: [], exports: [], unknowns: [] });
      for (const unknown of file?.unknowns ?? []) unknowns.add(`${relative}: ${unknown}`);
      for (const key of await track.query({ kind: 'bound', path: relative })) enqueue(key, `Meaning bound to implicated file ${relative}`);
      for (const consumer of await track.query({ kind: 'consumers', path: relative })) addFile(consumer, `Consumes ${relative}`);
    }
  }
  const result = {
    format: 1, name, request, options: { concepts: explicitConcepts, paths: explicitPaths, budget },
    project: { path: project.path, text: project.text },
    concepts, files: [...files.values()],
    lenses: [...lenses.values()].map(lens => ({ name: lens.name, path: lens.path, hash: lens.hash, owns: lens.definition.owns ?? [] })),
    values: [...track.values.values()], queries: [...track.queries.values()],
    unknowns: [...unknowns], budget: { characters: used, limit: budget }, stats: { ...index.stats },
  };
  if (options.persist !== false) {
    await saveWork(root, result);
  }
  return result;
}

export async function saveWork(root, result) {
  const record = { ...result, project: { path: result.project.path }, concepts: result.concepts.map(({ text, metadata, ...concept }) => concept) };
  await writeJson(await writablePath(root, `.kerf/work/${result.name}.json`), record);
  await atomicWrite(await writablePath(root, `.kerf/work/${result.name}.md`), brief(result));
}

export function brief(slice) {
  const lines = [`# ${slice.name}`, '', slice.request, '', '## Project purpose', '', slice.project.text, '', '## Relevant meaning', ''];
  for (const concept of slice.concepts) lines.push(`### ${concept.title}`, '', `Source: [${concept.path}](../../${concept.path})`, '', `Why here: ${concept.reason}.`, '', concept.text, '');
  if (!slice.concepts.length) lines.push('No matching conceptual records are available yet.', '');
  lines.push('## Implicated implementation', '');
  for (const file of slice.files) lines.push(`- ${file.path}${file.hash === null ? ' (not implemented)' : ''}: ${file.reason}`);
  if (!slice.files.length) lines.push('No implementation bindings yet. Meaning can be developed independently of code.');
  lines.push('', '## Questions and limits', '');
  lines.push(...(slice.unknowns.length ? slice.unknowns.map(item => `- ${item}`) : ['No unresolved gaps were reported by the selected index queries. Semantic judgment still belongs to the host.']));
  lines.push('', '## Continue', '', `Update meaning and implementation under the current request. Refresh this focus when its meaning or boundary changes. Run the Kerf CLI with check ${slice.name} to inspect affected consequences.`, '', 'This brief is derived. Edit the linked conceptual records to change the project meaning.', '');
  return lines.join('\n');
}

export async function readWork(root, name) {
  assertKey(name);
  const record = await readJson(await writablePath(root, `.kerf/work/${name}.json`), null);
  if (!record) throw new Error(`No saved work named ${name}. Run focus with --name ${name}.`);
  if (record.format !== 1 || !Array.isArray(record.values) || !Array.isArray(record.queries)) throw new Error(`Saved work ${name} has an unsupported format; recreate its focus.`);
  return record;
}

export async function compareWork(index, work) {
  const meaningChanges = [], sourceChanges = [], queryChanges = [];
  for (const value of work.values) {
    let currentHash = null;
    if (value.kind === 'file') {
      currentHash = (await index.file(value.path))?.hash ?? null;
      if (currentHash === null) {
        try { currentHash = hash(await readFile(await writablePath(index.root, value.path))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    else if (value.kind === 'concept') currentHash = (await index.concept(value.key))?.hash ?? null;
    else {
      try { currentHash = hash(await readFile(await writablePath(index.root, value.path), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (currentHash !== value.hash) (value.kind === 'file' ? sourceChanges : meaningChanges).push({ path: value.path, before: value.hash, after: currentHash });
  }
  const expectedPaths = new Set(work.files.map(file => file.path));
  for (const query of work.queries) {
    const current = await index.query(query.spec);
    if (current.hash === query.hash) continue;
    const added = current.value.filter(value => !query.value.includes(value));
    const removed = query.value.filter(value => !current.value.includes(value));
    const expected = query.spec.kind === 'files' && [...added, ...removed].every(value => expectedPaths.has(value));
    queryChanges.push({ spec: query.spec, added, removed, expected });
  }
  return { meaningChanges, sourceChanges, queryChanges };
}
