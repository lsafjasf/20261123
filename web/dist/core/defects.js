                                                   

                       
                                                     
             
               
                   
                     
 

/** 4-connected components over a binary mask, min-area filtered. */
export function connectedComponents(
  mask            , w        , h        , minArea        ,
)         {
  const seen = new Uint8Array(mask.length);
  const blobs         = [];
  const stack           = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const pix           = [];
    stack.push(s);
    seen[s] = 1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (stack.length) {
      const i = stack.pop()          ;
      pix.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (pix.length < minArea) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const elongation = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    blobs.push({
      pixels: Uint32Array.from(pix),
      bbox: { x: x0, y: y0, w: bw, h: bh },
      area: pix.length,
      kind: "dust",
      elongation,
    });
  }
  return blobs;
}

/**
 * Classify a blob:
 *  - scratch: thin, tall, near-vertical structure
 *  - hair:    elongated curvy structure
 *  - dust:    compact blob
 */
export function classify(blob      , frameHeight        )             {
  const { w, h } = blob.bbox;
  const vertical = h >= 3 * w && h >= Math.min(24, frameHeight * 0.15);
  if (vertical && w <= 4) return "scratch";
  if (blob.elongation >= 3 && blob.area >= 6) return "hair";
  return "dust";
}

/**
 * Does this blob coincide with a structure in the long-term reference?
 * If the line is visible in the long-term median it may be picture
 * content, so it must be locked instead of repaired.
 */
export function presentInReference(
  blob      , reference              , w        , thr        ,
)          {
  let hits = 0;
  for (const i of blob.pixels) {
    const x = i % w;
    const left = x > 2 ? reference[i - 3] : reference[i];
    const right = x < w - 3 ? reference[i + 3] : reference[i];
    const flank = 0.5 * (left + right);
    if (Math.abs(reference[i] - flank) > thr) hits++;
  }
  return hits / blob.pixels.length > 0.6;
}

                             
             
             
                      
                   
                  
 

/**
 * Persistent vertical scratch detection against the long-term reference
 * (the local temporal median cannot see a scratch that sits in most
 * frames of its window). A pixel only joins the run if its horizontal
 * flanks are clean, so objects crossing the line are not eaten.
 */
export function scratchRuns(
  cur              , ref              , w        , h        ,
  thr        , maxWidth        , coverFrac        ,
)               {
  const colHit = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) {
      if (Math.abs(cur[y * w + x] - ref[y * w + x]) > thr) c++;
    }
    if (c > coverFrac * h) colHit[x] = 1;
  }
  const runs               = [];
  let x = 0;
  while (x < w) {
    if (!colHit[x]) { x++; continue; }
    let x1 = x;
    while (x1 + 1 < w && colHit[x1 + 1]) x1++;
    const runW = x1 - x + 1;
    if (runW <= maxWidth) {
      const fd = runW + 2;
      const pix           = [];
      let devSum = 0;
      for (let xx = x; xx <= x1; xx++) {
        for (let y = 0; y < h; y++) {
          const i = y * w + xx;
          const dev = Math.abs(cur[i] - ref[i]);
          if (dev <= thr) continue;
          // Crossing-object guard: flanks must be clean in a small
          // vertical window, otherwise this is an object edge on the
          // line, not the line itself.
          let flankDirty = false;
          for (let dy = -2; dy <= 2 && !flankDirty; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            const row = yy * w + xx;
            if (xx - fd >= 0 && Math.abs(cur[row - fd] - ref[row - fd]) > thr) flankDirty = true;
            if (xx + fd < w && Math.abs(cur[row + fd] - ref[row + fd]) > thr) flankDirty = true;
          }
          if (flankDirty) continue;
          pix.push(i);
          devSum += dev;
        }
      }
      if (pix.length > 0.3 * h) {
        runs.push({
          x0: x, x1,
          pixels: Uint32Array.from(pix),
          coverage: pix.length / (runW * h),
          meanDev: devSum / pix.length,
        });
      }
    }
    x = x1 + 1;
  }
  return runs;
}

/**
 * Vertical lines present in the long-term reference itself. These are
 * ambiguous — scratch or picture content — and must be locked, never
 * repaired. Returns column groups [{x0, x1}].
 */
export function referenceLines(
  ref              , w        , h        ,
  thr        , maxWidth        ,
)                               {
  const colHit = new Uint8Array(w);
  for (let x = 3; x < w - 3; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      // Both flanks must differ: a single-sided check would also fire
      // on clean columns 3px beside a real line (phantom hits).
      const dl = Math.abs(ref[i] - ref[i - 3]);
      const dr = Math.abs(ref[i] - ref[i + 3]);
      if (Math.min(dl, dr) > thr) c++;
    }
    if (c > 0.5 * h) colHit[x] = 1;
  }
  const lines                               = [];
  let x = 0;
  while (x < w) {
    if (!colHit[x]) { x++; continue; }
    let x1 = x;
    while (x1 + 1 < w && colHit[x1 + 1]) x1++;
    if (x1 - x + 1 <= maxWidth) lines.push({ x0: x, x1 });
    x = x1 + 1;
  }
  return lines;
}

/** How much of a column group shows a vertical line in this frame. */
export function lineVisibility(
  cur              , w        , h        ,
  x0        , x1        , thr        ,
)         {
  let hit = 0, total = 0;
  for (let x = x0; x <= x1; x++) {
    if (x < 3 || x >= w - 3) continue;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      const dl = Math.abs(cur[i] - cur[i - 3]);
      const dr = Math.abs(cur[i] - cur[i + 3]);
      total++;
      if (Math.min(dl, dr) > thr) hit++;
    }
  }
  return total ? hit / total : 0;
}

/** Confidence that a candidate is a true defect, not picture content. */
export function confidence(
  blob      , cur              , med              , sigma        ,
)         {
  let sum = 0;
  for (const i of blob.pixels) sum += Math.abs(cur[i] - med[i]);
  const mean = sum / blob.pixels.length;
  const snr = mean / Math.max(1e-3, sigma * 6);
  let c = Math.min(1, snr);
  if (blob.kind === "scratch") {
    const straight = blob.area / (blob.bbox.h * blob.bbox.w);
    c *= 0.6 + 0.4 * Math.min(1, straight * 2);
  }
  return Math.round(c * 1000) / 1000;
}
