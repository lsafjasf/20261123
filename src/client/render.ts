// Offline mixdown of the whole foley track + WAV encoding (no deps).

import { triggerSample, type CueList } from '../shared/cuelist.ts';
import { sampleToSeconds } from '../shared/timebase.ts';
import { scheduleSound } from './synth.ts';

/** Render every cue into one AudioBuffer at the list's sample rate. */
export async function renderMix(list: CueList, tailSeconds = 3): Promise<AudioBuffer> {
  const sr = list.sampleRate;
  const last = list.cues.reduce((m, c) => Math.max(m, triggerSample(c, list)), 0);
  const length = Math.max(1, last + Math.ceil(tailSeconds * sr));
  const offline = new OfflineAudioContext(2, length, sr);
  const master = offline.createGain();
  master.connect(offline.destination);
  list.cues.forEach((cue, i) => {
    const when = sampleToSeconds(triggerSample(cue, list), sr);
    scheduleSound(offline, master, cue.sound, when, cue.gain, hashSeed(cue.id, i));
  });
  return offline.startRendering();
}

export function hashSeed(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 16-bit PCM WAV. */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return out;
}
