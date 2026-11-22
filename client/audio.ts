import type { SegmentDescriptor } from "./types.js";

const SAMPLE_RATE = 48_000;

const SCALES: number[][] = [
  [220.0, 261.63, 329.63, 392.0],
  [246.94, 293.66, 369.99, 440.0],
  [261.63, 329.63, 392.0, 493.88],
  [196.0, 246.94, 293.66, 392.0],
];

export async function renderSegmentAudio(segment: SegmentDescriptor): Promise<Float32Array> {
  const durationSeconds = segment.durationMs / 1000;
  const context = new OfflineAudioContext(1, Math.round(SAMPLE_RATE * durationSeconds), SAMPLE_RATE);
  const master = context.createGain();
  master.gain.value = 0.16;
  master.connect(context.destination);

  const pad = context.createOscillator();
  const padGain = context.createGain();
  pad.type = "sine";
  pad.frequency.value = SCALES[(segment.ordinal - 1) % SCALES.length]?.[0] ?? 220;
  padGain.gain.setValueAtTime(0.08, 0);
  padGain.gain.linearRampToValueAtTime(0.16, 0.4);
  padGain.gain.linearRampToValueAtTime(0.04, durationSeconds);
  pad.connect(padGain).connect(master);
  pad.start(0);
  pad.stop(durationSeconds);

  const scale = SCALES[(segment.ordinal - 1) % SCALES.length] ?? SCALES[0] ?? [220];
  const noteInterval = 0.48;
  for (let index = 0; index < Math.floor(durationSeconds / noteInterval); index += 1) {
    const start = 0.12 + index * noteInterval;
    if (start >= durationSeconds - 0.12) {
      break;
    }
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = index % 2 === 0 ? "triangle" : "sine";
    oscillator.frequency.value = scale[index % scale.length] ?? 220;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(0.22, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.001, start + 0.33);
    oscillator.connect(envelope).connect(master);
    oscillator.start(start);
    oscillator.stop(start + 0.36);
  }

  if (segment.rotation === "rotated") {
    const chime = context.createOscillator();
    const chimeGain = context.createGain();
    chime.type = "sine";
    chime.frequency.setValueAtTime(523.25, 0.05);
    chime.frequency.exponentialRampToValueAtTime(783.99, 0.42);
    chimeGain.gain.setValueAtTime(0, 0.05);
    chimeGain.gain.linearRampToValueAtTime(0.3, 0.08);
    chimeGain.gain.exponentialRampToValueAtTime(0.001, 0.6);
    chime.connect(chimeGain).connect(master);
    chime.start(0.05);
    chime.stop(0.62);
  }

  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice();
}

export const AUDIO_SAMPLE_RATE = SAMPLE_RATE;
export const AUDIO_CHANNELS = 1;
