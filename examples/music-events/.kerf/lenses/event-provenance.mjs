const metadataFor = (concept) => concept.metadata ?? concept;

const valuesFor = (concept, field) => {
  const values = metadataFor(concept).evidence?.[field];
  return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
};

const conceptFor = (concepts, key) => concepts.find((concept) => concept.key === key);

const quoted = (value) => JSON.stringify(value, null, 2);

const renderEvidenceModule = ({ origins, kinds, systemOrigins }) => `// Generated from the event-origin and player-evidence concepts by event-provenance.
// A classifier reports provenance; it never changes an event's recorded origin.

export const PLAYER_EVIDENCE_ORIGINS = Object.freeze(${quoted(origins)});
export const PLAYER_EVIDENCE_KINDS = Object.freeze(${quoted(kinds)});
export const SYSTEM_GENERATED_ORIGINS = Object.freeze(${quoted(systemOrigins)});

const isRecord = (value) => value !== null && typeof value === "object";

export function classifyEvent(event) {
  const origin = isRecord(event) ? event.origin : undefined;
  const kind = isRecord(event) ? event.kind : undefined;

  return Object.freeze({
    event,
    origin,
    kind,
    isSystemGenerated: SYSTEM_GENERATED_ORIGINS.includes(origin),
    isPlayerEvidence:
      PLAYER_EVIDENCE_ORIGINS.includes(origin) && PLAYER_EVIDENCE_KINDS.includes(kind),
  });
}
`;

const selectModel = (concepts) => {
  const eventOrigin = conceptFor(concepts, "event-origin");
  const playerEvidence = conceptFor(concepts, "player-evidence");

  if (!eventOrigin || !playerEvidence) {
    throw new Error("event-provenance requires event-origin and player-evidence concepts.");
  }

  const origins = valuesFor(playerEvidence, "origins");
  const kinds = valuesFor(playerEvidence, "kinds");
  const systemOrigins = valuesFor(eventOrigin, "systemOrigins");

  if (origins.length === 0 || kinds.length === 0 || systemOrigins.length === 0) {
    throw new Error("event-provenance needs evidence origins, kinds, and system origins.");
  }

  return { origins, kinds, systemOrigins };
};

export default {
  description: "Projects provenance rules into a small player-evidence classifier.",
  select: {
    paths: [],
    importsOf: ["src/evidence.mjs"],
  },
  owns: ["src/evidence.mjs"],

  async render(ctx) {
    return [{
      path: "src/evidence.mjs",
      content: renderEvidenceModule(selectModel(ctx.concepts)),
    }];
  },

  async check(ctx) {
    const generated = await ctx.read("src/evidence.mjs");
    if (generated === null) {
      return [{
        status: "unknown",
        message: "src/evidence.mjs has not been rendered yet.",
      }];
    }

    const model = selectModel(ctx.concepts);
    const cases = JSON.stringify(model);
    const result = await ctx.run({
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
         import { classifyEvent } from "./src/evidence.mjs";
         const { origins, kinds, systemOrigins } = ${cases};
         for (const origin of origins) {
           for (const kind of kinds) {
             assert.equal(
               classifyEvent({ origin, kind }).isPlayerEvidence,
               true,
               \`Expected \${origin} \${kind} to count as player evidence.\`,
             );
           }
         }
         for (const origin of systemOrigins) {
           for (const kind of kinds) {
             const event = { origin, kind };
             const classified = classifyEvent(event);
             assert.equal(event.origin, origin);
             assert.equal(classified.origin, origin);
             assert.equal(classified.isSystemGenerated, true);
             assert.equal(classified.isPlayerEvidence, false);
           }
         }
         let unknownOrigin = "__kerf_unknown_origin__";
         while (origins.includes(unknownOrigin) || systemOrigins.includes(unknownOrigin)) unknownOrigin += "_";
         assert.equal(classifyEvent({ origin: unknownOrigin, kind: kinds[0] }).isPlayerEvidence, false);
         const playback = { origin: "playback", kind: "note" };
         const playbackResult = classifyEvent(playback);
         assert.equal(playback.origin, "playback");
         assert.equal(playbackResult.origin, "playback");
         assert.equal(playbackResult.isSystemGenerated, true);
         assert.equal(playbackResult.isPlayerEvidence, false);
         assert.equal(classifyEvent({ origin: "player", kind: "note" }).isPlayerEvidence, true);`,
      ],
    });

    return [{
      status: result.code === 0 ? "pass" : "fail",
      message: result.code === 0
        ? "Playback remains system-generated and is not player evidence."
        : result.stderr || result.stdout || "The provenance check failed.",
    }];
  },
};
