// Correction: multiplicative gain with adjustable strength and a soft
// highlight shoulder so boosted pixels roll off toward 255 instead of
// clipping. Low-frequency multiplicative gain preserves genuine scene
// gradients (it only removes the lens-induced falloff).

import { samplePlane } from "./gainmap.js";
                                            

                                 
                                                               
                                                          
                                                                  
                                                                 
 

export const DEFAULT_OPTIONS                 = {
  strength: 1,
  shoulder: 0.7,
  knee: 0.85,
  lumaLinked: true,
};

// Soft clip: identity below the knee, exponential roll-off to 255 above it.
// `amount` blends between hard clamp (0) and full shoulder (1).
export function softClip(v        , knee        , amount        )         {
  if (v <= 0) return 0;
  const k = knee * 255;
  let soft        ;
  if (v <= k) {
    soft = v;
  } else {
    const head = 255 - k;
    soft = k + head * (1 - Math.exp(-(v - k) / head));
  }
  const hard = v > 255 ? 255 : v;
  const out = hard + (soft - hard) * amount;
  return out < 0 ? 0 : out > 255 ? 255 : out;
}

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

// Apply the map to an RGBA buffer in place (or into `out` when given).
export function applyCorrection(
  src                   ,
  width        ,
  height        ,
  map         ,
  opts                ,
  out                    ,
)                    {
  const dst = out ?? src;
  const { cols, rows } = map;
  const s = opts.strength;
  const knee = opts.knee;
  const amount = opts.shoulder;
  const linked = opts.lumaLinked;

  // Precompute one gain triplet per column strip to limit sampling cost:
  // gains vary slowly, so per-pixel bilinear on the coarse grid is cheap.
  const g = { r: 1, g: 1, b: 1 };
  for (let y = 0; y < height; y++) {
    const ny = height <= 1 ? 0.5 : y / (height - 1);
    let rowBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      const nx = width <= 1 ? 0.5 : x / (width - 1);
      g.r = samplePlane(map.r, cols, rows, nx, ny);
      g.g = samplePlane(map.g, cols, rows, nx, ny);
      g.b = samplePlane(map.b, cols, rows, nx, ny);
      let gr        , gg        , gb        ;
      if (linked) {
        const gl = 1 + (LUMA_R * g.r + LUMA_G * g.g + LUMA_B * g.b - 1) * s;
        gr = gg = gb = gl;
      } else {
        gr = 1 + (g.r - 1) * s;
        gg = 1 + (g.g - 1) * s;
        gb = 1 + (g.b - 1) * s;
      }
      const i = rowBase + x * 4;
      dst[i] = softClip(src[i] * gr, knee, amount);
      dst[i + 1] = softClip(src[i + 1] * gg, knee, amount);
      dst[i + 2] = softClip(src[i + 2] * gb, knee, amount);
      dst[i + 3] = src[i + 3];
    }
  }
  return dst;
}

// Render the gain map itself as an RGBA heat-style image for preview.
export function renderGainMapImage(map         , width        , height        )                    {
  const out = new Uint8ClampedArray(width * height * 4);
  const g = { r: 1, g: 1, b: 1 };
  for (let y = 0; y < height; y++) {
    const ny = height <= 1 ? 0.5 : y / (height - 1);
    for (let x = 0; x < width; x++) {
      const nx = width <= 1 ? 0.5 : x / (width - 1);
      g.r = samplePlane(map.r, map.cols, map.rows, nx, ny);
      g.g = samplePlane(map.g, map.cols, map.rows, nx, ny);
      g.b = samplePlane(map.b, map.cols, map.rows, nx, ny);
      const l = LUMA_R * g.r + LUMA_G * g.g + LUMA_B * g.b;
      // gain 1 -> black, gain >= maxGain -> white
      const t = Math.min(1, (l - 1) / Math.max(1e-6, map.meta.maxGain - 1));
      const i = (y * width + x) * 4;
      out[i] = Math.round(255 * t);
      out[i + 1] = Math.round(255 * Math.min(1, t * 1.6));
      out[i + 2] = Math.round(255 * Math.max(0, t * 2 - 1));
      out[i + 3] = 255;
    }
  }
  return out;
}
