import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  FPS_OPTIONS,
  beatCrossings,
  computeTiming,
  durationInBeats,
  fpsAnchors,
  nearestFrame,
  normalizeConfig,
  outputTimeAtSource,
  rateAt,
  snapStartToBeats,
  sourcePositionAt,
} from "../public/js/model.js";
import { renderTapeStop } from "../public/js/synth.js";
import {
  buildAutomationCsv,
  buildEventMap,
  buildPackage,
  buildTailReport,
  buildWav,
} from "../public/js/export.js";

const config = normalizeConfig(DEFAULT_CONFIG);
const render = renderTapeStop(config);

test("default timing is frame-anchored and sample-exact", () => {
  assert.ok(Math.abs(config.impactSec - 138 / 30) < 1e-12);
  assert.equal(render.timing.impactSample, Math.round(config.impactSec * 48_000));
  assert.equal(render.timing.totalSamples, render.timing.impactSample + 24_000);
  assert.ok(durationInBeats(config) > 3.99 && durationInBeats(config) < 4.01);
});

test("FPS changes preserve canonical event time and all audio samples", () => {
  for (const fps of FPS_OPTIONS) {
    const remapped = { ...config, fps };
    const other = renderTapeStop(remapped);
    assert.deepEqual(other.left, render.left, `left PCM changed at ${fps} fps`);
    assert.deepEqual(other.right, render.right, `right PCM changed at ${fps} fps`);
    assert.equal(other.timing.impactSample, render.timing.impactSample);
    const anchor = fpsAnchors(remapped, [fps])[0];
    assert.equal(anchor.impactFrame, nearestFrame(config.impactSec, fps));
    assert.equal(anchor.impactSec, config.impactSec);
  }
});

test("tape-stop rate falls continuously and source phase is monotonic", () => {
  let previousRate = 1;
  let previousSource = -Infinity;
  for (let index = 0; index <= 1000; index += 1) {
    const time = config.startSec
      + (config.impactSec - config.startSec) * (index / 1000);
    const rate = rateAt(time, config);
    const source = sourcePositionAt(time, config);
    assert.ok(rate <= previousRate + 1e-12);
    assert.ok(source >= previousSource - 1e-12);
    assert.ok(Number.isFinite(source));
    previousRate = rate;
    previousSource = source;
  }
  assert.equal(rateAt(config.impactSec, config), 0);
  assert.ok(sourcePositionAt(config.impactSec, config) < config.impactSec);
});

test("source-to-output beat mapping is sample-level and sorted", () => {
  const crossings = beatCrossings(config);
  assert.ok(crossings.length >= 1);
  for (let index = 0; index < crossings.length; index += 1) {
    const crossing = crossings[index];
    assert.equal(crossing.sample, Math.round(crossing.timeSec * 48_000));
    assert.ok(crossing.timeSec > config.startSec);
    assert.ok(crossing.timeSec < config.impactSec);
    assert.ok(Math.abs(outputTimeAtSource(crossing.sourceSec, config)! - crossing.timeSec) < 1e-12);
    if (index > 0) assert.ok(crossing.sample > crossings[index - 1].sample);
  }
});

test("renderer is finite, non-silent, and hard-silent from impact onward", () => {
  assert.ok(render.analysis.peak > 0.1);
  assert.equal(render.analysis.postImpactPeak, 0);
  assert.equal(render.analysis.postImpactNonZero, 0);
  assert.equal(render.analysis.impactSampleIsZero, true);
  assert.equal(render.analysis.lastNonZeroSample, render.timing.impactSample - 1);
  for (let index = render.timing.impactSample; index < render.timing.totalSamples; index += 1) {
    assert.equal(render.left[index], 0);
    assert.equal(render.right[index], 0);
  }
  for (let index = 0; index < render.timing.totalSamples; index += 37) {
    assert.ok(Number.isFinite(render.left[index]));
    assert.ok(Number.isFinite(render.right[index]));
  }
});

