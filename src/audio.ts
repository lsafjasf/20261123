import { encodeWavFloat32, interleaveFloat32, measurePeak, measureRmsDb } from "./dsp.ts";
import type {
  ExportVerification,
  MapSpan,
  PcmAudio,
  ProcessedAudio,
} from "./types.ts";

let sharedContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedContext) sharedContext = new AudioContext({ latencyHint: "interactive" });
  return sharedContext;
}

export async function decodeAudio(data: ArrayBuffer): Promise<PcmAudio> {
  const context = getAudioContext();
  const buffer = await context.decodeAudioData(data.slice(0));
  return {
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, index) =>
      buffer.getChannelData(index).slice(),
    ),
  };
}

export function toAudioBuffer(pcm: PcmAudio, context = getAudioContext()): AudioBuffer {
  const buffer = context.createBuffer(pcm.channels.length, pcm.length, pcm.sampleRate);
  pcm.channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
  return buffer;
}

export class AudioPlayer {
  private context = getAudioContext();
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private startOffset = 0;
  private duration = 0;
  onEnded: (() => void) | null = null;

  get playing(): boolean {
    return this.source !== null;
  }

  get position(): number {
    if (!this.source) return this.startOffset;
    return Math.min(this.duration, this.startOffset + (this.context.currentTime - this.startedAt));
  }

  async play(pcm: PcmAudio, offset: number): Promise<void> {
    await this.context.resume();
    this.stop();
    const buffer = toAudioBuffer(pcm, this.context);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const safeOffset = Math.max(0, Math.min(offset, buffer.duration - 0.001));
    this.startOffset = safeOffset;
    this.duration = buffer.duration;
    this.startedAt = this.context.currentTime;
    this.source = source;
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.startOffset = this.duration;
      this.onEnded?.();
    };
    source.start(0, safeOffset);
  }

  stop(): void {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    this.startOffset = this.position;
    try {
      source.stop();
    } catch {
      // A source that reached its end cannot be stopped twice.
    }
    source.disconnect();
  }
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function exportWav(processed: ProcessedAudio): { blob: Blob; arrayBuffer: ArrayBuffer } {
  const arrayBuffer = encodeWavFloat32(processed.pcm);
  return { blob: new Blob([arrayBuffer], { type: "audio/wav" }), arrayBuffer };
}

function compareExactSpans(
  source: PcmAudio,
  exported: PcmAudio,
  spans: MapSpan[],
): ExportVerification["untouched"] {
  let maxDifference = 0;
  let samples = 0;
  let count = 0;
  for (const span of spans) {
    if (span.mode !== "exact") continue;
    count += 1;
    const length = Math.min(span.sourceEnd - span.sourceStart, span.outputEnd - span.outputStart);
    for (let channel = 0; channel < Math.min(source.channels.length, exported.channels.length); channel += 1) {
      for (let index = 0; index < length; index += 1) {
        const difference = Math.abs(
          source.channels[channel][span.sourceStart + index] -
            exported.channels[channel][span.outputStart + index],
        );
        maxDifference = Math.max(maxDifference, difference);
        samples += 1;
      }
    }
  }
  return { pass: maxDifference <= 1e-7, spans: count, samples, maxDifference };
}

async function webCodecsFingerprint(pcm: PcmAudio): Promise<ExportVerification["webCodecs"]> {
  try {
    if (typeof AudioData === "undefined") throw new Error("AudioData unavailable");
    const interleaved = interleaveFloat32(pcm);
    const data = new AudioData({
      format: "f32",
      sampleRate: pcm.sampleRate,
      numberOfFrames: pcm.length,
      numberOfChannels: pcm.channels.length,
      timestamp: 0,
      data: interleaved,
    });
    const copy = new Float32Array(interleaved.length);
    data.copyTo(copy, { planeIndex: 0, format: "f32" });
    let peak = 0;
    for (let index = 0; index < copy.length; index += 1) peak = Math.max(peak, Math.abs(copy[index]));
    const frames = data.numberOfFrames;
    data.close();
    return { available: true, frames, peak, pass: frames === pcm.length };
  } catch {
    return { available: false, frames: 0, peak: 0, pass: true };
  }
}

export async function verifyExport(
  blob: Blob,
  source: PcmAudio,
  processed: ProcessedAudio,
): Promise<{ verification: ExportVerification; exported: PcmAudio }> {
  const exported = await decodeAudio(await blob.arrayBuffer());
  const expectedDuration = processed.pcm.length / processed.pcm.sampleRate;
  const actualDuration = exported.length / exported.sampleRate;
  const deltaSamples = Math.abs(exported.length - processed.pcm.length);
  const expectedPeak = measurePeak(processed.pcm);
  const actualPeak = measurePeak(exported);
  let clippedSamples = 0;
  for (const channel of exported.channels) {
    for (let index = 0; index < channel.length; index += 1) {
      if (Math.abs(channel[index]) > 1) clippedSamples += 1;
    }
  }
  const untouched = compareExactSpans(source, exported, processed.spans);
  const webCodecs = await webCodecsFingerprint(processed.pcm);
  const duration = {
    pass: deltaSamples <= 1 && Math.abs(actualDuration - expectedDuration) < 1 / exported.sampleRate,
    expected: expectedDuration,
    actual: actualDuration,
    deltaSamples,
  };
  const peak = {
    pass: Math.abs(actualPeak - expectedPeak) <= 1e-7 && clippedSamples === 0,
    expected: expectedPeak,
    actual: actualPeak,
    dbfs: actualPeak > 0 ? 20 * Math.log10(actualPeak) : -Infinity,
    clippedSamples,
  };
  return {
    verification: {
      duration,
      peak,
      untouched,
      webCodecs,
      pass: duration.pass && peak.pass && untouched.pass && webCodecs.pass,
    },
    exported,
  };
}

export function capabilitySummary(): string {
  const codecs = typeof AudioEncoder !== "undefined" ? "WebCodecs" : "WebCodecs 不支持";
  const media = typeof MediaSource !== "undefined" ? "MediaSource" : "MediaSource 不支持";
  return `WebAudio · ${codecs} · ${media} · Canvas`;
}

export function seamLevelLabel(processed: ProcessedAudio, eventId: string): string {
  const seam = processed.seams.find((item) => item.eventId === eventId);
  return seam ? `${seam.seamRmsDb.toFixed(1)} dBFS` : "—";
}

export function sourceLevelLabel(source: PcmAudio, start: number, end: number): string {
  return `${measureRmsDb(source, start, end).toFixed(1)} dBFS`;
}
