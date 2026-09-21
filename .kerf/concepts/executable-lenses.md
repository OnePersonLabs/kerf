---
key: executable-lenses
title: Meaning can produce code and check behavior
aliases: [render, checks, projections, owned outputs]
requires: [conceptual-authority, bounded-consequences]
governs: []
files: [src/lenses.mjs, src/work.mjs, examples/music-events/.kerf/lenses/event-provenance.mjs]
lenses: []
---

# Meaning can produce code and check behavior

A lens selects relevant evidence, checks behavior, and may render deterministic
implementation from conceptual parameters. Checks can constrain handwritten code;
the code need not have a prescribed shape. Codex handles implementation that is
not usefully deterministic.

Render previews expose the proposed output. Writes belong to explicitly declared
paths, with changed inputs and competing ownership surfaced. Existing code is
replaceable without discarding its conceptual reason for being.

Lenses are trusted, readable project modules running with host permissions. Their
tracked queries and reads explain dependencies; they are not a JavaScript sandbox.
Checks must report what they actually observed. No check means unknown evidence,
and a pass establishes only the checks that ran.

Verification should answer a material question about affected behavior. There is
no mandatory TDD sequence, coverage target, or endlessly growing proof obligation.
