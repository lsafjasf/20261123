import assert from "node:assert/strict";
import { test } from "node:test";
import { buildM3U8, buildManifest, confirmedEntries } from "../src/analysis/playlist.ts";
import type { MatchGroup } from "../src/shared/types.ts";

function group(
  id: string,
  status: MatchGroup["status"],
  occurrences: Array<[number, number, number]>,
): MatchGroup {
  return {
    id,
    status,
    score: 0.9,
    note: "",
    occurrences: occurrences.map(([start, end, score]) => ({
      start,
      end,
      score,
      shift: 0,
    })),
  };
}

const groups = [
  group("a", "confirmed", [
    [12.5, 16.25, 0.91],
    [75, 79.5, 0.86],
  ]),
  group("b", "rejected", [[22, 26, 0.7]]),
  group("c", "pending", [[40, 44, 0.8]]),
  group("d", "confirmed", [[90, 93, 0.95]]),
];

test("only confirmed groups enter the playable hit list", () => {
  const entries = confirmedEntries(groups);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.start),
    [12.5, 75, 90],
  );
});

test("M3U8 embeds start and stop times for local players", () => {
  const output = buildM3U8({
    sourceName: "session.wav",
    durationSec: 120,
    groups,
  });
  assert.match(output, /#EXTVLCOPT:start-time=12\.500/);
  assert.match(output, /#EXTVLCOPT:stop-time=16\.250/);
  assert.equal(
    output.split("\n").filter((line) => line === "session.wav").length,
    3,
  );
  assert.doesNotMatch(output, /start-time=22\.000/);
});

test("JSON manifest reports only confirmed hit ranges", () => {
  const manifest = JSON.parse(
    buildManifest({
      sourceName: "session.wav",
      durationSec: 120,
      groups,
      generatedAt: new Date("2026-11-23T00:00:00Z"),
    }),
  );
  assert.equal(manifest.hitCount, 3);
  assert.equal(manifest.confirmedGroups, 2);
  assert.equal(manifest.totalHitSec, 11.25);
  assert.equal(manifest.entries[2].startSec, 90);
});
