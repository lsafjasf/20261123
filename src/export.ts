import {
  FPS_OPTIONS,
  type BeatCrossing,
  fpsAnchors,
  nearestFrame,
  rateAt,
  sourcePositionAt,
  timecode,
} from "./model.js";
import type { RenderResult } from "./synth.js";

export interface PackageFile {
  name: string;
  data: Uint8Array;
}

export interface MappedEvent {
  id: string;
  event: string;
  sample: number;
  timeSec: number;
  frame: number;
  sourceSec: number | null;
  rate: number | null;
  note: string;
}

function textFile(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sampleTime(sample: number, sampleRate: number): number {
  return sample / sampleRate;
}

function buildEvents(result: RenderResult): MappedEvent[] {
  const { config, timing } = result;
  const frame = (sample: number): number => nearestFrame(sample / timing.sampleRate, config.fps);
  const event = (
    id: string,
    name: string,
    sample: number,
    note: string,
    sourceSec: number | null = null,
    rate: number | null = null,
  ): MappedEvent => ({
    id,
    event: name,
    sample,
    timeSec: sampleTime(sample, timing.sampleRate),
    frame: frame(sample),
    sourceSec,
    rate,
    note,
  });

  const events: MappedEvent[] = [
    event("track-in", "track_in", 0, "First PCM frame. Timeline starts before the tape-stop."),
    event(
      "decel-start",
      "deceleration_start",
      timing.startSample,
      "Playback rate leaves 1.000x; phase integration begins.",
      config.startSec,
      1,
    ),
  ];

  for (const crossing of result.crossings) {
    events.push(
      event(
        `beat-${crossing.beatIndex}`,
        "beat_phase_crossing",
        crossing.sample,
        `Source beat ${crossing.beatIndex} is read while the transport is slowing.`,
        crossing.sourceSec,
        crossing.rate,
      ),
    );
  }

  events.push(
    event(
      "final-fade-start",
      "terminal_fade_start",
      Math.max(timing.startSample, timing.impactSample - Math.round(0.004 * timing.sampleRate)),
      "Four-millisecond zero-bound fade prevents a hard-clipped click.",
      sourcePositionAt((timing.impactSample - Math.round(0.004 * timing.sampleRate)) / timing.sampleRate, config),
      rateAt((timing.impactSample - Math.round(0.004 * timing.sampleRate)) / timing.sampleRate, config),
    ),
    event(
      "impact-mute",
      "impact_hard_mute",
      timing.impactSample,
      "Exact impact sample. All channels are zero from this sample onward.",
      sourcePositionAt(config.impactSec, config),
      0,
    ),
    event(
      "freeze-end",
      "freeze_end",
      timing.totalSamples,
      "Exclusive end of the frozen-frame hold; still digitally silent.",
      null,
      0,
    ),
    event(
      "last-nonzero",
      "last_nonzero_sample",
      result.analysis.lastNonZeroSample,
      "Last sample in the rendered float buffer with any non-zero channel value.",
      null,
    ),
  );

  return events.sort((a, b) => a.sample - b.sample || a.id.localeCompare(b.id));
}

function tailProof(result: RenderResult): Record<string, unknown> {
  const { timing, analysis, config } = result;
  const pass =
    analysis.postImpactNonZero === 0 &&
    analysis.postImpactPeak === 0 &&
    analysis.impactSampleIsZero &&
    analysis.lastNonZeroSample < timing.impactSample;
  return {
    verdict: pass ? "PASS" : "FAIL",
    method:
      "Exhaustive scan of the rendered Float32 PCM. Each channel sample at or after impactSample is tested for exact non-zero equality.",
    impactSample: timing.impactSample,
    impactExactSec: timing.impactSample / timing.sampleRate,
    scanStartSample: timing.impactSample,
    scanEndSampleExclusive: timing.totalSamples,
    checkedTailSamples: analysis.checkedTailSamples,
    postImpactNonZeroSamples: analysis.postImpactNonZero,
    postImpactPeakAbs: analysis.postImpactPeak,
    impactSampleIsZero: analysis.impactSampleIsZero,
    lastNonZeroSample: analysis.lastNonZeroSample,
    lastNonZeroSec: analysis.lastNonZeroSample / timing.sampleRate,
    samplesBeforeMute: timing.impactSample - analysis.lastNonZeroSample,
    tailDurationSec: (timing.totalSamples - timing.impactSample) / timing.sampleRate,
    activeMasterEffectsAfterMute: "none",
    reverbOrDelaySends: "none",
    fpsIndependent: true,
    sourceImpactFrame: nearestFrame(timing.impactSec, config.fps),
  };
}

export interface EventMap {
  schema: string;
  generatedAt: string;
  clip: {
    fps: number;
    startFrame: number;
    impactFrame: number;
    startTimecode: string;
    impactTimecode: string;
    sampleRate: number;
    channels: number;
    bitDepth: number;
    bpm: number;
    holdSec: number;
  };
  timing: Record<string, number>;
  fpsMap: ReturnType<typeof fpsAnchors>;
  beatCrossings: BeatCrossing[];
  events: MappedEvent[];
  tailProof: Record<string, unknown>;
}

export function buildEventMap(result: RenderResult, generatedAt = new Date().toISOString()): EventMap {
  const { config, timing } = result;
  return {
    schema: "apex.tape-stop.sample-event-map/v1",
    generatedAt,
    clip: {
      fps: config.fps,
      startFrame: nearestFrame(config.startSec, config.fps),
      impactFrame: nearestFrame(config.impactSec, config.fps),
      startTimecode: timecode(config.startSec, config.fps),
      impactTimecode: timecode(config.impactSec, config.fps),
      sampleRate: timing.sampleRate,
      channels: 2,
      bitDepth: 24,
      bpm: config.bpm,
      holdSec: config.holdSec,
    },
    timing: {
      startSec: config.startSec,
      impactSec: config.impactSec,
      totalSec: timing.totalSec,
      startSample: timing.startSample,
      impactSample: timing.impactSample,
      totalSamples: timing.totalSamples,
      holdSamples: timing.holdSamples,
      decelSec: timing.decelSec,
    },
    fpsMap: fpsAnchors(config, FPS_OPTIONS),
    beatCrossings: result.crossings,
    events: buildEvents(result),
    tailProof: tailProof(result),
  };
}

export function buildAutomationCsv(result: RenderResult): string {
  const { config, timing } = result;
  const lines = [
    "sample,time_sec,rate,pitch_cents,source_sec,gain_db,event",
  ];
  const beatBySample = new Map(result.crossings.map((item) => [item.sample, item.beatIndex]));
  const fadeSamples = Math.max(1, Math.round(0.004 * timing.sampleRate));

  for (let sample = timing.startSample; sample <= timing.impactSample; sample += 1) {
    const timeSec = sample / timing.sampleRate;
    const rate = rateAt(timeSec, config);
    const fade = sample >= timing.impactSample
      ? 0
      : Math.min(1, (timing.impactSample - sample) / fadeSamples);
    const cents = rate > 0 ? (1200 * Math.log2(rate)).toFixed(4) : "";
    const gainDb = fade > 0 ? (20 * Math.log10(fade)).toFixed(4) : "-inf";
    const flags: string[] = [];
    if (sample === timing.startSample) flags.push("decel_start");
    if (sample === timing.impactSample) flags.push("impact_mute");
    if (beatBySample.has(sample)) flags.push(`beat_${beatBySample.get(sample)}`);
    lines.push([
      sample,
      timeSec.toFixed(9),
      rate.toFixed(9),
      cents,
      sourcePositionAt(timeSec, config).toFixed(9),
      gainDb,
      flags.join("|"),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function buildTailReport(result: RenderResult): string {
  const proof = tailProof(result);
  return [
    "APEX / TAPE STOP — TAIL GATE REPORT",
    "===================================",
    "",
    `VERDICT: ${proof.verdict}`,
    `Generated: ${new Date().toISOString()}`,
    `Sample rate: ${result.timing.sampleRate} Hz`,
    `Channels: 2`,
    `Impact sample: ${proof.impactSample} (${Number(proof.impactExactSec).toFixed(9)} s)`,
    `Exclusive track end: ${result.timing.totalSamples} samples`,
    `Post-impact samples checked: ${proof.checkedTailSamples}`,
    `Post-impact non-zero samples: ${proof.postImpactNonZeroSamples}`,
    `Post-impact peak absolute: ${Number(proof.postImpactPeakAbs).toFixed(12)}`,
    `Impact sample exactly zero in both channels: ${proof.impactSampleIsZero}`,
    `Last non-zero sample: ${proof.lastNonZeroSample}`,
    `Samples from last non-zero to hard mute: ${proof.samplesBeforeMute}`,
    "",
    "METHOD",
    String(proof.method),
    "The renderer has no reverb, delay, compressor, or post-mute automation.",
    "After the impact sample, the buffer is initialized to IEEE +0.0 and is never written.",
    "The same audio master is rendered once at 48 kHz and mapped to video frames;",
    "changing video FPS does not alter the event times or the audio samples.",
  ].join("\n");
}

export function buildWav(result: RenderResult): Uint8Array {
  const { left, right, timing } = result;
  const channels = 2;
  const bitDepth = 24;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = timing.totalSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, timing.sampleRate, true);
  view.setUint32(28, timing.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let sample = 0; sample < timing.totalSamples; sample += 1) {
    for (const channel of [left, right]) {
      const value = Math.max(-1, Math.min(1, channel[sample]));
      const integer = value >= 0
        ? Math.round(value * 8_388_607)
        : Math.round(value * 8_388_608);
      view.setUint8(offset, integer & 0xff);
      view.setUint8(offset + 1, (integer >> 8) & 0xff);
      view.setUint8(offset + 2, (integer >> 16) & 0xff);
      offset += 3;
    }
  }
  return new Uint8Array(buffer);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = crcTable[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true);
  return offset + 2;
}

function writeU32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

export function buildZip(files: PackageFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((file) => ({
    name: encoder.encode(file.name),
    data: file.data,
    crc: crc32(file.data),
  }));
  const localSize = entries.reduce(
    (total, entry) => total + 30 + entry.name.length + entry.data.length,
    0,
  );
  const centralSize = entries.reduce(
    (total, entry) => total + 46 + entry.name.length,
    0,
  );
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const localOffsets: number[] = [];

  for (const entry of entries) {
    localOffsets.push(offset);
    let cursor = offset;
    cursor = writeU32(view, cursor, 0x04034b50);
    cursor = writeU16(view, cursor, 20);
    cursor = writeU16(view, cursor, 0x0800);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU16(view, cursor, 0x5a21);
    cursor = writeU32(view, cursor, entry.crc);
    cursor = writeU32(view, cursor, entry.data.length);
    cursor = writeU32(view, cursor, entry.data.length);
    cursor = writeU16(view, cursor, entry.name.length);
    cursor = writeU16(view, cursor, 0);
    output.set(entry.name, cursor);
    cursor += entry.name.length;
    output.set(entry.data, cursor);
    offset = cursor + entry.data.length;
  }

  const centralOffset = offset;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    let cursor = offset;
    cursor = writeU32(view, cursor, 0x02014b50);
    cursor = writeU16(view, cursor, 20);
    cursor = writeU16(view, cursor, 20);
    cursor = writeU16(view, cursor, 0x0800);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU16(view, cursor, 0x5a21);
    cursor = writeU32(view, cursor, entry.crc);
    cursor = writeU32(view, cursor, entry.data.length);
    cursor = writeU32(view, cursor, entry.data.length);
    cursor = writeU16(view, cursor, entry.name.length);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU16(view, cursor, 0);
    cursor = writeU32(view, cursor, 0);
    cursor = writeU32(view, cursor, localOffsets[index]);
    output.set(entry.name, cursor);
    cursor += entry.name.length;
    offset = cursor;
  }

  let cursor = offset;
  cursor = writeU32(view, cursor, 0x06054b50);
  cursor = writeU16(view, cursor, 0);
  cursor = writeU16(view, cursor, 0);
  cursor = writeU16(view, cursor, entries.length);
  cursor = writeU16(view, cursor, entries.length);
  cursor = writeU32(view, cursor, offset - centralOffset);
  cursor = writeU32(view, cursor, centralOffset);
  writeU16(view, cursor, 0);
  return output;
}

export function buildPackage(
  result: RenderResult,
  extras: PackageFile[] = [],
): { files: PackageFile[]; zip: Uint8Array } {
  const generatedAt = new Date().toISOString();
  const files: PackageFile[] = [
    { name: "apex-tape-stop.wav", data: buildWav(result) },
    { name: "event-map.json", data: textFile(JSON.stringify(buildEventMap(result, generatedAt), null, 2)) },
    { name: "automation.csv", data: textFile(buildAutomationCsv(result)) },
    { name: "tail-gate.txt", data: textFile(buildTailReport(result)) },
    ...extras,
  ];
  return { files, zip: buildZip(files) };
}
