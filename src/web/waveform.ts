import type { PcmBuffer } from '../core/types.ts';

/** Down-mix a PCM buffer to mono peaks/min-max for waveform drawing. */
export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
  buckets: number;
}

export function computePeaks(pcm: PcmBuffer, buckets: number): WaveformPeaks {
  const frameCount = pcm.channels[0].length;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  min.fill(0);
  max.fill(0);
  const bucketFrames = Math.max(1, Math.floor(frameCount / buckets));

  for (let bucket = 0; bucket < buckets; bucket++) {
    let lo = 1;
    let hi = -1;
    const start = bucket * bucketFrames;
    const end = Math.min(start + bucketFrames, frameCount);
    for (let frame = start; frame < end; frame++) {
      let sum = 0;
      for (const channel of pcm.channels) sum += channel[frame];
      const mono = sum / pcm.channels.length;
      if (mono < lo) lo = mono;
      if (mono > hi) hi = mono;
    }
    min[bucket] = lo === 1 ? 0 : lo;
    max[bucket] = hi === -1 ? 0 : hi;
  }
  return { min, max, buckets };
}

/** Draw a static waveform with a moving playhead. */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: WaveformPeaks,
  progress: number,
  color = '#7dd3fc',
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  const barWidth = width / peaks.buckets;
  for (let i = 0; i < peaks.buckets; i++) {
    const x = i * barWidth;
    const played = i / peaks.buckets <= progress;
    ctx.fillStyle = played ? color : 'rgba(148, 163, 184, 0.45)';
    const top = mid + peaks.min[i] * mid;
    const bottom = mid + peaks.max[i] * mid;
    ctx.fillRect(x, top, Math.max(1, barWidth * 0.7), Math.max(1, bottom - top));
  }
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(progress * width - 1, 0, 2, height);
}

/** Draw the dialogue-driven ducking envelope over time. */
export function drawDuckCurve(
  canvas: HTMLCanvasElement,
  curve: number[],
  progress: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || curve.length === 0) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((value, index) => {
    const x = (index / (curve.length - 1)) * width;
    const y = height - value * (height - 4) - 2;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(progress * width - 1, 0, 2, height);
}
