---
key: player-evidence
title: Player evidence is player-originated musical input
aliases:
  - player input
  - performance evidence
requires:
  - event-origin
governs: []
files:
  - src/evidence.mjs
lenses:
  - event-provenance
evidence:
  origins:
    - player
  kinds:
    - note
---

# Player evidence is player-originated musical input

A note contributes player evidence only when its origin is `player`. The same
note produced by playback is a system event and does not become player evidence.

This rule is about provenance, not musical similarity. A classification result
can expose the event origin but may not rewrite it.