test("snap helper lands exactly four beats before impact", () => {
  const snapped = snapStartToBeats(config, 4);
  assert.ok(Math.abs(durationInBeats(snapped) - 4) < 1e-12);
  assert.ok(snapped.startSec < snapped.impactSec);
});

test("WAV data remains zero after the impact sample", () => {
  const wav = buildWav(render);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), "WAVE");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint16(34, true), 24);
  const dataSize = view.getUint32(40, true);
  assert.equal(dataSize, render.timing.totalSamples * 6);
  let offset = 44 + render.timing.impactSample * 6;
  for (let index = render.timing.impactSample; index < render.timing.totalSamples; index += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      assert.equal(wav[offset], 0);
      assert.equal(wav[offset + 1], 0);
      assert.equal(wav[offset + 2], 0);
      offset += 3;
    }
  }
});

test("event map has exact sample anchors and a passing tail proof", () => {
  const map = buildEventMap(render, "2026-11-23T00:00:00.000Z");
  assert.equal(map.schema, "apex.tape-stop.sample-event-map/v1");
  assert.equal(map.timing.impactSample, render.timing.impactSample);
  assert.equal(map.tailProof.verdict, "PASS");
  assert.equal(map.tailProof.postImpactNonZeroSamples, 0);
  assert.equal(map.tailProof.lastNonZeroSample, render.timing.impactSample - 1);
  assert.equal(map.fpsMap.length, FPS_OPTIONS.length);
  assert.ok(map.events.length >= 5);
  for (let index = 0; index < map.events.length; index += 1) {
    const event = map.events[index];
    assert.ok(Number.isInteger(event.sample));
    assert.ok(event.sample >= 0);
    if (index > 0) assert.ok(event.sample >= map.events[index - 1].sample);
  }
  const impact = map.events.find((event) => event.id === "impact-mute");
  assert.ok(impact);
  assert.equal(impact.sample, render.timing.impactSample);
  assert.equal(impact.rate, 0);
});

test("sample automation CSV spans every sample in the deceleration", () => {
  const csv = buildAutomationCsv(render);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "sample,time_sec,rate,pitch_cents,source_sec,gain_db,event");
  assert.equal(
    lines.length,
    render.timing.impactSample - render.timing.startSample + 2,
  );
  assert.match(lines[1], /^\d+,/);
  assert.match(lines.at(-1)!, /^220800,4\.600000000,0\.000000000,,/);
  assert.match(lines.at(-1)!, /impact_mute$/);
});

test("tail report is generated from the actual rendered buffers", () => {
  const report = buildTailReport(render);
  assert.match(report, /VERDICT: PASS/);
  assert.match(report, /Post-impact non-zero samples: 0/);
  assert.match(report, /Post-impact peak absolute: 0\.000000000000/);
  assert.match(report, /Impact sample exactly zero in both channels: true/);
});

test("package contains WAV, event map, sample automation, proof, and valid zip", () => {
  const bundle = buildPackage(render);
  const names = bundle.files.map((file) => file.name);
  assert.deepEqual(names, [
    "apex-tape-stop.wav",
    "event-map.json",
    "automation.csv",
    "tail-gate.txt",
  ]);
  assert.equal(new TextDecoder().decode(bundle.files[0].data.subarray(0, 4)), "RIFF");
  assert.match(new TextDecoder().decode(bundle.files[3].data), /VERDICT: PASS/);
  assert.equal(new DataView(bundle.zip.buffer).getUint32(0, true), 0x04034b50);

  const view = new DataView(bundle.zip.buffer, bundle.zip.byteOffset, bundle.zip.byteLength);
  const eocd = bundle.zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), names.length);
  const centralOffset = view.getUint32(eocd + 16, true);
  let cursor = centralOffset;
  const zipNames: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    zipNames.push(new TextDecoder().decode(bundle.zip.subarray(cursor + 46, cursor + 46 + nameLength)));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.deepEqual(zipNames, names);
});
