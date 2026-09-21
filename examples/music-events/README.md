# Music events

This small project exists to demonstrate Kerf's intended loop without importing
Psychord or depending on an existing implementation. Its two concepts establish
that an event's origin is historical fact and that only a player's note is
evidence of player performance.

`event-provenance.mjs` turns those concepts into `src/evidence.mjs`. The
generated module can be replaced by a handwritten implementation if it preserves
the same conceptual rules and passes the lens check.

Copy the example into its own Git repository. From the Kerf repository root:

```powershell
Copy-Item -Recurse examples/music-events ../kerf-music-demo
git -C ../kerf-music-demo init
node src/cli.mjs focus "keep playback out of player evidence" --root ../kerf-music-demo --name repeat-preview --concept player-evidence
node src/cli.mjs render repeat-preview --write --root ../kerf-music-demo
node src/cli.mjs check repeat-preview --root ../kerf-music-demo
```
