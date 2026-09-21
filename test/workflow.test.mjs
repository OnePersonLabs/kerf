import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { after, test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repositoryRoot, "src", "cli.mjs");
const exampleModel = join(repositoryRoot, "examples", "music-events", ".kerf");
const temporaryProjects = [];

after(async () => {
  await Promise.all(temporaryProjects.map((project) => rm(project, { recursive: true, force: true })));
});

const createMusicProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "kerf-music-events-"));
  temporaryProjects.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
  await cp(exampleModel, join(root, ".kerf"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "/.kerf/index/\n/.kerf/work/\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C", root,
    "-c", "user.name=Kerf test",
    "-c", "user.email=kerf@example.invalid",
    "commit", "--quiet", "-m", "Initial conceptual model",
  ]);
  return root;
};

const runCli = (root, args, { status = 0 } = {}) => {
  const command = spawnSync(process.execPath, [cli, ...args, "--root", root, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(
    command.status,
    status,
    `kerf ${args.join(" ")} failed:\n${command.stderr || command.stdout}`,
  );

  try {
    return JSON.parse(command.stdout);
  } catch (error) {
    throw new Error(`kerf did not return JSON:\n${command.stdout}`, { cause: error });
  }
};

const focusMusicEvidence = (root, name = "repeat-preview") => runCli(root, [
  "focus",
  "keep playback out of player evidence",
  "--name",
  name,
  "--concept",
  "player-evidence",
]);

const render = (root, name = "repeat-preview") => runCli(root, ["render", name, "--write"]);
const check = (root, name = "repeat-preview") => runCli(root, ["check", name]);
const failedCheck = (root, name = "repeat-preview") => runCli(root, ["check", name], { status: 1 });

test("renders a provenance rule from concepts and proves playback is not player evidence", async () => {
  const root = await createMusicProject();

  const focused = focusMusicEvidence(root);
  assert.deepEqual(focused.concepts.map((concept) => concept.key).sort(), [
    "event-origin",
    "player-evidence",
  ]);

  const rendered = render(root);
  assert.equal(rendered.written, true);
  assert.equal(rendered.outputs.some((output) => output.path === "src/evidence.mjs"), true);

  const evidence = await import(pathToFileURL(join(root, "src", "evidence.mjs")).href);
  const playback = { origin: "playback", kind: "note" };
  const playbackResult = evidence.classifyEvent(playback);

  assert.equal(playback.origin, "playback");
  assert.equal(playbackResult.origin, "playback");
  assert.equal(playbackResult.isSystemGenerated, true);
  assert.equal(playbackResult.isPlayerEvidence, false);
  assert.equal(evidence.classifyEvent({ origin: "player", kind: "note" }).isPlayerEvidence, true);

  const checked = check(root);
  assert.equal(checked.status, "pass");
  assert.equal(checked.checks.some((result) => result.status === "pass"), true);
});

test("a fresh process reopens changed meaning, then carries it forward into a related event kind", async () => {
  const root = await createMusicProject();
  focusMusicEvidence(root);
  render(root);

  const playerEvidencePath = join(root, ".kerf", "concepts", "player-evidence.md");
  const before = await readFile(playerEvidencePath, "utf8");
  await writeFile(playerEvidencePath, before.replace("  kinds:\n    - note", "  kinds:\n    - note\n    - rest"));

  const stale = failedCheck(root);
  assert.equal(stale.status, "fail");
  assert.equal(stale.meaningChanges.some((change) => change.path.endsWith("player-evidence.md")), true);

  const oldSource = await readFile(join(root, "src", "evidence.mjs"), "utf8");
  const preview = runCli(root, ["render", "repeat-preview"]);
  assert.equal(preview.written, false);
  assert.match(preview.outputs[0].content, /"rest"/);
  assert.equal(await readFile(join(root, "src", "evidence.mjs"), "utf8"), oldSource);

  const focused = focusMusicEvidence(root);
  assert.equal(focused.concepts.some((concept) => concept.key === "player-evidence"), true);
  render(root);

  const evidence = await import(`${pathToFileURL(join(root, "src", "evidence.mjs")).href}?rest-follow-on`);
  assert.equal(evidence.classifyEvent({ origin: "player", kind: "rest" }).isPlayerEvidence, true);
  assert.equal(check(root).status, "pass");
});

test("a newly discovered distant consumer reopens the work that queried consumers", async () => {
  const root = await createMusicProject();
  await writeFile(join(root, ".kerf", "concepts", "notation.md"), `---
key: notation
title: Notation stays outside event provenance
aliases: []
requires: []
governs: []
files: []
lenses:
  - notation-pass
---

# Notation

Notation has no dependency on player evidence or event provenance.
`);
  await writeFile(join(root, ".kerf", "lenses", "notation-pass.mjs"), `export default {
  description: "Checks the independent notation boundary.",
  select: { paths: [], importsOf: [] },
  owns: [],
  async check() {
    return [{ status: "pass", message: "Notation remains outside event provenance." }];
  },
};
`);

  runCli(root, ["focus", "keep notation separate", "--name", "notation-work", "--concept", "notation"]);
  assert.equal(check(root, "notation-work").status, "pass");
  focusMusicEvidence(root);
  render(root);
  assert.equal(check(root).status, "pass");

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "distant-consumer.mjs"),
    "import { classifyEvent } from './evidence.mjs';\nexport const isEvidence = classifyEvent;\n",
  );

  const checked = check(root);
  assert.equal(checked.status, "review");
  assert.equal(checked.queryChanges.length > 0, true);
  assert.equal(checked.unexpected.includes("src/distant-consumer.mjs"), true);

  const unrelated = check(root, "notation-work");
  assert.equal(unrelated.status, "pass");
  assert.deepEqual(unrelated.meaningChanges, []);
  assert.deepEqual(unrelated.sourceChanges, []);
  assert.deepEqual(unrelated.queryChanges, []);
});

