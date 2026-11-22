                                        
                                         

/** Deterministic PRNG so repairs are reproducible across runs. */
export function mulberry32(seed        )               {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Inpaint masked pixels by iterative diffusion from the surrounding
 * unmasked picture, restricted to the blob bounding box plus margin.
 * Scratches (thin vertical boxes) use horizontal interpolation only.
 */
export function inpaint(
  frame       , blob      , margin = 3, iterations = 24,
)       {
  const { width: w, height: h, rgba } = frame;
  const vertical = blob.kind === "scratch";
  const x0 = Math.max(0, blob.bbox.x - margin);
  const y0 = Math.max(0, blob.bbox.y - margin);
  const x1 = Math.min(w - 1, blob.bbox.x + blob.bbox.w - 1 + margin);
  const y1 = Math.min(h - 1, blob.bbox.y + blob.bbox.h - 1 + margin);
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;

  const masked = new Uint8Array(rw * rh);
  for (const i of blob.pixels) {
    const lx = (i % w) - x0, ly = ((i / w) | 0) - y0;
    masked[ly * rw + lx] = 1;
  }
  const region = new Float32Array(rw * rh * 3);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const s = ((y0 + y) * w + (x0 + x)) * 4;
      const d = (y * rw + x) * 3;
      region[d] = rgba[s];
      region[d + 1] = rgba[s + 1];
      region[d + 2] = rgba[s + 2];
    }
  }
  // Seed masked pixels with a directional edge estimate.
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!masked[y * rw + x]) continue;
      const d = (y * rw + x) * 3;
      for (let c = 0; c < 3; c++) {
        if (vertical) {
          const l = x > 0 && !masked[y * rw + x - 1] ? region[d - 3 + c] : NaN;
          const r = x < rw - 1 && !masked[y * rw + x + 1] ? region[d + 3 + c] : NaN;
          region[d + c] = !isNaN(l) && !isNaN(r) ? 0.5 * (l + r)
            : !isNaN(l) ? l : !isNaN(r) ? r : 128;
        } else {
          let acc = 0, n = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= rw || yy >= rh) continue;
            if (masked[yy * rw + xx]) continue;
            acc += region[(yy * rw + xx) * 3 + c]; n++;
          }
          region[d + c] = n ? acc / n : 128;
        }
      }
    }
  }
  // Relaxation passes.
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (!masked[y * rw + x]) continue;
        const d = (y * rw + x) * 3;
        for (let c = 0; c < 3; c++) {
          let acc = 0, n = 0;
          const dirs = vertical ? [[1, 0], [-1, 0]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (const [dx, dy] of dirs) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= rw || yy >= rh) continue;
            acc += region[(yy * rw + xx) * 3 + c]; n++;
          }
          if (n) region[d + c] = acc / n;
        }
      }
    }
  }
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!masked[y * rw + x]) continue;
      const s = ((y0 + y) * w + (x0 + x)) * 4;
      const d = (y * rw + x) * 3;
      rgba[s] = region[d];
      rgba[s + 1] = region[d + 1];
      rgba[s + 2] = region[d + 2];
    }
  }
}

/**
 * Re-inject grain inside repaired pixels only. Inpainting smooths the
 * picture; without this step the patch would look plasticky against the
 * surrounding film grain. Noise sigma matches the local pre-repair
 * grain, scaled by the grainPreservation factor.
 */
export function regrain(
  frame       , blob      , sigma        , preservation        ,
)       {
  if (sigma <= 0 || preservation <= 0) return;
  const { width: w, rgba } = frame;
  const rand = mulberry32((frame.index + 1) * 2654435761);
  const amp = sigma * preservation;
  // Box-Muller, one pair cached.
  let spare = NaN;
  const gauss = ()         => {
    if (!isNaN(spare)) { const v = spare; spare = NaN; return v; }
    let u = 0, v = 0;
    while (u === 0) u = rand();
    v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  for (const i of blob.pixels) {
    const p = i * 4;
    const n = gauss() * amp;
    rgba[p] = clamp8(rgba[p] + n);
    rgba[p + 1] = clamp8(rgba[p + 1] + n);
    rgba[p + 2] = clamp8(rgba[p + 2] + n);
  }
  void w;
}

function clamp8(v        )         {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
