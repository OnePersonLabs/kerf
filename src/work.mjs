import { readFile } from 'node:fs/promises';
import { syncIndex } from './index.mjs';
import { focus, readWork, compareWork, tracking, saveWork, queryKey } from './focus.mjs';
import { loadLens, lensContext, normalizeChecks } from './lenses.mjs';
import { atomicWrite, hash, writablePath, writeJson } from './io.mjs';

async function currentText(root, relative) {
  try { return await readFile(await writablePath(root, relative), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function prepare(root, name) {
  const work = await readWork(root, name);
  const index = await syncIndex(root);
  const comparison = await compareWork(index, work);
  const slice = await focus(root, work.request, { ...work.options, name, persist: false }, index);
  const track = tracking(index);
  for (const query of slice.queries) track.queries.set(queryKey(query.spec), query);
  for (const value of slice.values) track.value(value);
  return { work, index, comparison, slice, track };
}

export async function render(root, name, { write = false } = {}) {
  const { work, index, comparison, slice, track } = await prepare(root, name);
  const owned = new Set(work.lenses.flatMap(lens => lens.owns));
  const staleSources = comparison.sourceChanges.filter(change => !owned.has(change.path));
  const stale = comparison.meaningChanges.length || staleSources.length || comparison.queryChanges.some(change => !change.expected);
  if (write && stale) {
    throw new Error(`Saved work ${name} has changed meaning, inputs, or consumers. Refresh its focus before rendering. The old brief has been preserved.`);
  }
  const outputs = new Map();
  for (const reference of slice.lenses) {
    const lens = await loadLens(root, reference.name);
    if (!lens?.definition.render) continue;
    const context = await lensContext(index, lens, slice, track.query, track.value);
    const rendered = await lens.definition.render(context);
    if (!Array.isArray(rendered)) throw new Error(`Lens ${lens.name} render must return an array of { path, content } outputs.`);
    for (const output of rendered) {
      if (!output || typeof output.path !== 'string' || typeof output.content !== 'string') throw new Error(`Lens ${lens.name} returned an invalid output.`);
      if (!lens.definition.owns.includes(output.path)) throw new Error(`Lens ${lens.name} does not own ${output.path}. Declare the output explicitly.`);
      if (outputs.has(output.path)) throw new Error(`Several lenses produced ${output.path}. Resolve ownership before rendering.`);
      const before = await currentText(root, output.path);
      const baseline = work.values.find(value => value.path === output.path)?.hash ?? null;
      if (write && before !== output.content && (before === null ? null : hash(before)) !== baseline) throw new Error(`Output ${output.path} changed since this focus. Refresh before replacing it.`);
      outputs.set(output.path, { path: output.path, lens: lens.name, changed: before !== output.content, before, content: output.content });
    }
  }
  // Lens reads are tracked just like the selector queries used to build its brief.
  for (const dependency of track.values.values()) {
    if (outputs.has(dependency.path)) continue;
    const actual = await currentText(root, dependency.path);
    if ((actual === null ? null : hash(actual)) !== dependency.hash) throw new Error(`Input changed during rendering: ${dependency.path}. Refresh the focus.`);
  }
  if (write) {
    for (const output of outputs.values()) {
      if (!output.changed) continue;
      const actual = await currentText(root, output.path);
      if (actual !== output.before) throw new Error(`Output changed during rendering: ${output.path}. Previous writes, if any, remain visible in Git.`);
      await atomicWrite(await writablePath(root, output.path), output.content);
    }
  }
  // Keep discoveries made inside a renderer, including empty results, without
  // silently accepting changes to the baseline it started from.
  const values = new Map(work.values.map(value => [value.path, value]));
  const queries = new Map(work.queries.map(query => [queryKey(query.spec), query]));
  for (const [key, value] of track.values) if (!values.has(key)) values.set(key, value);
  for (const [key, query] of track.queries) if (!queries.has(key)) queries.set(key, query);
  if (!stale) await writeJson(await writablePath(root, `.kerf/work/${name}.json`), { ...work, values: [...values.values()], queries: [...queries.values()] });
  return { name, written: write, outputs: [...outputs.values()], comparison, unknowns: slice.unknowns, message: outputs.size ? (write ? 'Declared projections written. Run check to inspect the resulting behavior.' : stale ? 'Preview uses current meaning. Saved assumptions changed; refresh focus before writing.' : 'Preview only. Add --write to update these owned outputs.') : 'No selected lens has a deterministic renderer. Use the conceptual brief to implement with normal tools.', stats: { ...index.stats } };
}

export async function check(root, name) {
  const { work, index, comparison, slice, track } = await prepare(root, name);
  const checks = [], unknowns = [...slice.unknowns];
  for (const reference of slice.lenses) {
    const lens = await loadLens(root, reference.name);
    if (!lens?.definition.check) continue;
    const context = await lensContext(index, lens, slice, track.query, track.value);
    checks.push(...normalizeChecks(lens.name, await lens.definition.check(context)));
  }
  for (const dependency of track.values.values()) {
    const actual = await currentText(root, dependency.path);
    if ((actual === null ? null : hash(actual)) !== dependency.hash) unknowns.push(`Input changed while checks ran: ${dependency.path}. Run check again against the current inputs.`);
  }
  if (!checks.length) unknowns.push('No executable behavioral checks are attached to this focus. Assess the conceptual change with the host.');
  const beforeFiles = new Set(work.files.map(file => file.path));
  const unexpected = slice.files.map(file => file.path).filter(file => !beforeFiles.has(file));
  const importantQueries = comparison.queryChanges.filter(change => !change.expected);
  const status = checks.some(item => item.status === 'fail') ? 'fail'
    : comparison.meaningChanges.length || importantQueries.length || unexpected.length || unknowns.length || checks.some(item => item.status === 'unknown') ? 'review' : 'pass';
  if (status === 'pass') {
    // A passing local check advances this work's observed baseline. A review never erases unresolved evidence.
    slice.queries = [...track.queries.values()];
    slice.values = [...track.values.values()];
    await saveWork(root, slice);
  }
  return {
    name, status, ...comparison, unexpected, checks, unknowns,
    message: status === 'pass' ? 'Selected checks passed and the scoped baseline was refreshed. This does not establish unmodeled behavior.'
      : status === 'fail' ? 'An applicable check failed. The previous baseline is preserved.'
        : 'Review the changed meaning, consequences, or evidence gaps. Refresh focus when its boundary is understood.',
    stats: { ...index.stats },
  };
}