test("unrelated concepts do not stale a selected work record", async () => {
  const root = await createMusicProject();
  focusMusicEvidence(root);
  render(root);
  assert.equal(check(root).status, "pass");

  await writeFile(join(root, ".kerf", "concepts", "unrelated-colour.md"), `---
key: unrelated-colour
title: Colour notation remains separate from event provenance
aliases: []
requires: []
governs: []
files: []
lenses: []
---

# Unrelated colour

Colour notation has no relationship to music-event provenance.
`);

  const checked = check(root);
  assert.equal(checked.status, "pass");
  assert.deepEqual(checked.meaningChanges, []);
});

test("index growth parses only new concepts, then warm explicit focus parses none", async () => {
  const root = await createMusicProject();
  await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    await writeFile(join(root, ".kerf", "concepts", `irrelevant-${index + 1}.md`), `---
key: irrelevant-${index + 1}
title: Irrelevant idea ${index + 1}
aliases: []
requires: []
governs: []
files: []
lenses: []
---

# Irrelevant idea ${index + 1}

This concept is deliberately disconnected from player evidence.
`);
  }));

  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C", root,
    "-c", "user.name=Kerf test",
    "-c", "user.email=kerf@example.invalid",
    "commit", "--quiet", "-m", "Add initial unrelated concepts",
  ]);
  runCli(root, ["rebuild"]);

  focusMusicEvidence(root, "growth-work");
  render(root, "growth-work");
  assert.equal(check(root, "growth-work").status, "pass");

  await Promise.all(Array.from({ length: 90 }, async (_, offset) => {
    const number = offset + 11;
    await writeFile(join(root, ".kerf", "concepts", `irrelevant-${number}.md`), `---
key: irrelevant-${number}
title: Irrelevant idea ${number}
aliases: []
requires: []
governs: []
files: []
lenses: []
---

# Irrelevant idea ${number}

This concept is deliberately disconnected from player evidence.
`);
  }));

  const afterGrowth = check(root, "growth-work");
  assert.equal(afterGrowth.status, "pass");
  assert.equal(afterGrowth.stats.conceptsParsed, 90);

  const focused = focusMusicEvidence(root, "warm-player-evidence");

  assert.equal(focused.stats.conceptsParsed, 0);
  assert.equal(focused.concepts.some((concept) => concept.key === "player-evidence"), true);
});

test("restoration and explicit index recovery preserve the authored model and work", async () => {
  const root = await createMusicProject();
  focusMusicEvidence(root);
  render(root);
  assert.equal(check(root).status, "pass");

  execFileSync("git", ["-C", root, "add", "src/evidence.mjs"]);
  execFileSync("git", [
    "-C", root,
    "-c", "user.name=Kerf test",
    "-c", "user.email=kerf@example.invalid",
    "commit", "--quiet", "-m", "Render provenance classifier",
  ]);

  const source = join(root, "src", "evidence.mjs");
  await writeFile(source, `export function classifyEvent() {
  return { origin: "player", isSystemGenerated: false, isPlayerEvidence: true };
}
`);
  assert.equal(failedCheck(root).status, "fail");

  execFileSync("git", ["-C", root, "restore", "--source=HEAD", "--", "src/evidence.mjs"]);
  const restored = check(root);
  assert.equal(restored.status, "pass");
  assert.deepEqual(restored.sourceChanges, [], "restoring Git content must also restore its indexed fingerprint");

  const authoredPaths = [
    ".kerf/concepts/event-origin.md",
    ".kerf/concepts/player-evidence.md",
    ".kerf/work/repeat-preview.md",
    ".kerf/work/repeat-preview.json",
  ];
  const beforeRecovery = await Promise.all(authoredPaths.map((relative) => readFile(join(root, relative), "utf8")));

  await writeFile(join(root, ".kerf", "index", ".pending.json"), JSON.stringify({
    pid: 99_999_999,
    startedAt: "2000-01-01T00:00:00.000Z",
    rebuild: false,
  }, null, 2));

  const blocked = spawnSync(process.execPath, [
    cli,
    "focus",
    "keep playback out of player evidence",
    "--name",
    "recovered-work",
    "--concept",
    "player-evidence",
    "--root",
    root,
    "--json",
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /rebuild/i);

  runCli(root, ["rebuild"]);
  const afterRecovery = await Promise.all(authoredPaths.map((relative) => readFile(join(root, relative), "utf8")));
  assert.deepEqual(afterRecovery, beforeRecovery);
});
