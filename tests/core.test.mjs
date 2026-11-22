import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { analyzeSegment, buildPlaylist, runSeekTrials } from "../public/modules/analyzer.js";
import { parseMp4Audio } from "../public/modules/mp4.js";

const manifest = JSON.parse(await readFile(new URL("../public/fixtures/manifest.json", import.meta.url)));
const truth = JSON.parse(await readFile(new URL("./fixtures/truth.json", import.meta.url)));
const truthById = new Map(truth.segments.map((segment) => [segment.id, segment]));

async function loadInfo(descriptor) {
  const bytes = await readFile(new URL(`../public/fixtures/${descriptor.file}`, import.meta.url));
  return parseMp4Audio(new Uint8Array(bytes));
}

function sourceValue(sourceIndex) {
  const t = Math.max(0, sourceIndex) / truth.sampleRate;
  return (
    Math.sin(2 * Math.PI * 73 * t) * 0.21 +
    Math.sin(2 * Math.PI * 331 * t + 0.4) * 0.08 +
    Math.sin(2 * Math.PI * 917 * t + 1.1) * 0.025
  );
}

function modelledPcm(descriptor, info) {
  const truthSegment = truthById.get(descriptor.id);
  const channels = Array.from({ length: info.channels }, () => new Float32Array(info.totalDecodedSamples));
  const priming = info.mediaTimeSamples || 0;
  for (let i = 0; i < info.totalDecodedSamples; i++) {
    const relative = i - priming;
    const sourceIndex = truthSegment.cutStart + relative;
    const value = relative < 0 ? sourceValue(truthSegment.cutStart + relative) : sourceValue(sourceIndex);
    for (const channel of channels) channel[i] = value;
  }
  return { sampleRate: info.sampleRate, channels, decodeMode: "webcodecs-raw" };
}

test("MP4 demuxer reads AAC packets and exact edit-list timing", async () => {
  for (const descriptor of manifest.segments) {
    const info = await loadInfo(descriptor);
    const expected = truthById.get(descriptor.id);
    assert.equal(info.codec, "mp4a.40.2");
    assert.equal(info.sampleRate, 48000);
    assert.equal(info.channels, 2);
    assert.ok(info.description.length >= 2);
    assert.ok(info.packets.length > 100);
    assert.equal(info.totalDecodedSamples, info.packets.length * 1024);
    if (expected.hasEditList) {
      assert.ok(info.edit, `${descriptor.id} should have an edit list`);
      assert.equal(info.mediaTimeSamples, 1024);
      assert.equal(info.editDurationSamples, expected.sourceSamples);
      assert.ok(info.paddingSamples === null || info.paddingSamples >= 0);
    } else {
      assert.equal(info.edit, null);
      assert.equal(info.editDurationSamples, null);
      assert.match(info.warnings.join(" "), /no edit list/i);
    }
  }
});

test("analysis derives different padding per segment instead of fixed milliseconds", async () => {
  const analyses = [];
  for (const descriptor of manifest.segments) {
    const info = await loadInfo(descriptor);
    const analysis = analyzeSegment(descriptor, modelledPcm(descriptor, info), info);
    analyses.push(analysis);
  }
  const confirmed = analyses.filter((segment) => segment.status === "confirmed");
  const held = analyses.filter((segment) => segment.status === "unconfirmed");
  assert.equal(confirmed.length, 6);
  assert.equal(held.length, 2);
  for (const segment of confirmed) {
    const expected = truthById.get(segment.descriptor.id);
    assert.equal(segment.primingSamples, 1024);
    assert.equal(segment.retainedSamples, expected.sourceSamples);
    assert.equal(segment.decodedSamples - segment.primingSamples - segment.retainedSamples, segment.paddingSamples);
    assert.ok(segment.paddingSamples >= 0);
  }
  const distinctPadding = new Set(confirmed.map((segment) => segment.paddingSamples));
  assert.ok(distinctPadding.size >= 4, `expected variable padding, got ${[...distinctPadding]}`);
  for (const segment of held) {
    assert.equal(segment.primingSamples, null);
    assert.equal(segment.retainedSamples, null);
    assert.match(segment.reason, /edit list|预滚|填充/);
  }
});

test("waveform-only evidence never invents an exact trim", async () => {
  const descriptor = manifest.segments[6];
  const info = await loadInfo(descriptor);
  const count = info.totalDecodedSamples;
  const channel = new Float32Array(count);
  const silence = Math.round(info.sampleRate * 0.06);
  for (let i = silence; i < count - silence; i++) channel[i] = sourceValue(i);
  const pcm = {
    sampleRate: info.sampleRate,
    channels: [channel, channel.slice()],
    decodeMode: "webcodecs-raw"
  };
  const analysis = analyzeSegment(descriptor, pcm, info);
  assert.equal(analysis.status, "unconfirmed");
  assert.equal(analysis.primingSamples, null);
  assert.equal(analysis.paddingSamples, null);
  assert.match(analysis.reason, /不能证明|猜测/);
});

test("playlist preserves sample continuity and survives ten adjacent seam seeks", async () => {
  const analyses = [];
  for (const descriptor of manifest.segments) {
    const info = await loadInfo(descriptor);
    const pcm = modelledPcm(descriptor, info);
    if (!truthById.get(descriptor.id).hasEditList) {
      pcm.decodeMode = "webcodecs-raw";
    }
    analyses.push(analyzeSegment(descriptor, pcm, info));
  }
  const playlist = buildPlaylist(analyses);
  assert.equal(playlist.segments.length, 6);
  assert.equal(playlist.unconfirmed.length, 2);
  assert.equal(playlist.totalSamples, 1392000);
  assert.equal(playlist.seams.length, 5);
  assert.ok(playlist.continuityPass);
  for (const seam of playlist.seams) {
    assert.equal(seam.status, "pass");
    assert.ok(seam.stepRatio <= 6);
  }
  const sourceAtSeam = playlist.seams.map((seam) => {
    const truthIndex = truthById.get(playlist.segments[seam.index - 1].descriptor.id).cutEnd;
    return { actual: playlist.pcm[0][seam.atSample], expected: sourceValue(truthIndex) };
  });
  for (const pair of sourceAtSeam) {
    assert.ok(Math.abs(pair.actual - pair.expected) < 1e-6);
  }
  const trials = runSeekTrials(playlist, 10);
  assert.equal(trials.length, 10);
  assert.ok(trials.every((trial) => trial.passed));
  assert.deepEqual(
    trials.slice(0, 6).map((trial) => trial.seamIndex),
    [1, 2, 3, 4, 5, 1]
  );
});
