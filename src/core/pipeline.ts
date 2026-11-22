import type {
  Frame, FrameReport, LockedLine, Manifest, MaskEntry, PipelineOptions,
} from "./types.ts";
import { defaultOptions } from "./types.ts";
import {
  toLuma, temporalMedian, noiseSigma, localGrain,
  defectCandidates, motionMask,
} from "./analyze.ts";
import {
  connectedComponents, classify, presentInReference, confidence,
  scratchRuns, referenceLines, lineVisibility,
} from "./defects.ts";
import type { Blob } from "./defects.ts";
import { inpaint, regrain } from "./repair.ts";

export interface PipelineResult {
  frames: Frame[];       // repaired copies; inputs are never mutated
  manifest: Manifest;
  masks: Map<number, Uint8Array>; // frame index -> binary repair mask
}

export function timecode(frame: number, fps: number): string {
  const f = frame % fps;
  const s = Math.floor(frame / fps) % 60;
  const m = Math.floor(frame / (fps * 60)) % 60;
  const h = Math.floor(frame / (fps * 3600));
  const p = (v: number): string => String(v).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

function ringGrain(
  luma: Float32Array, w: number, h: number, blob: Blob, margin: number,
): number {
  const x0 = Math.max(0, blob.bbox.x - margin);
  const y0 = Math.max(0, blob.bbox.y - margin);
  const bw = Math.min(w, blob.bbox.x + blob.bbox.w + margin) - x0;
  const bh = Math.min(h, blob.bbox.y + blob.bbox.h + margin) - y0;
  const ring = new Uint8Array(w * h);
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) ring[y * w + x] = 1;
  }
  for (const i of blob.pixels) ring[i] = 0;
  return localGrain(luma, w, h, ring, { x: x0, y: y0, w: bw, h: bh });
}

function overlap(
  plane: Float32Array, med: Float32Array, pixels: Uint32Array, thr: number,
): boolean {
  let hits = 0;
  for (const i of pixels) {
    if (Math.abs(plane[i] - med[i]) > thr) hits++;
  }
  return hits / pixels.length > 0.5;
}

function makeEntry(
  frameIndex: number, slot: number, blob: Blob,
  cur: Float32Array, med: Float32Array, sigma: number,
): MaskEntry {
  return {
    id: `F${String(frameIndex).padStart(4, "0")}-M${slot}`,
    kind: blob.kind,
    bbox: blob.bbox,
    area: blob.area,
    confidence: confidence(blob, cur, med, sigma),
    decision: "repaired",
    temporal: { inPrev: false, inNext: false, persistence: 0 },
    grainBefore: 0,
    grainAfter: 0,
  };
}

