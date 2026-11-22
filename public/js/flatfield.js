// Flat-field estimation: average frames of a defocused uniform target,
// reduce to a coarse grid, smooth, and invert into a normalized gain map.

import { createGainMap } from "./gainmap.js";
                                            

                                  
                                                                
                    
                                                                         
                                                                    
                      
                       
                        
 

// Accumulates RGBA frames (Uint8ClampedArray, 4 bytes/px) at a fixed size.
export class FlatAccumulator {
           width        ;
           height        ;
          sum              ; // interleaved rgb per pixel
  frames = 0;

  constructor(width        , height        ) {
    this.width = width;
    this.height = height;
    this.sum = new Float64Array(width * height * 3);
  }

  addFrame(rgba                   )       {
    const n = this.width * this.height;
    if (rgba.length !== n * 4) throw new Error("frame size mismatch");
    const s = this.sum;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const k = i * 3;
      s[k] += rgba[j];
      s[k + 1] += rgba[j + 1];
      s[k + 2] += rgba[j + 2];
    }
    this.frames++;
  }

  reset()       {
    this.sum.fill(0);
    this.frames = 0;
  }

  mean()               {
    if (this.frames === 0) throw new Error("no frames accumulated");
    const out = new Float32Array(this.sum.length);
    for (let i = 0; i < out.length; i++) out[i] = this.sum[i] / this.frames;
    return out;
  }
}

// Block-average the full-res mean image down to the gain grid.
function reduceToGrid(mean              , w        , h        , cols        , rows        , ch        )               {
  const grid = new Float32Array(cols * rows);
  const count = new Float64Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(rows - 1, (y * rows) / h | 0);
    for (let x = 0; x < w; x++) {
      const gx = Math.min(cols - 1, (x * cols) / w | 0);
      const gi = gy * cols + gx;
      grid[gi] += mean[(y * w + x) * 3 + ch];
      count[gi]++;
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] /= Math.max(1, count[i]);
  return grid;
}

function smoothGrid(grid              , cols        , rows        , passes        )               {
  let cur = Float32Array.from(grid);
  const next = new Float32Array(cur.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let acc = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= cols) continue;
            acc += cur[yy * cols + xx];
            cnt++;
          }
        }
        next[y * cols + x] = acc / cnt;
      }
    }
    cur.set(next);
  }
  return cur;
}

// Robust reference level: mean of the brightest quartile of grid cells.
function referenceLevel(grid              )         {
  const sorted = Float32Array.from(grid).sort();
  const start = Math.floor(sorted.length * 0.75);
  let acc = 0;
  for (let i = start; i < sorted.length; i++) acc += sorted[i];
  return acc / (sorted.length - start);
}

export function estimateGainMap(acc                 , opts                  = {})          {
  const cols = opts.gridCols ?? 64;
  const rows = opts.gridRows ?? 36;
  const maxGain = opts.maxGain ?? 8;
  const passes = opts.smoothPasses ?? 1;
  const mean = acc.mean();
  const { width: w, height: h } = acc;

  const map = createGainMap(cols, rows, {
    name: opts.sourceName ?? "flat-field",
    sourceWidth: opts.sourceWidth ?? w,
    sourceHeight: opts.sourceHeight ?? h,
    frames: acc.frames,
    maxGain,
  });

  const planes = [map.r, map.g, map.b];
  for (let ch = 0; ch < 3; ch++) {
    let grid = reduceToGrid(mean, w, h, cols, rows, ch);
    grid = smoothGrid(grid, cols, rows, passes);
    const ref = referenceLevel(grid);
    const plane = planes[ch];
    for (let i = 0; i < plane.length; i++) {
      const v = grid[i];
      // Floor at ref/maxGain keeps gain finite even in near-black corners.
      plane[i] = ref / Math.max(v, ref / maxGain, 1e-3);
    }
  }
  return map;
}
