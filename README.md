# Kerf

Kerf keeps a project’s purpose, behavior, relationships, and reasons in readable Markdown. It selects a bounded body of context using authored relationships and observed consumers. Code is a realization of the model, not its authority.

The model lives in the project beside the work:

```text
.kerf/
  project.md
  concepts/
    player-evidence.md
  lenses/
    event-provenance.mjs
  work/
    repeat-preview.md
    repeat-preview.json
  index/
    concepts/
    terms/
    files/
    queries/
```

`project.md` is the entry point. Each concept file uses small YAML frontmatter for its stable key, aliases, conceptual relationships, bound files, and lenses. The Markdown body explains the behavior, reasons, examples, and open questions. Kerf’s generated JSON index is disposable and is partitioned by those readable names.

## Use

The plugin does not install a global npm command. Resolve the installed Kerf plugin root, then invoke its local CLI. From the `$kerf` skill, that root is two directories above `skills/kerf/SKILL.md`.

```powershell
$kerfRoot = "<installed Kerf plugin directory>"
node "$kerfRoot/src/cli.mjs" init --purpose "Help people learn music without confusing playback for player evidence"
node "$kerfRoot/src/cli.mjs" focus "Repeat preview playback without treating it as a played note" --name repeat-preview
node "$kerfRoot/src/cli.mjs" render repeat-preview
node "$kerfRoot/src/cli.mjs" render repeat-preview --write
node "$kerfRoot/src/cli.mjs" check repeat-preview
```

`focus` writes a concise Markdown work brief and a JSON record of selected concepts, observed files, and discovery queries. `render` previews lens output; `--write` is limited to paths a lens explicitly owns. `check` reports `pass`, `fail`, or `review` after refreshing affected observations. `review` is a visible question or boundary change, not a hidden failure. `rebuild` explicitly reconstructs the disposable index.

Use `--concept <key>` or `--path <file>` as repeatable focus hints, `--name` to resume a readable work name, and `--budget` to change the default 24,000-character meaning budget. All operations accept `--root` and `--json`. A check exits 1 for `fail` and 0 for `pass` or `review`; automation must inspect the status. A changed boundary needs a refreshed focus before writing projections. Previewing keeps the previous baseline.

Kerf does not infer a project’s meaning during `init`. Write concepts when a project has something worth preserving, then bind code as evidence. A renamed display title can keep its stable key.

Project frontmatter names entry concepts with `concepts`. A concept’s `requires` lists meaning it depends on; `governs` lists meaning it constrains. `files` binds realizations as evidence, while `lenses` lists applicable executable projections:

```yaml
key: player-evidence
title: Player evidence is player-originated musical input
aliases: [player input]
requires: [event-origin]
governs: []
files: [src/evidence.mjs]
lenses: [event-provenance]
```

## Lenses

A lens is a readable local ES module under `.kerf/lenses/`. Its default export may declare `description`, `select.paths`, `select.importsOf`, exact `owns` paths, and async `check(ctx)` or `render(ctx)` functions. Checks return an array of `{ status: 'pass' | 'fail' | 'unknown', message }`; renderers return an array of `{ path, content }` for declared owned paths. The context supplies selected concepts, observed files, tracked `query` and `read` helpers, and an explicit `run` helper. See the [working lens](examples/music-events/.kerf/lenses/event-provenance.mjs). Lenses are trusted project code. Kerf provides no sandbox or claim that every relationship is known.

## Limits and economics

Kerf observes static local JavaScript and TypeScript imports and exports. Dynamic loading, path aliases, and non-code relationships need an authored binding or a lens. Exact bindings can read ignored files, but their structural dependencies are reported as a gap. Initial indexing and explicit recovery can scan broadly. Warm focused work uses changed inputs and selected index partitions; it does not build a whole-project TypeScript program or parse every concept.

Git change discovery and a manifest of paths, hashes, and binding declarations still scale with repository size. Dirty inputs are hashed again; unchanged conceptual bodies are not reparsed. This is a bounded first implementation, not a claim of constant total cost or optimal semantic discovery. Keep lenses self-contained or declare their supporting inputs: arbitrary module imports and external check commands do not reveal all their dependencies to Kerf. Run one Kerf operation at a time per project.

Source observations expose import and re-export module edges; they do not build a table of locally declared exported symbols. A static consumer query cannot rule out an unmodeled dynamic consumer elsewhere.

`npm test` exercises six compact workflows with Node’s test runner. The example and installed-copy smoke establish the local loop; economic gains on a large real project remain unproven.

The bundled [music-events example](examples/music-events) demonstrates the distinction between system-generated preview playback and player evidence. It exists to exercise this loop, not to rebuild Psychord.

## Local plugin delivery

Run `npm install`, then `npm run install:local` from this repository. The installer registers the repository's small `.agents/plugins/marketplace.json` catalog at user level and installs `kerf@kerf` directly into Codex's managed cache. Repeating the command refreshes local edits through Codex's remove/add commands. There is no staging copy or intermediate package directory.

`npm run smoke:installed` reads Kerf’s installed version from `codex plugin list --json`, resolves its user-level cache entry, validates its manifest, and runs that cached CLI and hook in a temporary Git repository. It makes no model calls. Codex may ask to trust the session hook before automatic hook runs in a new session; review that short marker-only command and use the host’s trust prompt. The direct smoke check verifies the installed hook executable, while the host trust UI remains a separate first-session step.
