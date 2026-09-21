---
key: event-origin
title: Event origin is a historical fact
aliases:
  - origin
  - system event
requires: []
governs:
  - player-evidence
files:
  - src/evidence.mjs
lenses:
  - event-provenance
evidence:
  immutableOrigins: true
  systemOrigins:
    - playback
---

# Event origin is a historical fact

Each event records where it came from. A classifier may interpret that origin,
but it must not replace it. `playback` denotes a system-produced event, even if
its musical content matches a note that a player originally performed.

The distinction protects historical evidence from being created by replay.
