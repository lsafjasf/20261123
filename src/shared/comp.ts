// Comp engine: builds a fixed reference timeline, places each sentence's chosen
// take into its slot with breath handles, and renders with short equal-power
// crossfades. Editing one sentence only ever touches that segment ± one fade.

import type { Segmentation } from "./dsp.ts";

export interface CompOptions {
  fadeMs?: number;    // crossfade length at joins (de-click)
  maxHandleMs?: number; // cap on breath handle borrowed from neighbours
}

export interface SegmentPlan {
  sentence: number;
  take: number;
  srcSentence: number;
  srcIn: number;      // seconds, in source take (includes leading breath handle)
  srcOut: number;     // seconds, in source take (includes trailing breath handle)
  dstStart: number;   // seconds, on comp timeline
  dstEnd: number;
  fadeIn: number;     // seconds of edge fade actually applied
  fadeOut: number;
  clamped: boolean;   // true if the source had to be trimmed to protect neighbours
}

export interface CompPlan {
  sampleRate: number;
  fadeMs: number;
  refTake: number;
  segments: SegmentPlan[];
  duration: number; // seconds
}

export function buildPlan(
  segs: Segmentation[],
  aligned: number[][],
  refIndex: number,
  choices: number[], // choices[sentence] = take index
  sampleRate: number,
  opts: CompOptions = {},
): CompPlan {
  const fadeMs = opts.fadeMs ?? 12;
  const fade = fadeMs / 1000;
  const maxHandle = (opts.maxHandleMs ?? 900) / 1000;
  const ref = segs[refIndex];
  const nSent = ref.sentences.length;
  const segments: SegmentPlan[] = [];

  for (let i = 0; i < nSent; i++) {
    const t = choices[i];
    const srcIdx = aligned[t][i];
    const refOnset = ref.sentences[i].start;
    // Fixed slot boundaries on the comp timeline (reference breath valleys).
    const slotLo = ref.cutPoints[i];
    const slotHi = ref.cutPoints[i + 1];

    if (srcIdx < 0 || srcIdx >= segs[t].sentences.length) {
      // Missing sentence in this take: leave a gap (silence) inside the slot.
      segments.push({
        sentence: i, take: t, srcSentence: -1,
        srcIn: 0, srcOut: 0, dstStart: slotLo, dstEnd: slotLo,
        fadeIn: 0, fadeOut: 0, clamped: false,
      });
      continue;
    }

    const src = segs[t];
    const sent = src.sentences[srcIdx];
    // Breath handles from the source take's own valleys, capped.
    let srcIn = Math.max(sent.start - maxHandle, src.cutPoints[srcIdx]);
    let srcOut = Math.min(sent.end + maxHandle, src.cutPoints[srcIdx + 1]);

    // Anchor speech onset to the reference onset: other sentences never move.
    let dstStart = refOnset - (sent.start - srcIn);
    let dstEnd = dstStart + (srcOut - srcIn);
    let clamped = false;

    // Keep the segment inside its slot ± half a fade so neighbours are untouched.
    const lo = Math.max(0, slotLo - fade / 2);
    const hi = slotHi + fade / 2;
    if (dstStart < lo) {
      srcIn += lo - dstStart;
      dstStart = lo;
      clamped = true;
    }
    if (dstEnd > hi) {
      srcOut -= dstEnd - hi;
      dstEnd = hi;
      clamped = true;
    }

    // Edge fades never exceed the breath handle actually available.
    const fadeIn = Math.min(fade, sent.start - srcIn, (dstEnd - dstStart) / 2);
    const fadeOut = Math.min(fade, srcOut - sent.end, (dstEnd - dstStart) / 2);

    segments.push({
      sentence: i, take: t, srcSentence: srcIdx,
      srcIn, srcOut, dstStart, dstEnd,
      fadeIn: Math.max(0, fadeIn), fadeOut: Math.max(0, fadeOut),
      clamped,
    });
  }

  const duration = Math.max(ref.duration, ...segments.map((s) => s.dstEnd));
  return { sampleRate, fadeMs, refTake: refIndex, segments, duration };
}

// Equal-power edge gain at position k of n within a fade (sin/cos pair).
function fadeGainIn(k: number, n: number): number {
  return Math.sin((Math.PI / 2) * (k / n));
}
function fadeGainOut(k: number, n: number): number {
  return Math.cos((Math.PI / 2) * (k / n));
}

// Render the plan by summing segments with edge fades. Deterministic and
// sample-exact, so re-rendering after changing one sentence leaves all
// samples outside that segment ± one fade bit-identical.
export function renderPlan(sources: Float32Array[], plan: CompPlan): Float32Array {
  const sr = plan.sampleRate;
  const out = new Float32Array(Math.ceil(plan.duration * sr) + 1);
  for (const seg of plan.segments) {
    if (seg.srcSentence < 0) continue;
    const src = sources[seg.take];
    const srcFrom = Math.round(seg.srcIn * sr);
    const dstFrom = Math.round(seg.dstStart * sr);
    const n = Math.min(Math.round((seg.srcOut - seg.srcIn) * sr), src.length - srcFrom);
    const fadeInN = Math.round(seg.fadeIn * sr);
    const fadeOutN = Math.round(seg.fadeOut * sr);
    for (let k = 0; k < n; k++) {
      let g = 1;
      if (k < fadeInN) g = fadeGainIn(k, fadeInN);
      else if (k >= n - fadeOutN) g = fadeGainOut(n - 1 - k, fadeOutN);
      const di = dstFrom + k;
      if (di >= 0 && di < out.length) out[di] += src[srcFrom + k] * g;
    }
  }
  return out;
}

// Provenance report: which take each comp region came from.
export interface ProvenanceEntry {
  sentence: number;
  take: number;
  dstStart: number;
  dstEnd: number;
  srcIn: number;
  srcOut: number;
  clamped: boolean;
}

export function provenance(plan: CompPlan): ProvenanceEntry[] {
  return plan.segments.map((s) => ({
    sentence: s.sentence,
    take: s.take,
    dstStart: s.dstStart,
    dstEnd: s.dstEnd,
    srcIn: s.srcIn,
    srcOut: s.srcOut,
    clamped: s.clamped,
  }));
}
