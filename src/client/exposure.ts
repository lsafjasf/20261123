// Exposure analysis: measure per-frame EV, split into a slow day/night
// trend (kept) and fast flicker (smoothed away).

// Mean log2 luminance of the lower (ground) region of an RGBA frame.
export function measureEv(src: Uint8ClampedArray, w: number, h: number, y0Frac = 0.55): number {
  const y0 = Math.floor(h * y0Frac);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
      sum += Math.log2(Math.max(lum, 1) / 255);
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Sliding-window median (odd window), edges clamped.
export function medianFilter(series: number[], radius: number): number[] {
  const n = series.length;
  const out = new Array<number>(n);
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) win.push(series[j]);
    win.sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

export interface ExposurePlan {
  evRaw: number[];
  evTrend: number[];
  corrections: number[]; // EV gain to apply per frame
}

// Decompose raw EV into trend + flicker. Correction removes only flicker,
// so genuine day/night swings survive in the output.
export function planCorrections(evRaw: number[], maxCorrectionEv = 1.5): ExposurePlan {
  const n = evRaw.length;
  const radius = Math.max(2, Math.round(n * 0.08)); // wide window = "real" change
  const trend = medianFilter(evRaw, radius);
  const corrections = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const flicker = evRaw[i] - trend[i];
    corrections[i] = Math.max(-maxCorrectionEv, Math.min(maxCorrectionEv, -flicker));
  }
  return { evRaw, evTrend: trend, corrections };
}

// Canvas CSS filter string for a given EV gain.
export function evToBrightness(ev: number): string {
  return `brightness(${Math.pow(2, ev).toFixed(4)})`;
}
