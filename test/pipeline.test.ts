import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEdl } from "../src/parse/edl.ts";
import { edlToIngest } from "../src/parse/edl-ingest.ts";
import { parseFcpxml } from "../src/parse/fcpxml.ts";
import { normalizeOne, pickProjectRate } from "../src/core/normalize.ts";
import { analyzeTimeline } from "../src/analyze/analyze.ts";
import { exportEdl } from "../src/export/edl.ts";
import { RATE_23976, RATE_25 } from "../src/core/timecode.ts";

const edlText = readFileSync("samples/dept_a_23976.edl", "utf8");
const fcpxmlText = readFileSync("samples/dept_b_25.fcpxml", "utf8");
const dfText = readFileSync("samples/dept_c_2997df.edl", "utf8");

test("EDL parser reads events, M2 motion, transitions", () => {
  const doc = parseEdl(edlText);
  assert.equal(doc.title, "DEPT_A_23976");
  assert.equal(doc.dropFrame, false);
  assert.equal(doc.events.length, 5);
  assert.equal(doc.events[1].editCode, "D");
  assert.equal(doc.events[1].transitionFrames, 24);
  assert.equal(doc.events[2].motion?.speedPercent, 50);
  assert.equal(doc.events[3].motion?.speedPercent, 0);
});

test("drop-frame EDL maps to 29.97 DF automatically", () => {
  const ingest = edlToIngest(parseEdl(dfText), "dept_c", null);
  assert.equal(ingest.declaredRate?.label, "29.97 DF");
  assert.equal(ingest.declaredRate?.drop, true);
});

test("FCPXML parser reads rates, retime, ramps, lanes", () => {
  const ingest = parseFcpxml(fcpxmlText, "dept_b");
  assert.equal(ingest.declaredRate?.label, "25");
  assert.equal(ingest.clips.length, 5);
  const retimed = ingest.clips.find((c) => c.name === "B_CLOSE_UP");
  assert.equal(retimed?.speedSegments[0].speed, 2);
  const ramp = ingest.clips.find((c) => c.name === "B_FILM_SCAN_23976");
  assert.equal(ramp?.speedSegments.length, 2);
  assert.equal(ramp?.speedSegments[0].speed, 2);
  assert.equal(ramp?.speedSegments[1].speed, 1 / 3);
  assert.equal(ramp?.sourceRate.label, "23.976");
  const title = ingest.clips.find((c) => c.name === "B_LOWER_THIRD");
  assert.ok(title?.capabilities.includes("title"));
});

test("normalize places clips on the project grid exactly", () => {
  const ingest = parseFcpxml(fcpxmlText, "dept_b");
  const tl = normalizeOne(ingest, RATE_25);
  const wide = tl.tracks.flatMap((t) => t.clips).find((c) => c.name === "B_WIDE_SHOT");
  assert.equal(wide?.recordIn, 0);
  assert.equal(wide?.recordOut, 125);
  const close = tl.tracks.flatMap((t) => t.clips).find((c) => c.name === "B_CLOSE_UP");
  assert.equal(close?.transitionIn?.kind, "dissolve");
  assert.equal(close?.transitionIn?.duration, 25);
});

test("analysis finds speed, transitions, missing media, conforms", () => {
  const inputs = [
    edlToIngest(parseEdl(edlText), "a", RATE_23976),
    parseFcpxml(fcpxmlText, "b"),
  ];
  const rate = pickProjectRate(inputs, RATE_25);
  const tlA = normalizeOne(inputs[0], rate);
  const report = analyzeTimeline(tlA, () => false);
  assert.equal(report.speed.length, 2);
  assert.ok(report.speed.some((s) => s.kind === "freeze"));
  assert.equal(report.transitions.length, 1);
  assert.equal(report.missingMedia.length, 5);
  assert.equal(report.conforms.length, 5);
});

test("EDL export emits M2 and lists ramp loss", () => {
  const ingest = parseFcpxml(fcpxmlText, "dept_b");
  const tl = normalizeOne(ingest, RATE_25);
  const { edl, losses } = exportEdl(tl);
  assert.match(edl, /M2\s+a2\s+200\.0/);
  assert.match(edl, /D    025/);
  assert.ok(losses.some((l) => l.feature === "speed ramp" && l.severity === "lost"));
  assert.ok(losses.some((l) => l.feature === "multiple video tracks"));
});
