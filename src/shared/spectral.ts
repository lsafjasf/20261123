import { fftRadix2, hannWindow } from './dsp-math.ts';
import { ANALYSIS_BANDS, ANALYSIS_CONFIG } from './devices.ts';
import type { StemId } from './types.ts';

export interface StemFrameBands {
  timeSec: number;
  // Linear mean-square power per analysis band, one row per stem.
  stemBandPower: Record<StemId, Float32Array>;
}

const bandBinRanges = (
  fftSize: number,
  sampleRate: number,
): Array<{ start: number; end: number }> => {
  const binHz = sampleRate / fftSize;
  return ANALYSIS_BANDS.map((band) => {
    const start = Math.max(1, Math.floor(band.lowHz / binHz));
    const end = Math.min(fftSize / 2, Math.ceil(band.highHz / binHz));
    return { start, end: Math.max(start + 1, end) };
  });
};

// Hann-windowed STFT collapsed into the fixed analysis bands. Power values are
// normalized by window energy so different frame sizes stay comparable.
export const computeBandFrames = (
  stems: Record<StemId, Float32Array>,
  sampleRate: number,
): StemFrameBands[] => {
  const fftSize = ANALYSIS_CONFIG.fftSize;
  const hop = Math.max(1, Math.round(sampleRate * ANALYSIS_CONFIG.hopSec));
  const window = hannWindow(fftSize);
  let windowEnergy = 0;
  for (let i = 0; i < fftSize; i += 1) windowEnergy += window[i] * window[i];
  const ranges = bandBinRanges(fftSize, sampleRate);
  const length = stems.dialogue?.length ?? stems.music?.length ?? stems.effects?.length ?? 0;
  if (length === 0) return [];
  const frames: StemFrameBands[] = [];
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const stemIds = Object.keys(stems) as StemId[];

  for (let frameStart = 0; frameStart + fftSize <= length; frameStart += hop) {
    const stemBandPower = {} as Record<StemId, Float32Array>;
    for (const stemId of stemIds) {
      const signal = stems[stemId];
      real.fill(0);
      imag.fill(0);
      for (let i = 0; i < fftSize; i += 1) {
        real[i] = (signal[frameStart + i] ?? 0) * window[i];
      }
      fftRadix2(real, imag);
      const bands = new Float32Array(ANALYSIS_BANDS.length);
      for (let band = 0; band < ranges.length; band += 1) {
        let power = 0;
        const { start, end } = ranges[band];
        for (let bin = start; bin < end; bin += 1) {
          power += real[bin] * real[bin] + imag[bin] * imag[bin];
        }
        bands[band] = power / windowEnergy / (end - start);
      }
      stemBandPower[stemId] = bands;
    }
    frames.push({
      timeSec: (frameStart + fftSize / 2) / sampleRate,
      stemBandPower,
    });
  }
  return frames;
};

