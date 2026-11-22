import assert from "node:assert/strict";
import test from "node:test";
import type { AudioPacket } from "../src/core/types.ts";
import { repairPackets } from "../src/core/repair.ts";
import { encodeWavPcm16, renderPackets, renderReport } from "../src/core/render.ts";
import { rms } from "../src/core/dsp.ts";
import { muxOpusWebM } from "../src/media/webm.ts";
import { createDemoStream } from "../src/demo/scenario.ts";

const RATE = 48000;
const FRAMES = 960;

function sine(sequence: number, frequency = 220, frames = FRAMES, rate = RATE): AudioPacket {
  const channel = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const absolute = sequence * frames + index;
    channel[index] = 0.24 * Math.sin(2 * Math.PI * frequency * absolute / rate);
  }
  return {
    sequence,
    sampleRate: rate,
    timestampUs: sequence * frames / rate * 1_000_000,
    channels: [channel]
  };
}

function stereoSine(sequence: number): AudioPacket {
  const packet = sine(sequence);
  const left = packet.channels[0];
  const right = new Float32Array(left.length);
  for (let index = 0; index < right.length; index += 1) {
    right[index] = left[index] * 0.7 +
      0.04 * Math.sin(2 * Math.PI * 330 * (sequence * FRAMES + index) / RATE);
  }
  return { ...packet, channels: [left, right] };
}

function totalFrames(packets: readonly AudioPacket[], rate: number): number {
  return renderPackets(packets, rate).channels[0].length;
}

test("consecutive packet loss becomes one bidirectional repair interval", () => {
  const packets = [0, 1, 2, 3, 4, 5, 6, 7].map((sequence) => sine(sequence));
  const received = packets.filter((packet) => packet.sequence < 2 || packet.sequence > 4);
  const report = repairPackets(received);

  assert.equal(report.intervals.length, 1);
  const interval = report.intervals[0];
  assert.equal(interval.classification, "speech-loss");
  assert.equal(interval.method, "pitch-continuation");
  assert.equal(interval.missingPackets, 3);
  assert.equal(interval.frames, FRAMES * 3);
  assert.equal(interval.transitions.mutedFrames, 0);
  assert.equal(report.stats.consecutiveLossGaps, 1);
  assert.equal(report.stats.repairedFrames, FRAMES * 3);

  const rendered = renderReport(report);
  assert.equal(rendered.channels[0].length, packets.length * FRAMES);
  assert.equal(totalFrames(report.packets, RATE), packets.length * FRAMES);
  const gapStart = 2 * FRAMES;
  const gapRms = rms([rendered.channels[0].subarray(gapStart, gapStart + 3 * FRAMES)]);
  assert.ok(gapRms > 0.1, `expected voiced continuation, got RMS ${gapRms}`);

  const firstConcealed = report.packets.find((packet) => packet.origin === "concealed");
  assert.ok(firstConcealed);
  assert.equal(firstConcealed.channels[0].length, FRAMES * 3);
});

test("true pause is kept silent and is not stretched", () => {
  const packets = Array.from({ length: 8 }, (_, sequence) => ({
    sequence,
    sampleRate: RATE,
    timestampUs: sequence * FRAMES / RATE * 1_000_000,
    channels: [new Float32Array(FRAMES)]
  }));
  const report = repairPackets(packets.filter(
    (packet) => packet.sequence < 3 || packet.sequence > 4
  ));

  assert.equal(report.intervals.length, 1);
  const interval = report.intervals[0];
  assert.equal(interval.classification, "true-pause");
  assert.equal(interval.method, "silence");
  assert.equal(interval.frames, FRAMES * 2);
  assert.equal(interval.transitions.synthesizedFrames, 0);
  assert.equal(report.stats.durationSec, 8 * FRAMES / RATE);
  const gap = report.packets.find((packet) => packet.origin === "concealed");
  assert.ok(gap);
  assert.equal(rms(gap.channels), 0);
});

test("music boundary uses a two-sided equal-power crossfade", () => {
  const before = [sine(0, 220), sine(1, 220)];
  const after = [sine(4, 660), sine(5, 660)];
  const report = repairPackets([...before, ...after]);
  const interval = report.intervals[0];

  assert.equal(interval.classification, "music-boundary");
  assert.equal(interval.method, "equal-power-crossfade");
  assert.equal(interval.transitions.curve, "equal-power");
  assert.equal(interval.frames, FRAMES * 2);
  assert.ok(interval.analysis.correlation < 0.42);

  const gap = report.packets.find((packet) => packet.origin === "concealed");
  assert.ok(gap);
  assert.ok(rms(gap.channels) > 0.05);
  assert.ok(Number.isFinite(gap.channels[0][gap.channels[0].length - 1]));
});

test("a damaged stereo channel is rebuilt from the healthy channel", () => {
  const packets = [stereoSine(0), stereoSine(1), stereoSine(2), stereoSine(3)];
  packets[2].channels[1] = new Float32Array(FRAMES).fill(Number.NaN);
  const report = repairPackets(packets);

  assert.equal(report.stats.corruptChannels, 1);
  assert.equal(report.state.corruptChannelsRepaired, 1);
  assert.ok(report.events.some((event) => event.kind === "channel-repaired"));
  const repaired = report.packets.find((packet) => packet.sequence === 2);
  assert.ok(repaired);
  assert.deepEqual(Array.from(repaired.channels[1]), Array.from(repaired.channels[0]));
});

