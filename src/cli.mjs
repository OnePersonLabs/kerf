#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { repositoryRoot, initialize } from './project.mjs';
import { syncIndex } from './index.mjs';
import { focus, brief } from './focus.mjs';
import { render, check } from './work.mjs';

const help = `Kerf -- conceptual integrity, code as a byproduct

  init [--purpose "project purpose"]
  focus "intended change" [--name readable-name] [--concept name] [--path src/file]
  render work-name [--write]
  check work-name
  rebuild

All commands accept --root PATH and --json. Focus accepts repeatable --concept
and --path hints, and --budget CHARACTERS (default 24000). Render previews by
default. Check exits 1 for failures; a review result asks for judgment, not repair
by decree. Rebuild replaces only the disposable index.
`;

function textResult(command, result) {
  if (command === 'focus') return brief(result);
  if (command === 'render') {
    const lines = [result.message, ''];
    for (const output of result.outputs) {
      lines.push(`${output.changed ? 'Changed' : 'Unchanged'}: ${output.path}`);
      if (output.changed && !result.written) lines.push('', output.content);
    }
    for (const unknown of result.unknowns) lines.push(`Unknown: ${unknown}`);
    for (const change of result.comparison.meaningChanges) lines.push(`Meaning changed: ${change.path}`);
    for (const change of result.comparison.sourceChanges) lines.push(`Implementation changed: ${change.path}`);
    for (const change of result.comparison.queryChanges.filter(item => !item.expected)) lines.push(`Discovery changed: ${JSON.stringify(change.spec)}`);
    return lines.join('\n');
  }
  if (command === 'check') {
    const lines = [`${result.status.toUpperCase()}: ${result.name}`, '', result.message];
    for (const item of result.checks) lines.push(`- ${item.status}: ${item.message}`);
    for (const item of result.meaningChanges) lines.push(`- Meaning changed: ${item.path}`);
    for (const item of result.sourceChanges) lines.push(`- Implementation changed: ${item.path}`);
    for (const item of result.queryChanges) lines.push(`- ${item.expected ? 'Expected' : 'Review'} ${item.spec.kind} membership: +${item.added.join(', ') || 'none'} / -${item.removed.join(', ') || 'none'}`);
    for (const item of result.unexpected) lines.push(`- Newly implicated: ${item}`);
    for (const item of result.unknowns) lines.push(`- Unknown: ${item}`);
    return lines.join('\n');
  }
  return result.message;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      root: { type: 'string' }, purpose: { type: 'string' }, name: { type: 'string' },
      concept: { type: 'string', multiple: true }, path: { type: 'string', multiple: true },
      budget: { type: 'string' }, json: { type: 'boolean' }, write: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, argument, ...extra] = positionals;
  if (values.help || !command) process.stdout.write(help);
  else {
    if (!['init', 'focus', 'render', 'check', 'rebuild'].includes(command)) throw new Error(`Unknown operation ${command}. Run --help.`);
    if (extra.length || (['init', 'rebuild'].includes(command) && argument !== undefined)) throw new Error('Unexpected extra arguments. Quote the complete change request.');
    const root = await repositoryRoot(values.root);
    let result;
    switch (command) {
      case 'init': result = await initialize(root, values.purpose); break;
      case 'focus': result = await focus(root, argument, { name: values.name, concepts: values.concept, paths: values.path, budget: values.budget === undefined ? undefined : Number(values.budget) }); break;
      case 'render': result = await render(root, argument, { write: values.write }); break;
      case 'check': result = await check(root, argument); break;
      case 'rebuild': {
        const index = await syncIndex(root, { rebuild: true });
        result = { message: 'The disposable index was rebuilt. Authored meaning and saved work were preserved.', stats: index.stats };
        break;
      }
    }
    process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${textResult(command, result)}\n`);
    if (result.status === 'fail') process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`Kerf: ${error.message}\n`);
  process.exitCode = 1;
}
