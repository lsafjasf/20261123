import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BEAT_CONFIG,
  detectBeats,
  estimatePeriod,
  onsetCurve,
  energyEnvelope,
} from "../src/audio/dsp.ts";
import { DEFAULT_VAD, detectSpeech, downmixToMono } from "../src/core/speech.ts";
import { buildDemoTrack } from "../src/audio/demo.ts";

const SR = 22050;

function pulseTrain(bpm: number, duration: number, sampleRate: number): Float32Array {
  const pcm = new Float32Array(Math.round(duration * sampleRate));
  const period = 60 / bpm;
  for (let t = 0; t < duration; t += period) {
    const start = Math.round(t * sampleRate);
    for (let i = 0; i < sampleRate * 0.05 && start + i < pcm.length; i++) {
      const env = Math.exp(-i / (sampleRate * 0.01));
      pcm[start + i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * env;
    }
  }
  return pcm;
}

test("estimatePeriod 恢复已知 BPM", () => {
  const pcm = pulseTrain(120, 12, SR);
  const envelope = energyEnvelope(pcm, SR, DEFAULT_BEAT_CONFIG);
  const onset = onsetCurve(envelope);
  const { bpm } = estimatePeriod(onset, DEFAULT_BEAT_CONFIG.hopSize, DEFAULT_BEAT_CONFIG);
  assert.ok(Math.abs(bpm - 120) < 4, `检测 BPM=${bpm}`);
});

test("detectBeats 输出单调时间与重拍标记", () => {
  const pcm = pulseTrain(100, 10, SR);
  const beats = detectBeats(pcm, SR);
  assert.ok(beats.length > 8);
  for (let i = 1; i < beats.length; i++) {
    assert.ok(beats[i].time > beats[i - 1].time);
  }
  assert.ok(beats.some((b) => b.downbeat));
});

test("detectSpeech 找到高能说话段并忽略底噪", () => {
  const duration = 6;
  const pcm = new Float32Array(duration * SR);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() - 0.5) * 0.01;
  const spanStart = 2;
  const spanEnd = 3.6;
  for (let i = spanStart * SR; i < spanEnd * SR; i++) {
    pcm[i] += Math.sin((2 * Math.PI * 200 * i) / SR) * 0.4;
  }
  const spans = detectSpeech(pcm, SR, DEFAULT_VAD);
  assert.equal(spans.length, 1);
  assert.ok(spans[0].start <= spanStart + 0.25);
  assert.ok(spans[0].end >= spanEnd - 0.25);
});

test("downmixToMono 平均多声道", () => {
  const mono = downmixToMono([new Float32Array([0.2, 0.8]), new Float32Array([0.4, 0.2])]);
  assert.ok(Math.abs(mono[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(mono[1] - 0.5) < 1e-6);
});

test("demo 合成轨的节拍与说话区间可被检测", () => {
  const demo = buildDemoTrack();
  // WAV 44 字节头，PCM16 立体声。
  const view = new DataView(demo.wav.buffer, demo.wav.byteOffset);
  const frameCount = view.getUint32(40, true) / 4;
  const pcm = new Float32Array(frameCount);
  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    const l = view.getInt16(offset, true) / 0x8000;
    const r = view.getInt16(offset + 2, true) / 0x8000;
    pcm[i] = (l + r) / 2;
    offset += 4;
  }
  const beats = detectBeats(pcm, demo.sampleRate);
  const speech = detectSpeech(pcm, demo.sampleRate);
  assert.ok(beats.length > 20, `demo 节拍数 ${beats.length}`);
  assert.equal(speech.length, demo.speechTruth.length);
  for (let i = 0; i < speech.length; i++) {
    assert.ok(Math.abs(speech[i].start - demo.speechTruth[i].start) < 0.4);
    assert.ok(Math.abs(speech[i].end - demo.speechTruth[i].end) < 0.4);
  }
});
