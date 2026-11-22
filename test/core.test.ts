import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav16, parseWav } from '../src/core/wav.ts';
import { measureLoudness } from '../src/core/loudness.ts';
import { scanSilence } from '../src/core/silence.ts';
import { identifyTrack } from '../src/core/identify.ts';
import { analyzeTracks, prepareTracks } from '../src/core/analyze.ts';
import { buildDialogueFirstMix } from '../src/core/mix.ts';
import { DEFAULT_THRESHOLDS, type DecodedTrack, type PcmBuffer, type TrackKind } from '../src/core/types.ts';

const SR = 48000;

function tone(seconds: number, freq: number, amp: number, leadSilence = 0, tailSilence = 0): PcmBuffer {
  const frames = Math.floor(SR * seconds);
  const lead = Math.floor(SR * leadSilence);
  const tail = Math.floor(SR * tailSilence);
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    if (i < lead || i >= frames - tail) continue;
    channel[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return { sampleRate: SR, channels: [channel] };
}

test('WAV 16-bit round trip preserves sample rate and samples', () => {
  const original = tone(0.5, 440, 0.5);
  const encoded = encodeWav16(original);
  const parsed = parseWav(encoded);
  assert.equal(parsed.sampleRate, SR);
  assert.equal(parsed.channelCount, 1);
  assert.equal(parsed.pcm.channels[0].length, original.channels[0].length);
  assert.ok(Math.abs(parsed.pcm.channels[0][1000] - original.channels[0][1000]) < 1e-4);
});

test('loudness of a loud tone exceeds that of a quiet tone and is finite', () => {
  const loud = measureLoudness(tone(2, 300, 0.5));
  const quiet = measureLoudness(tone(2, 300, 0.05));
  assert.ok(loud.integratedLufs > quiet.integratedLufs);
  assert.ok(Number.isFinite(loud.truePeakDbfs));
  assert.ok(loud.loudnessRange >= 0);
});

test('silence scanner detects head and tail silence', () => {
  const buffer = tone(2, 300, 0.4, 0.5, 0.6);
  const profile = scanSilence(buffer, -50, 40);
  assert.ok(profile.headSilenceSec >= 0.48);
  assert.ok(profile.tailSilenceSec >= 0.58);
});

test('identifier resolves zh, en and music filenames', () => {
  assert.equal(identifyTrack('film_dialogue_zh.wav', 1, true).kind, 'dialogue-zh');
  assert.equal(identifyTrack('movie_dialogue_english.wav', 1, true).kind, 'dialogue-en');
  assert.equal(identifyTrack('score_MnE.wav', 6, true).kind, 'music');
  assert.equal(identifyTrack('random_99.wav', 1, true).kind, 'unknown');
});

function makeTrack(fileName: string, kind: TrackKind, pcm: PcmBuffer): DecodedTrack {
  return {
    fileName,
    kind,
    sampleRate: SR,
    channelCount: pcm.channels.length,
    durationSec: pcm.channels[0].length / SR,
    pcm,
  };
}

test('analyze flags duration, short tail and loudness delta defects', () => {
  const zh = makeTrack('d_zh.wav', 'dialogue-zh', tone(4, 300, 0.12, 0, 0.4));
  const en = makeTrack('d_en.wav', 'dialogue-en', tone(4, 240, 0.11, 0, 0.4));
  const music = makeTrack('m_music.wav', 'music', tone(4, 200, 0.1, 0, 0.4));
  const shortLoud = makeTrack('d_en_bad.wav', 'dialogue-en', tone(2.5, 240, 0.95, 0, 0));
  const report = analyzeTracks(prepareTracks([zh, en, music, shortLoud]), DEFAULT_THRESHOLDS);
  const codes = report.anomalies.map((a) => a.code);
  assert.ok(codes.includes('DURATION_SHORT'));
  assert.ok(codes.includes('TAIL_SILENCE_SHORT'));
  assert.ok(codes.includes('LOUDNESS_TARGET'));
  assert.ok(codes.includes('DUPLICATE_KIND'));
  assert.equal(report.matrix.length, 4);
});

test('clean delivery of the three required roles produces no errors', () => {
  const tracks = [
    makeTrack('a_zh.wav', 'dialogue-zh', tone(4, 300, 0.12, 0, 0.4)),
    makeTrack('b_en.wav', 'dialogue-en', tone(4, 240, 0.11, 0, 0.4)),
    makeTrack('c_music.wav', 'music', tone(4, 200, 0.1, 0, 0.4)),
  ];
  const report = analyzeTracks(prepareTracks(tracks), DEFAULT_THRESHOLDS);
  assert.equal(report.anomalies.filter((a) => a.severity === 'error').length, 0);
});

test('dialogue-first mix ducks the music bed when speech is present', () => {
  const dialogue = tone(3, 300, 0.4);
  const bed = tone(3, 200, 0.4);
  const inputs = [
    { kind: 'dialogue-zh' as TrackKind, pcm: dialogue },
    { kind: 'music' as TrackKind, pcm: bed },
  ];
  const result = buildDialogueFirstMix(inputs, 'dialogue-zh');
  assert.ok(Math.min(...result.duckCurve) < 0.5);
  assert.equal(result.mix.channels.length, 1);
  assert.equal(result.mix.channels[0].length, dialogue.channels[0].length);
});

test('switching language changes mix without altering length', () => {
  const inputs = [
    { kind: 'dialogue-zh' as TrackKind, pcm: tone(2, 300, 0.3) },
    { kind: 'dialogue-en' as TrackKind, pcm: tone(2, 240, 0.3) },
    { kind: 'music' as TrackKind, pcm: tone(2, 200, 0.3) },
  ];
  const zh = buildDialogueFirstMix(inputs, 'dialogue-zh');
  const en = buildDialogueFirstMix(inputs, 'dialogue-en');
  assert.equal(zh.mix.channels[0].length, en.mix.channels[0].length);
  // Different dialogue pitches must change the rendered samples even when
  // the two languages happen to share an energy-driven ducking envelope.
  const sampleIndex = Math.floor(SR * 0.5);
  assert.notEqual(zh.mix.channels[0][sampleIndex], en.mix.channels[0][sampleIndex]);
});
