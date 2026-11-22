import type { Project, Timeline } from "../shared/types.ts";

export interface AudioBundle {
  sampleRate: number;
  channels: number;
  length: number;
  buffer: AudioBuffer;
}

async function decodeBuffer(context: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load audio ${url}: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  return await context.decodeAudioData(bytes);
}

function resample(input: AudioBuffer, targetRate: number, channels: number): AudioBuffer {
  const ratio = input.sampleRate / targetRate;
  const length = Math.ceil(input.length / ratio);
  const output = new OfflineAudioContext(channels, Math.max(1, length), targetRate);
  const buffer = output.createBuffer(channels, Math.max(1, length), targetRate);
  for (let channel = 0; channel < channels; channel += 1) {
    const sourceData = input.getChannelData(Math.min(channel, input.numberOfChannels - 1));
    const targetData = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const sourceIndex = Math.min(sourceData.length - 1, Math.floor(i * ratio));
      targetData[i] = sourceData[sourceIndex];
    }
  }
  return buffer;
}

export async function renderNarration(
  project: Project,
  timeline: Timeline,
  sampleRate = 48000,
): Promise<AudioBundle> {
  const channels = 2;
  const totalLength = Math.ceil(timeline.duration * sampleRate);
  const offline = new OfflineAudioContext(channels, Math.max(1, totalLength), sampleRate);
  const master = offline.createGain();
  master.gain.value = 1;
  master.connect(offline.destination);

  for (const segment of timeline.segments) {
    const spec = project.images[segment.index];
    if (!spec.narrationSrc) {
      continue;
    }
    const decoded = await decodeBuffer(offline, spec.narrationSrc);
    const buffer = decoded.sampleRate === sampleRate && decoded.numberOfChannels === channels
      ? decoded
      : resample(decoded, sampleRate, channels);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    const gain = offline.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(master);
    source.start(segment.enterAt);
  }

  if (project.narration.fullNarrationSrc) {
    const full = await decodeBuffer(offline, project.narration.fullNarrationSrc);
    const fullBuffer = full.sampleRate === sampleRate && full.numberOfChannels === channels
      ? full
      : resample(full, sampleRate, channels);
    const source = offline.createBufferSource();
    source.buffer = fullBuffer;
    const gain = offline.createGain();
    gain.gain.value = project.images.some((image) => image.narrationSrc) ? 0 : 1;
    source.connect(gain);
    gain.connect(master);
    source.start(0);
  }

  const rendered = await offline.startRendering();
  return {
    sampleRate,
    channels,
    length: rendered.length,
    buffer: rendered,
  };
}

export interface ScheduledClip {
  buffer: AudioBuffer;
  startAt: number;
}

export class PreviewMixer {
  private readonly context: AudioContext;
  private readonly clips: ScheduledClip[] = [];
  private readonly gain: GainNode;
  private sources: AudioBufferSourceNode[] = [];
  private baseContextTime = 0;
  private baseTimelineTime = 0;
  private playing = false;

  private constructor(context: AudioContext) {
    this.context = context;
    this.gain = context.createGain();
    this.gain.connect(context.destination);
  }

  static async create(project: Project, timeline: Timeline): Promise<PreviewMixer> {
    const context = new AudioContext();
    const mixer = new PreviewMixer(context);
    for (const segment of timeline.segments) {
      const spec = project.images[segment.index];
      if (!spec.narrationSrc) {
        continue;
      }
      const response = await fetch(spec.narrationSrc);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      mixer.clips.push({ buffer, startAt: segment.enterAt });
    }
    return mixer;
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
  }

  private schedule(timelineOffset: number): void {
    this.stopSources();
    this.baseContextTime = this.context.currentTime + 0.08;
    this.baseTimelineTime = timelineOffset;
    for (const clip of this.clips) {
      const whenContext = this.baseContextTime + (clip.startAt - timelineOffset);
      if (whenContext < this.baseContextTime) {
        const skipped = timelineOffset - clip.startAt;
        if (skipped < clip.buffer.duration) {
          const source = this.context.createBufferSource();
          source.buffer = clip.buffer;
          source.connect(this.gain);
          source.start(this.baseContextTime, skipped);
          this.sources.push(source);
        }
        continue;
      }
      const source = this.context.createBufferSource();
      source.buffer = clip.buffer;
      source.connect(this.gain);
      source.start(whenContext);
      this.sources.push(source);
    }
  }

  async play(offset: number): Promise<void> {
    if (this.context.state === "suspended" || this.context.state === "created") {
      await this.context.resume();
    }
    this.schedule(offset);
    this.playing = true;
  }

  pause(): number {
    const offset = this.timelineTime;
    this.playing = false;
    this.stopSources();
    void this.context.suspend();
    return offset;
  }

  async seek(offset: number): Promise<void> {
    if (this.playing) {
      await this.context.resume();
      this.schedule(offset);
    } else {
      this.baseTimelineTime = offset;
    }
  }

  get timelineTime(): number {
    if (!this.playing) {
      return this.baseTimelineTime;
    }
    return this.baseTimelineTime + (this.context.currentTime - this.baseContextTime);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  close(): void {
    this.stopSources();
    void this.context.close();
  }
}
