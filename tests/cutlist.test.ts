import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCutRows, toCsv, toJson } from "../src/core/cutlist.ts";
import { suggestSafeTime, validateCuts } from "../src/core/speech.ts";
import type { CutPoint, SpeechSpan } from "../src/core/types.ts";

const cuts: CutPoint[] = [
  { id: "c0", time: 0, suggestedTime: 0, leftClipId: null, rightClipId: "a", beatTime: null, manual: false },
  { id: "c1", time: 5.5, suggestedTime: 5.4, leftClipId: "a", rightClipId: "b", beatTime: 5.5, manual: false },
  { id: "c2", time: 10, suggestedTime: 10, leftClipId: "b", rightClipId: null, beatTime: null, manual: true },
];

const speech: SpeechSpan[] = [{ start: 5.0, end: 6.2, level: 0.4 }];

test("buildCutRows 按时间排序并标注语音安全", () => {
  const rows = buildCutRows(cuts, speech);
  assert.deepEqual(rows.map((r) => r.cutId), ["c0", "c1", "c2"]);
  assert.equal(rows[1].speechSafe, false);
  assert.equal(rows[1].snapToBeat, true);
  assert.equal(rows[2].manual, true);
});

test("toCsv 带 BOM、表头与转义", () => {
  const csv = toCsv(buildCutRows(cuts, speech));
  assert.ok(csv.startsWith("\uFEFFindex,cut_id"));
  assert.ok(csv.includes("c1,5.5,"));
  assert.equal((csv.match(/\r\n/g) ?? []).length >= 4, true);
});

test("toJson 包含片段、切点与说话区间", () => {
  const json = JSON.parse(
    toJson(buildCutRows(cuts), [], speech, 10, "2026-11-23T00:00:00.000Z"),
  );
  assert.equal(json.version, 1);
  assert.equal(json.cuts.length, 3);
  assert.equal(json.speechSpans[0].start, 5);
});

test("validateCuts 报出说话切断、过短与越界", () => {
  const issues = validateCuts(
    cuts,
    speech,
    9,
    { b: 6 },
  );
  const kinds = issues.map((i) => i.kind).sort();
  assert.ok(kinds.includes("speech-split"));
  assert.ok(kinds.includes("too-short"));
  assert.ok(kinds.includes("out-of-range"));
});

test("suggestSafeTime 优先把切点移到说话区间之前", () => {
  const safe = suggestSafeTime(cuts[1], speech, { prevTime: 0, nextTime: 10 });
  assert.ok(safe < speech[0].start);
  const forced = suggestSafeTime(
    { ...cuts[1], time: 5.5 },
    [{ start: 0.1, end: 6.2, level: 1 }],
    { prevTime: 0, nextTime: 10 },
  );
  assert.ok(forced > 6.2);
});
