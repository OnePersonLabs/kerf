---
name: kerf
description: Keep a project's purpose, behavior, relationships, and reasons readable while changing its code. Use in a repository activated with .kerf/project.md.
---

# Kerf

Kerf treats the conceptual model as the durable artifact. Code, tests, and configuration are evidence and realizations of that model. Resolve the plugin root as `../..` from the directory containing this `SKILL.md`; invoke its CLI as `node "<plugin-root>/src/cli.mjs"`. Do not assume a global `kerf` executable exists.

When `.kerf/project.md` is present, begin a substantial change by running `node "<plugin-root>/src/cli.mjs" focus "<intended change>"` from the repository. Give `--concept` or `--path` only when they are known useful starting points. Read the named work brief before deciding which implementation to touch.

Use the brief to identify the meaning that governs the change, why each item was selected, its observed realizations, and the next unanswered question. Expand only for a concrete dependency, conflict, or missing consequence. If the brief reports consequential unknowns, resolve them before claiming safety; do not conceal them with a larger generic scan.

Edit the conceptual Markdown when the user's requested change authorizes a change in meaning. A clear authorized change revises the model directly; ask only when conflicting intent remains unresolved or the intended meaning is materially ambiguous. Existing code is evidence, never automatic authority.

When authoring a concept or lens, use the schema in the [plugin README](../../README.md) and the [working musical example](../../examples/music-events/README.md). Keep a concept's stable frontmatter key when its display title changes.

Refresh the same named focus after revising meaning or understanding a changed boundary. A saved brief is a scoped baseline, not a promise to preserve superseded intent.

After the relevant meaning is understood, run `render <work-name>` to preview applicable deterministic projections. Use `--write` only for a declared owned file once its inputs are understood. Use normal tools for the remaining implementation, then run `check <work-name>` after the relevant behavior works. Reconcile disagreements between the work, the model, and observed code; report unresolved gaps plainly.

`init --purpose "..."` activates a Git repository without inventing concepts. Use `rebuild` for explicit index recovery, not as an ordinary preflight.

Kerf observes static local JavaScript and TypeScript import and re-export module edges. Dynamic loading, aliases, and other unobserved relationships remain explicit gaps unless the model or a lens states them.
