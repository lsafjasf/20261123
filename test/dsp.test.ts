import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeAudio } from "../src/analyzer.ts";
import { encodeWavFloat32, measurePeak, measureRmsDb } from "../src/dsp.ts";
import { processAudio, resetAllAutoActions } from "../src/editor.ts";
import { createManifest } from "../src/manifest.ts";
import type { PcmAudio } from "../src/types.ts";

function parseWav(buffer: Buffer): PcmAudio {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset < buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bits = buffer.readUInt16LE(offset + 22);
    }
    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const bytesPerSample = bits / 8;
  const length = dataLength / (bytesPerSample * channels);
  const output = Array.from({ length: channels }, () => new Float32Array(length));
  for (let frame = 0; frame < length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataOffset + (frame * channels + channel) * bytesPerSample;
      output[channel][frame] = buffer.readInt16LE(at) / 32768;
    }
  }
  return { sampleRate, length, channels: output };
}

test("demo separates clean breaths, emotional breaths and low impulses", async () => {
  const wav = await readFile(new URL("../public/demo.wav", import.meta.url));
  const pcm = parseWav(wav);
  const result = analyzeAudio(pcm);
  const kinds = result.events.map((event) => event.kind);
  assert.ok(
    result.events.length >= 5 && result.events.length <= 8,
    `expected 5–8 events, got ${result.events.length}`,
  );
  assert.ok(kinds.filter((kind) => kind === "clean").length >= 2, JSON.stringify(result.events.map((event) => [event.start, event.end, event.kind, event.reasons])));
  assert.equal(kinds.filter((kind) => kind === "emotional").length, 1, JSON.stringify(result.events.map((event) => [event.start, event.end, event.kind])));
  assert.equal(kinds.filter((kind) => kind === "impulse").length, 1, JSON.stringify(result.events.map((event) => [event.start, event.end, event.kind])));
  assert.ok(result.roomWindows.length >= 1, "room noise windows should be available");
  for (const event of result.events) {
    assert.ok(event.end > event.start);
    assert.ok(event.evidence.seamRmsDb < 0);
    assert.ok(Number.isFinite(event.confidence) && event.confidence > 0.5);
  }
});

test("editing shortens timeline, fills seams from room noise and maps imagery", async () => {
  const wav = await readFile(new URL("../public/demo.wav", import.meta.url));
  const pcm = parseWav(wav);
  const analysis = analyzeAudio(pcm);
  const processed = processAudio(pcm, analysis, { shortenRatio: 0.42, seamMs: 32 });
  assert.ok(processed.pcm.length < pcm.length);
  assert.equal(processed.pcm.channels.length, pcm.channels.length);
  assert.ok(processed.seams.length > 0);
  for (const seam of processed.seams) {
    assert.ok(seam.outputEnd > seam.outputStart);
    assert.ok(seam.seamRmsDb > -80, `seam should carry room tone, got ${seam.seamRmsDb}`);
    assert.ok(seam.seamRmsDb < -20, `seam should match quiet room floor, got ${seam.seamRmsDb}`);
  }
  for (const span of processed.spans) {
    assert.ok(span.outputEnd > span.outputStart);
    if (span.mode === "exact") {
      for (let channel = 0; channel < pcm.channels.length; channel += 1) {
        for (let index = 0; index < span.sourceEnd - span.sourceStart; index += 1) {
          assert.equal(
            processed.pcm.channels[channel][span.outputStart + index],
            pcm.channels[channel][span.sourceStart + index],
          );
        }
      }
    }
  }
  assert.ok(processed.exactSourceSamples > 0);
  assert.ok(processed.modifiedOutputSamples > 0);
});

