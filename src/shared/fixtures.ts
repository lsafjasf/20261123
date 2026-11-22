import type { AudioBufferData, StemId } from './types.ts';

// Synthesizes deterministic stems for self-tests and demos without shipping
// binary assets. Dialogue is an AM-style tone burst, music a sustained chord,
// effects a low-frequency pulse train.
export const synthesizeFixture = (
  sampleRate = 24000,
  durationSec = 6,
): Record<StemId, AudioBufferData> => {
  const length = sampleRate * durationSec;
  const dialogue = new Float32Array(length);
  const music = new Float32Array(length);
  const effects = new Float32Array(length);
  const twoPi = 2 * Math.PI;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    // Speech-like 180-3200 Hz energy gated in 1.2 s phrases.
    const phraseGate = t % 2.4 < 1.2 && t >= 3 ? 1 : 0;
    const syllable = 0.55 + 0.45 * Math.sin(twoPi * 4 * t);
    dialogue[i] =
      phraseGate *
      syllable *
      (0.12 * Math.sin(twoPi * 220 * t) +
        0.08 * Math.sin(twoPi * 900 * t) +
        0.05 * Math.sin(twoPi * 2800 * t));
    // Music grows loud in the second half to create a masking section. Its
    // tones deliberately overlap dialogue formants around 800/2400 Hz.
    const swell = 0.5 + 0.5 * Math.min(1, Math.max(0, (t - 3) / 1.5));
    music[i] =
      swell *
      (0.34 * Math.sin(twoPi * 820 * t) +
        0.26 * Math.sin(twoPi * 2350 * t) +
        0.1 * Math.sin(twoPi * 392 * t));
    // Periodic low-end thumps representing SFX.
    const thumpPhase = t % 1.0;
    const thump = thumpPhase < 0.08 ? Math.exp(-thumpPhase * 30) : 0;
    effects[i] = thump * 0.5 * Math.sin(twoPi * 80 * t);
  }
  const make = (data: Float32Array, label: string): AudioBufferData => ({
    sampleRate,
    channels: [data],
    label,
  });
  return {
    dialogue: make(dialogue, 'dialogue'),
    music: make(music, 'music'),
    effects: make(effects, 'effects'),
  };
};
