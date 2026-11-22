// Per-(take, sentence) comparison metrics: lip-sync rhythm, emotion proxies, noise floor.

import {
  envelope,
  ncc,
  pitchTrack,
  rmsDbOfRange,
  spectralCentroid,
  type Segmentation,
} from "./dsp.ts";

export interface SentenceMetrics {
  take: number;
  sentence: number;      // reference sentence index
  srcSentence: number;   // sentence index inside this take (-1 = missing)
  duration: number;      // seconds
  timingDev: number;     // (dur - refDur) / refDur  → lip-sync timing
  rhythm: number;        // envelope NCC vs reference take, -1..1 → lip-sync rhythm
  rmsDb: number;         // loudness
  noiseDb: number;       // noise floor in the breath gap before the sentence
  f0MeanHz: number;
  f0RangeHz: number;     // p90 - p10 → expressiveness
  centroidHz: number;    // brightness
  emotionDist: number;   // weighted distance of emotion vector vs reference
}

const ENV_POINTS = 48;

export function computeMetrics(
  takes: Float32Array[],
  sampleRate: number,
  segs: Segmentation[],
  aligned: number[][],
  refIndex: number,
): SentenceMetrics[][] {
  const nSent = segs[refIndex].sentences.length;
  const refEnvelopes: Float32Array[] = [];
  const refDur: number[] = [];
  for (let s = 0; s < nSent; s++) {
    const rs = segs[refIndex].sentences[s];
    refEnvelopes.push(envelope(takes[refIndex], sampleRate, rs.start, rs.end, ENV_POINTS));
    refDur.push(rs.end - rs.start);
  }

  // First pass: raw features.
  const raw: SentenceMetrics[][] = takes.map((samples, t) => {
    const row: SentenceMetrics[] = [];
    for (let s = 0; s < nSent; s++) {
      const srcIdx = aligned[t][s];
      if (srcIdx < 0 || srcIdx >= segs[t].sentences.length) {
        row.push({
          take: t, sentence: s, srcSentence: -1, duration: 0, timingDev: 0, rhythm: 0,
          rmsDb: -160, noiseDb: segs[t].noiseFloorDb, f0MeanHz: 0, f0RangeHz: 0,
          centroidHz: 0, emotionDist: 0,
        });
        continue;
      }
      const sent = segs[t].sentences[srcIdx];
      const gapStart = segs[t].cutPoints[srcIdx];
      const env = envelope(samples, sampleRate, sent.start, sent.end, ENV_POINTS);
      const pitch = pitchTrack(samples, sampleRate, sent.start, sent.end);
      row.push({
        take: t,
        sentence: s,
        srcSentence: srcIdx,
        duration: sent.end - sent.start,
        timingDev: 0,
        rhythm: ncc(env, refEnvelopes[s]),
        rmsDb: rmsDbOfRange(samples, sampleRate, sent.start, sent.end),
        noiseDb: rmsDbOfRange(samples, sampleRate, gapStart, sent.start),
        f0MeanHz: pitch.meanHz,
        f0RangeHz: pitch.p90Hz - pitch.p10Hz,
        centroidHz: spectralCentroid(samples, sampleRate, sent.start, sent.end),
        emotionDist: 0,
      });
    }
    return row;
  });

  // Second pass: deviations vs reference row.
  const refRow = raw[refIndex];
  for (const row of raw) {
    for (let s = 0; s < nSent; s++) {
      const m = row[s];
      const r = refRow[s];
      if (m.srcSentence < 0 || r.srcSentence < 0) continue;
      m.timingDev = r.duration > 0 ? (m.duration - r.duration) / r.duration : 0;
      const dRms = (m.rmsDb - r.rmsDb) / 12;          // ~perceptual weight
      const dF0 = r.f0MeanHz > 0 ? (m.f0MeanHz - r.f0MeanHz) / r.f0MeanHz : 0;
      const dRange = r.f0RangeHz > 0 ? (m.f0RangeHz - r.f0RangeHz) / r.f0RangeHz : 0;
      const dCent = r.centroidHz > 0 ? (m.centroidHz - r.centroidHz) / r.centroidHz : 0;
      m.emotionDist = Math.sqrt(dRms * dRms + dF0 * dF0 + 0.5 * dRange * dRange + 0.5 * dCent * dCent);
    }
  }
  return raw;
}
