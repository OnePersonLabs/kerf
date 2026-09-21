import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function projectRoot(start) {
  let current = path.resolve(start);
  for (;;) {
    if (await exists(path.join(current, '.kerf', 'project.md'))) return current;
    try {
      await lstat(path.join(current, '.git'));
      return null;
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

let payload = {};
try {
  const input = await new Response(process.stdin).text();
  payload = input.trim() ? JSON.parse(input) : {};
} catch {
  process.exit(0);
}

const root = await projectRoot(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
if (root) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Kerf is active here. For a substantial change, use $kerf and start from the relevant conceptual meaning before choosing code.'
    }
  }));
}
