import { projectDuration } from "./content.ts";
import type { Project } from "./types.ts";

const SAMPLE_RATE = 48000;

function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export async function renderSoundtrack(project: Project): Promise<AudioBuffer> {
  const duration = projectDuration(project);
  const context = new OfflineAudioContext(1, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  const master = context.createGain();
  master.gain.value = 3.2;
  master.connect(context.destination);

  const roomNoise = context.createBuffer(1, context.length, SAMPLE_RATE);
  const noise = seededNoise(0x4f46464c);
  const data = roomNoise.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = (noise() * 2 - 1) * 0.018;
  }
  const room = context.createBufferSource();
  const roomFilter = context.createBiquadFilter();
  roomFilter.type = "lowpass";
  roomFilter.frequency.value = 900;
  room.buffer = roomNoise;
  room.connect(roomFilter).connect(master);
  room.start(0);

  const chords = [
    [146.83, 220, 293.66],
    [130.81, 196, 261.63],
    [174.61, 261.63, 349.23],
    [130.81, 196, 329.63],
    [146.83, 220, 293.66],
    [110, 164.81, 261.63],
  ];
  project.shots.forEach((shot, index) => {
    const chord = chords[index % chords.length];
    chord.forEach((frequency, voice) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = voice === 0 ? "sine" : "triangle";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, Math.max(0, shot.start - 0.1));
      gain.gain.linearRampToValueAtTime(0.018, shot.start + 0.5);
      gain.gain.setValueAtTime(0.018, Math.max(shot.start + 0.5, shot.end - 0.4));
      gain.gain.linearRampToValueAtTime(0, shot.end + 0.1);
      osc.connect(gain).connect(master);
      osc.start(Math.max(0, shot.start - 0.1));
      osc.stop(Math.min(duration, shot.end + 0.12));
    });

    const syllables = Math.max(6, Math.floor((shot.end - shot.start) * 4.1));
    for (let i = 0; i < syllables; i += 1) {
      const at = shot.start + 0.25 + (i / syllables) * (shot.end - shot.start - 0.5);
      const osc = context.createOscillator();
      const formant = context.createBiquadFilter();
      const gain = context.createGain();
      osc.type = shot.person === "lin" ? "sawtooth" : "triangle";
      osc.frequency.setValueAtTime(118 + (i % 4) * 11, at);
      osc.frequency.linearRampToValueAtTime(132 + (i % 3) * 14, at + 0.12);
      formant.type = "bandpass";
      formant.frequency.value = 520 + ((i * 173) % 620);
      formant.Q.value = 3.2;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.033, at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(formant).connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + 0.2);
    }
  });

  return context.startRendering();
}

export function waveformPeaks(buffer: AudioBuffer, count: number): number[] {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / count));
  const peaks: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let peak = 0;
    const start = i * step;
    for (let j = 0; j < step && start + j < data.length; j += 12) {
      peak = Math.max(peak, Math.abs(data[start + j]));
    }
    peaks.push(peak);
  }
  const max = Math.max(0.001, ...peaks);
  return peaks.map((value) => value / max);
}