export function runPipeline(
  input: Frame[], name: string, partial?: Partial<PipelineOptions>,
): PipelineResult {
  const opts: PipelineOptions = { ...defaultOptions(), ...partial };
  const n = input.length;
  const { width: w, height: h } = input[0];
  const lumas = input.map(toLuma);

  // Long-term reference from up to 21 evenly spaced frames.
  const step = Math.max(1, Math.floor(n / 21));
  const refPlanes: Float32Array[] = [];
  for (let i = 0; i < n; i += step) refPlanes.push(lumas[i]);
  const reference = temporalMedian(refPlanes);
  const refSigma = Math.max(0.5, noiseSigma(reference, w, h));
  const lineThr = Math.max(opts.minDelta, opts.sigmaK * refSigma);

  // Ambiguous vertical lines in the long-term reference: locked, listed.
  const lockedLines: LockedLine[] = [];
  const lockedCenters: number[] = [];
  for (const ln of referenceLines(reference, w, h, lineThr, opts.scratchMaxWidth)) {
    const center = (ln.x0 + ln.x1) >> 1;
    lockedCenters.push(center);
    const visible: number[] = [];
    for (let t = 0; t < n; t++) {
      if (lineVisibility(lumas[t], w, h, ln.x0, ln.x1, lineThr) > 0.5) {
        visible.push(input[t].index);
      }
    }
    const coverage = visible.length / n;
    if (coverage >= 0.9) continue; // stable scene content, silently locked
    if (coverage >= opts.lockPersistence) {
      lockedLines.push({
        x: center,
        frames: visible,
        reason: "vertical line present in long-term reference; locked as picture content",
      });
    }
  }

  const outFrames: Frame[] = [];
  const reports: FrameReport[] = [];
  const masks = new Map<number, Uint8Array>();
  let repairedMasks = 0, lockedMasks = 0, skippedMotion = 0;

  for (let t = 0; t < n; t++) {
    const src = input[t];
    const out: Frame = {
      index: src.index, width: w, height: h,
      rgba: new Uint8ClampedArray(src.rgba),
    };
    outFrames.push(out);
    const report: FrameReport = {
      frame: src.index,
      timecode: timecode(src.index, opts.fps),
      disabled: false, manualEdit: false, masks: [],
    };
    reports.push(report);
    if (opts.disabledFrames.has(src.index)) {
      report.disabled = true;
      continue;
    }

    const r = opts.windowRadius;
    const lo = Math.max(0, t - r), hi = Math.min(n - 1, t + r);
    const med = temporalMedian(lumas.slice(lo, hi + 1));
    const sigma = Math.max(0.5, noiseSigma(lumas[t], w, h));
    const thr = Math.max(opts.minDelta, opts.sigmaK * sigma);
    const cand = defectCandidates(
      lumas[t], med, sigma, opts.minDelta, opts.sigmaK, opts.repairStrength,
    );

    // Motion gate on every frame; boundary frames use the one-sided pair.
    let motion: Uint8Array | null = null;
    if (n > 1) {
      const a = t > 0 ? lumas[t - 1] : lumas[0];
      const b = t < n - 1 ? lumas[t + 1] : lumas[n - 1];
      motion = motionMask(a, b, w, h, sigma, 3);
    }
    const trusted = cand.slice();
    if (motion) {
      for (let i = 0; i < trusted.length; i++) {
        if (motion[i]) trusted[i] = 0;
      }
    }
    // Locked vertical lines never enter the repair set.
    for (const c of lockedCenters) {
      for (let x = Math.max(0, c - 1); x <= Math.min(w - 1, c + 1); x++) {
        for (let y = 0; y < h; y++) trusted[y * w + x] = 0;
      }
    }

    const frameMask = new Uint8Array(w * h);
    const pushMask = (pixels: Uint32Array): void => {
      for (const i of pixels) frameMask[i] = 1;
    };
    const repairBlob = (blob: Blob, entry: MaskEntry): void => {
      entry.grainBefore = ringGrain(lumas[t], w, h, blob, 4);
      inpaint(out, blob);
      regrain(out, blob, entry.grainBefore, opts.grainPreservation);
      pushMask(blob.pixels);
      repairedMasks++;
      const after = toLuma(out);
      const only = new Uint8Array(w * h);
      for (const i of blob.pixels) only[i] = 1;
      entry.grainAfter = localGrain(after, w, h, only, blob.bbox);
      report.masks.push(entry);
    };

    // --- transient blobs: dust and hair ---
    for (const blob of connectedComponents(trusted, w, h, 3)) {
      blob.kind = classify(blob, h);
      const entry = makeEntry(src.index, report.masks.length, blob, lumas[t], med, sigma);
      entry.temporal = {
        inPrev: t > 0 && overlap(lumas[t - 1], med, blob.pixels, thr),
        inNext: t < n - 1 && overlap(lumas[t + 1], med, blob.pixels, thr),
        persistence: persistence(lumas, lo, hi, med, blob.pixels, thr),
      };
      if (entry.temporal.inPrev && entry.temporal.inNext) {
        entry.decision = "skipped-motion"; // moving picture, not a defect
        skippedMotion++;
        report.masks.push(entry);
        continue;
      }
      if (presentInReference(blob, reference, w, thr)) {
        entry.decision = "locked-content";
        lockedMasks++;
        report.masks.push(entry);
        continue;
      }
      repairBlob(blob, entry);
    }

    // --- persistent thin vertical scratches (vs long-term reference) ---
    for (const run of scratchRuns(lumas[t], reference, w, h, thr, opts.scratchMaxWidth, 0.45)) {
      const center = (run.x0 + run.x1) >> 1;
      if (lockedCenters.some((c) => Math.abs(c - center) <= 2)) continue;
      let y0 = h, y1 = 0;
      for (const i of run.pixels) {
        const y = (i / w) | 0;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const blob: Blob = {
        pixels: run.pixels,
        bbox: { x: run.x0, y: y0, w: run.x1 - run.x0 + 1, h: y1 - y0 + 1 },
        area: run.pixels.length,
        kind: "scratch",
        elongation: (y1 - y0 + 1) / (run.x1 - run.x0 + 1),
      };
      const entry = makeEntry(src.index, report.masks.length, blob, lumas[t], med, sigma);
      entry.confidence = Math.min(1, run.meanDev / (6 * sigma)) * (0.5 + 0.5 * run.coverage);
      entry.confidence = Math.round(entry.confidence * 1000) / 1000;
      entry.temporal = {
        inPrev: t > 0 && lineVisibility(lumas[t - 1], w, h, run.x0, run.x1, lineThr) > 0.5,
        inNext: t < n - 1 && lineVisibility(lumas[t + 1], w, h, run.x0, run.x1, lineThr) > 0.5,
        persistence: run.coverage,
      };
      if (motion) {
        let mHits = 0;
        for (const i of run.pixels) if (motion[i]) mHits++;
        if (mHits / run.pixels.length > 0.3) {
          entry.decision = "skipped-motion";
          skippedMotion++;
          report.masks.push(entry);
          continue;
        }
      }
      repairBlob(blob, entry);
    }

    // --- candidates that fell inside the motion gate (recorded only) ---
    if (motion) {
      const both = new Uint8Array(w * h);
      for (let i = 0; i < both.length; i++) {
        if (cand[i] && motion[i]) both[i] = 1;
      }
      for (const blob of connectedComponents(both, w, h, 12)) {
        skippedMotion++;
        const entry = makeEntry(src.index, report.masks.length, blob, lumas[t], med, sigma);
        blob.kind = classify(blob, h);
        entry.kind = blob.kind;
        entry.decision = "skipped-motion";
        entry.temporal = {
          inPrev: t > 0 && overlap(lumas[t - 1], med, blob.pixels, thr),
          inNext: t < n - 1 && overlap(lumas[t + 1], med, blob.pixels, thr),
          persistence: persistence(lumas, lo, hi, med, blob.pixels, thr),
        };
        report.masks.push(entry);
      }
    }

    let used = false;
    for (const v of frameMask) if (v) { used = true; break; }
    if (used) masks.set(src.index, frameMask);
  }

  const manifest: Manifest = {
    tool: "frame-safe/0.1.0",
    generated: new Date().toISOString(),
    source: { name, width: w, height: h, fps: opts.fps, frameCount: n },
    options: {
      repairStrength: opts.repairStrength,
      grainPreservation: opts.grainPreservation,
      disabledFrames: [...opts.disabledFrames].sort((a, b) => a - b),
    },
    frames: reports,
    lockedLines,
    manualFrames: [],
    summary: {
      repairedMasks,
      lockedMasks,
      skippedMotion,
      disabledFrames: opts.disabledFrames.size,
      manualEdits: 0,
    },
  };
  return { frames: outFrames, manifest, masks };
}

function persistence(
  lumas: Float32Array[], lo: number, hi: number,
  med: Float32Array, pixels: Uint32Array, thr: number,
): number {
  let frames = 0;
  for (let t = lo; t <= hi; t++) {
    if (overlap(lumas[t], med, pixels, thr)) frames++;
  }
  return Math.round((frames / (hi - lo + 1)) * 1000) / 1000;
}
