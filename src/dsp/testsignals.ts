// Deterministic test-signal generators for the comparison suite:
// drum hits, a log sweep, and sustained low frequency content.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function drumHits(fs: number, seconds = 4, hitsPerSecond = 2): Float32Array {
  const n = Math.round(fs * seconds);
  const out = new Float32Array(n);
  const rand = mulberry32(1234);
  const hitLen = Math.round(0.35 * fs);
  const interval = Math.round(fs / hitsPerSecond);
  for (let start = 0; start + hitLen < n; start += interval) {
    const vel = 0.85 + rand() * 0.15;
    for (let i = 0; i < hitLen; i++) {
      const t = i / fs;
      // Kick: pitch-dropping sine with exponential decay.
      const f = 150 * Math.exp(-t * 18) + 48;
      const phase = 2 * Math.PI * f * t;
      const body = Math.sin(phase) * Math.exp(-t * 14);
      // Click: short noise burst for the beater attack.
      const click = i < fs * 0.004 ? (rand() * 2 - 1) * Math.exp(-t * 900) : 0;
      // Snare-ish noise tail on alternate hits.
      const snare = (start / interval) % 2 === 1
        ? (rand() * 2 - 1) * Math.exp(-t * 22) * 0.4
        : 0;
      out[start + i] += vel * (body * 0.9 + click * 0.5 + snare);
    }
  }
  return out;
}

export function logSweep(fs: number, seconds = 6, f0 = 20, f1 = 20000): Float32Array {
  const n = Math.round(fs * seconds);
  const out = new Float32Array(n);
  const k = Math.log(f1 / f0) / seconds;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const phase = 2 * Math.PI * f0 * (Math.exp(k * t) - 1) / k;
    // Gentle fade at both ends to avoid edge clicks.
    const fade = Math.min(1, t / 0.05, (seconds - t) / 0.05);
    out[i] = 0.5 * Math.sin(phase) * fade;
  }
  return out;
}

export function sustainedLow(fs: number, seconds = 4, freq = 55): Float32Array {
  const n = Math.round(fs * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const fade = Math.min(1, t / 0.1, (seconds - t) / 0.1);
    out[i] = fade * (
      0.55 * Math.sin(2 * Math.PI * freq * t) +
      0.2 * Math.sin(2 * Math.PI * freq * 2 * t) +
      0.08 * Math.sin(2 * Math.PI * freq * 3 * t)
    );
  }
  return out;
}

export const TEST_SIGNALS: Record<string, (fs: number) => Float32Array> = {
  drums: (fs) => drumHits(fs),
  sweep: (fs) => logSweep(fs),
  sustainedLow: (fs) => sustainedLow(fs),
};