test("an unusable mono packet is concealed from neighboring packets", () => {
  const packets = [sine(0), sine(1), sine(2), sine(3)];
  packets[2].channels[0] = new Float32Array(FRAMES).fill(Number.NaN);
  const report = repairPackets(packets);

  assert.equal(report.stats.rejectedPackets, 1);
  assert.equal(report.intervals.length, 1);
  assert.equal(report.intervals[0].corruptPackets, 1);
  assert.equal(report.intervals[0].frames, FRAMES);
  assert.equal(report.packets.length, 4);
  assert.ok(report.events.some((event) => event.kind === "corrupt-packet"));
  assert.ok(report.state.framesConcealed > 0);
});

test("sample-rate changes reset timing but preserve concealment metadata", () => {
  const packets = [
    sine(0, 220, 960, 48000),
    sine(1, 220, 960, 48000),
    sine(2, 220, 320, 16000),
    sine(3, 220, 320, 16000),
    sine(6, 220, 320, 16000)
  ];
  const report = repairPackets(packets);

  assert.equal(report.stats.rateTransitions, 1);
  assert.equal(report.state.lastSampleRate, 16000);
  assert.equal(report.intervals.length, 1);
  assert.equal(report.intervals[0].sampleRate, 16000);
  assert.equal(report.intervals[0].frames, 640);
  assert.ok(report.events.some((event) => event.kind === "rate-change"));
  assert.equal(renderReport(report).durationSec, 0.14);
});

test("a gap that straddles a sample-rate switch is emitted at the new rate", () => {
  const packets = [
    sine(0, 220, 960, 48000),
    sine(1, 220, 960, 48000),
    sine(4, 220, 320, 16000),
    sine(5, 220, 320, 16000)
  ];
  const report = repairPackets(packets);
  const interval = report.intervals[0];

  assert.equal(interval.sampleRate, 16000);
  assert.equal(interval.sampleRateChange, true);
  assert.equal(interval.frames, 640);
  assert.equal(report.stats.rateTransitions, 1);
  assert.equal(report.packets.find((packet) => packet.origin === "concealed")?.sampleRate, 16000);
});

test("onset boundary only fades in the post context", () => {
  const silence = new Float32Array(FRAMES);
  const packets: AudioPacket[] = [
    { sequence: 0, sampleRate: RATE, channels: [silence.slice()] },
    { sequence: 1, sampleRate: RATE, channels: [silence.slice()] },
    sine(4, 300),
    sine(5, 300)
  ];
  const report = repairPackets(packets);
  const interval = report.intervals[0];

  assert.equal(interval.classification, "onset-boundary");
  assert.equal(interval.method, "edge-fade");
  assert.equal(interval.transitions.leadFrames, 0);
  assert.ok(interval.transitions.tailFrames > 0);
  assert.equal(interval.transitions.mutedFrames,
    interval.frames - interval.transitions.tailFrames);
});

test("long consecutive loss is capped without changing duration", () => {
  const packets = Array.from({ length: 30 }, (_, sequence) => sine(sequence));
  const report = repairPackets(packets.filter(
    (packet) => packet.sequence < 5 || packet.sequence > 20
  ));
  const interval = report.intervals[0];

  assert.equal(interval.frames, 16 * FRAMES);
  assert.equal(interval.method, "edge-fade");
  assert.ok(interval.transitions.mutedFrames > 0);
  assert.ok(Math.abs(report.stats.durationSec - 30 * FRAMES / RATE) < 1e-12);
  assert.equal(renderReport(report).channels[0].length, 30 * FRAMES);
});

test("diagnostics are JSON serializable and include state snapshots", () => {
  const report = repairPackets([sine(0), sine(1), sine(4), sine(5)]);
  const serialized = JSON.parse(JSON.stringify({
    intervals: report.intervals,
    events: report.events,
    state: report.state,
    stats: report.stats
  }));
  assert.equal(serialized.intervals[0].classification, "speech-loss");
  assert.equal(serialized.intervals[0].stateBefore.status, "tracking");
  assert.ok(serialized.intervals[0].analysis.preRms > 0);
  assert.ok(serialized.events.length >= 5);
});

test("WAV output keeps a valid RIFF header and exact payload size", () => {
  const channels = [new Float32Array(480), new Float32Array(480)];
  const wav = encodeWavPcm16(channels, 48000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(40, true), 480 * 2 * 2);
  assert.equal(wav.length, 44 + 480 * 2 * 2);
});

test("Opus WebM muxer emits EBML, WebM and Opus track metadata", () => {
  const frames = [0, 1, 2].map((index) => ({
    timestampUs: index * 20000,
    data: new Uint8Array([0xf8, 0xff, 0xfe, index, index + 1])
  }));
  const webm = muxOpusWebM(frames, {
    durationMs: 60,
    sampleRate: 48000,
    channels: 2
  });
  assert.deepEqual(Array.from(webm.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
  const text = new TextDecoder().decode(webm);
  assert.ok(text.includes("webm"));
  assert.ok(text.includes("A_OPUS"));
  assert.ok(text.includes("OpusHead"));
});

test("mixed demo exercises pause, boundary, rate and damage paths", () => {
  const demo = createDemoStream("mixed");
  const report = repairPackets(demo.packets);
  const classifications = new Set(report.intervals.map((interval) => interval.classification));

  assert.ok(classifications.has("true-pause"));
  assert.ok(classifications.has("music-boundary"));
  assert.ok(classifications.has("speech-loss"));
  assert.equal(report.stats.rateTransitions, 1);
  assert.ok(report.stats.corruptChannels > 0);
  assert.ok(Math.abs(report.stats.durationSec - demo.durationSec) < 1e-6);
});
