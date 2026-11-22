// Test matrix definition: codec x resolution x fps x chroma x bitrate.
// The matrix is fully deterministic: same inputs always yield the same
// ordered list of configs and the same config ids.

export type ChromaFormat = 'I420' | 'NV12' | 'I422' | 'I444';

export interface CodecVariant {
  id: string;
  codecString: string;
  // avc format hint for WebCodecs; 'avc' gives us a description for muxing.
  avcFormat?: 'avc' | 'annexb';
  // Whether the encoded stream can be muxed into fMP4 for the MSE check.
  mp4Muxable: boolean;
}

export interface TestConfig {
  id: string;
  codec: string;
  codecString: string;
  width: number;
  height: number;
  fps: number;
  chroma: ChromaFormat;
  bitrateKbps: number;
  frames: number;
  avcFormat?: 'avc' | 'annexb';
  mp4Muxable: boolean;
}

export const CODEC_VARIANTS: CodecVariant[] = [
  { id: 'avc1-bl', codecString: 'avc1.42001f', avcFormat: 'avc', mp4Muxable: true },
  { id: 'avc1-hi', codecString: 'avc1.640028', avcFormat: 'avc', mp4Muxable: true },
  { id: 'hev1', codecString: 'hev1.1.6.L93.B0', mp4Muxable: true },
  { id: 'vp09', codecString: 'vp09.00.10.08', mp4Muxable: true },
  { id: 'av01', codecString: 'av01.0.04M.08', mp4Muxable: true },
  { id: 'vp8', codecString: 'vp8', mp4Muxable: false },
];

export const RESOLUTIONS: Array<[number, number]> = [
  [320, 180],
  [1280, 720],
  [1920, 1080],
];

export const FPS_VALUES: number[] = [24, 30, 60];

export const CHROMA_FORMATS: ChromaFormat[] = ['I420', 'NV12', 'I422', 'I444'];

// Roughly 2.5 Mbit/s per megapixel per frame at 30fps, scaled by fps.
export function defaultBitrateKbps(width: number, height: number, fps: number): number {
  const mp = (width * height) / 1_000_000;
  return Math.max(128, Math.round(mp * 2500 * (fps / 30)));
}

export function configId(
  codecId: string,
  width: number,
  height: number,
  fps: number,
  chroma: ChromaFormat,
  bitrateKbps: number,
): string {
  return `${codecId}_${width}x${height}_${fps}fps_${chroma.toLowerCase()}_${bitrateKbps}k`;
}

export interface MatrixOptions {
  full: boolean;
  frames: number;
  only?: string;
}

// Default matrix: every codec at every resolution with a rotating
// (fps, chroma) pair, plus an explicit sweep of fps and chroma at 720p
// for the first codec variant. --full expands to the whole cross product.
export function buildMatrix(opts: MatrixOptions): TestConfig[] {
  const out: TestConfig[] = [];
  const seen = new Set<string>();
  const push = (
    variant: CodecVariant,
    width: number,
    height: number,
    fps: number,
    chroma: ChromaFormat,
    bitrateKbps: number,
  ) => {
    const id = configId(variant.id, width, height, fps, chroma, bitrateKbps);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      codec: variant.id,
      codecString: variant.codecString,
      width,
      height,
      fps,
      chroma,
      bitrateKbps,
      frames: opts.frames,
      avcFormat: variant.avcFormat,
      mp4Muxable: variant.mp4Muxable,
    });
  };

  for (const variant of CODEC_VARIANTS) {
    for (let resIndex = 0; resIndex < RESOLUTIONS.length; resIndex++) {
      const [width, height] = RESOLUTIONS[resIndex];
      if (opts.full) {
        for (const fps of FPS_VALUES) {
          for (const chroma of CHROMA_FORMATS) {
            push(variant, width, height, fps, chroma, defaultBitrateKbps(width, height, fps));
          }
        }
      } else {
        const fps = FPS_VALUES[resIndex % FPS_VALUES.length];
        push(variant, width, height, fps, CHROMA_FORMATS[0], defaultBitrateKbps(width, height, fps));
      }
    }
    if (!opts.full) {
      // Focused sweeps at 720p so every fps and chroma value is covered.
      for (const fps of FPS_VALUES) {
        push(variant, 1280, 720, fps, 'I420', defaultBitrateKbps(1280, 720, fps));
      }
      for (const chroma of CHROMA_FORMATS) {
        push(variant, 1280, 720, 30, chroma, defaultBitrateKbps(1280, 720, 30));
      }
    }
  }

  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (opts.only !== undefined) {
    return out.filter((c) => c.id === opts.only);
  }
  return out;
}