test("32-bit float WAV is an exact lossless container for rendered samples", async () => {
  const pcm: PcmAudio = {
    sampleRate: 48000,
    length: 2400,
    channels: [new Float32Array(2400), new Float32Array(2400)],
  };
  for (let index = 0; index < pcm.length; index += 1) {
    pcm.channels[0][index] = Math.sin(index * 0.03) * 0.42;
    pcm.channels[1][index] = Math.sin(index * 0.031 + 0.2) * 0.38;
  }
  const encoded = Buffer.from(encodeWavFloat32(pcm));
  const decoded = parseFloatWav(encoded);
  assert.equal(decoded.length, pcm.length);
  assert.ok(measurePeak(decoded) > 0.4);
  for (let channel = 0; channel < 2; channel += 1) {
    for (let index = 0; index < pcm.length; index += 1) {
      assert.equal(decoded.channels[channel][index], pcm.channels[channel][index]);
    }
  }
  assert.ok(measureRmsDb(decoded, 0, decoded.length) < 0);
});

test("manifest records sample-exact edit, seam and untouched ranges", async () => {
  const wav = await readFile(new URL("../public/demo.wav", import.meta.url));
  const pcm = parseWav(wav);
  const analysis = analyzeAudio(pcm);
  const processed = processAudio(pcm, analysis);
  const manifest = createManifest(pcm, analysis, processed, "demo.wav", "abc123");
  assert.equal(manifest.schema, "breath-gate-edit-manifest/v1");
  assert.equal(manifest.events.length, analysis.events.length);
  assert.ok(manifest.events.some((event) => event.removedSamples > 0));
  assert.ok(manifest.seams.every((seam) => seam.outputEndSample > seam.outputStartSample));
  assert.ok(manifest.exactSpans.length > 0);
  assert.equal(manifest.totals.seamCount, processed.seams.length);
  assert.ok(manifest.totals.modifiedOutputSamples > 0);
  assert.equal(
    manifest.totals.exactSourceFrames + manifest.totals.modifiedOutputFrames,
    manifest.output.samplesPerChannel,
  );
  assert.equal(manifest.totals.removedFrames, manifest.source.samplesPerChannel - manifest.output.samplesPerChannel);
  assert.equal(manifest.output.sha256, "abc123");
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("undefined"));
});

test("restore-all resets manual categories and actions", async () => {
  const wav = await readFile(new URL("../public/demo.wav", import.meta.url));
  const analysis = analyzeAudio(parseWav(wav));
  const event = analysis.events.find((item) => item.kind === "clean")!;
  event.kind = "emotional";
  event.action = "fade";
  event.manualKind = "emotional";
  resetAllAutoActions(analysis.events);
  assert.equal(event.kind, event.autoKind);
  assert.equal(event.action, event.autoAction);
  assert.equal(event.manualKind, null);
});

test("fade keeps duration while restore preserves every sample", async () => {
  const wav = await readFile(new URL("../public/demo.wav", import.meta.url));
  const pcm = parseWav(wav);
  const analysis = analyzeAudio(pcm);
  analysis.events.forEach((event) => {
    event.action = "restore";
  });
  const restored = processAudio(pcm, analysis);
  assert.equal(restored.pcm.length, pcm.length);
  assert.equal(restored.modifiedOutputSamples, 0);
  assert.equal(restored.seams.length, 0);
  for (let channel = 0; channel < pcm.channels.length; channel += 1) {
    for (let index = 0; index < pcm.length; index += 1) {
      assert.equal(restored.pcm.channels[channel][index], pcm.channels[channel][index]);
    }
  }

  const fadeEvent = analysis.events.find((event) => event.kind === "clean")!;
  fadeEvent.action = "fade";
  const faded = processAudio(pcm, analysis);
  assert.equal(faded.pcm.length, pcm.length);
  assert.ok(faded.modifiedOutputSamples > 0);
  assert.ok(faded.seams.some((seam) => seam.eventId === fadeEvent.id));
  assert.ok(faded.seams[0].seamRmsDb < -20);
});

function parseFloatWav(buffer: Buffer): PcmAudio {
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const dataLength = buffer.readUInt32LE(40);
  const length = dataLength / (4 * channels);
  const output = Array.from({ length: channels }, () => new Float32Array(length));
  for (let frame = 0; frame < length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      output[channel][frame] = buffer.readFloatLE(44 + (frame * channels + channel) * 4);
    }
  }
  return { sampleRate, length, channels: output };
}
