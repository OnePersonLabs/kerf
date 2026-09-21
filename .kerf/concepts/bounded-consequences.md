---
key: bounded-consequences
title: Context follows consequential relationships
aliases: [incremental index, locality, saved work, discovery queries]
requires: [conceptual-authority]
governs: []
files: [src/index.mjs, src/observe.mjs, src/focus.mjs, src/work.mjs]
lenses: []
---

# Context follows consequential relationships

Start with the intended change. Follow its conceptual dependencies and consequences,
then inspect relevant realizations and their observed consumers. State why each
item belongs and which consequential gaps remain when a boundary is reached.

After initial indexing, changed inputs update disposable, readable partitions.
Ordinary work reads selected concept bodies and relevant lookup partitions, without
building a project-wide TypeScript program or parsing the whole conceptual model.
Git still needs to discover repository changes; locality is not a claim of constant
total runtime for every repository.

Saved work retains values and discovery queries, including empty queries. A new
consumer or conceptual relationship can therefore reopen old work. An unrelated
edit must not invalidate all understanding merely because the repository changed.

Interrupted index updates are visible and require explicit recovery. Rebuilding
the index preserves authored concepts and saved work.

Open boundary: local JS/TS static imports are evidence we can observe. Dynamic
loading, external packages, and unmodeled relationships need explanation or lenses.
