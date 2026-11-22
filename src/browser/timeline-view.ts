import type { AnalysisEvent, AnalysisReport, DeviceId } from '../shared/types.ts';
import { mixToMono } from '../shared/signal-processing.ts';
import type { AudioBufferData, StemId } from '../shared/types.ts';

interface TimelineColors {
  warn: string;
  critical: string;
  clip: string;
  soft: string;
  playhead: string;
  waveform: string;
}

const COLORS: TimelineColors = {
  warn: 'rgba(230, 180, 80, 0.55)',
  critical: 'rgba(239, 106, 95, 0.6)',
  clip: 'rgba(255, 77, 109, 0.75)',
  soft: 'rgba(192, 132, 252, 0.55)',
  playhead: '#ffffff',
  waveform: 'rgba(120, 170, 255, 0.85)',
};

export class TimelineView {
  private readonly canvas: HTMLCanvasElement;
  private peaks: Float32Array = new Float32Array(0);
  private duration = 1;
  private events: AnalysisEvent[] = [];
  private playheadSec = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setWaveform(stems: Partial<Record<StemId, AudioBufferData>>): void {
    const reference = stems.dialogue ?? stems.music ?? stems.effects;
    if (!reference) {
      this.peaks = new Float32Array(0);
      this.duration = 1;
      return;
    }
    const mono = mixToMono(reference);
    const bucketCount = Math.max(200, this.canvas.width);
    const bucketSize = Math.max(1, Math.floor(mono.length / bucketCount));
    const peaks = new Float32Array(bucketCount);
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      let max = 0;
      const start = bucket * bucketSize;
      const end = Math.min(mono.length, start + bucketSize);
      for (let i = start; i < end; i += 1) max = Math.max(max, Math.abs(mono[i]));
      peaks[bucket] = max;
    }
    this.peaks = peaks;
    this.duration = mono.length / reference.sampleRate;
  }

  setReport(report: AnalysisReport, deviceId: DeviceId): void {
    this.events = report.devices.find((device) => device.deviceId === deviceId)?.events ?? [];
  }

  setPlayhead(sec: number): void {
    this.playheadSec = sec;
    this.draw();
  }

  get currentTimeSec(): number {
    return this.playheadSec;
  }

  timeAtClientX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return fraction * this.duration;
  }

  private eventColor(event: AnalysisEvent): string {
    if (event.kind === 'clipping') return COLORS.clip;
    if (event.kind === 'softclip') return COLORS.soft;
    return event.severity === 'critical' ? COLORS.critical : COLORS.warn;
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0c0f16';
    ctx.fillRect(0, 0, width, height);

    const middle = height / 2;
    ctx.strokeStyle = COLORS.waveform;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < this.peaks.length; i += 1) {
      const x = (i / Math.max(1, this.peaks.length - 1)) * width;
      const amplitude = this.peaks[i] * (height * 0.42);
      ctx.moveTo(x, middle - amplitude);
      ctx.lineTo(x, middle + amplitude);
    }
    ctx.stroke();

    for (const event of this.events) {
      const x = (event.startSec / this.duration) * width;
      const eventWidth = Math.max(
        2,
        ((event.endSec - event.startSec) / this.duration) * width,
      );
      ctx.fillStyle = this.eventColor(event);
      ctx.fillRect(x, 6, eventWidth, height - 12);
    }

    const playheadX = (this.playheadSec / this.duration) * width;
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.fillStyle = '#9aa4b8';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`0 s`, 6, height - 8);
    ctx.fillText(`${this.duration.toFixed(1)} s`, width - 48, height - 8);
  }
}
