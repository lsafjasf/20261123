import type { RenderResult } from "../core/types.ts";

interface RenderSnapshot {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private snapshot: RenderSnapshot | null = null;
  private source: AudioBufferSourceNode | null = null;
  private sourceGains: GainNode[] = [];
  private sourceChain: AudioNode[] = [];
  private startContextTime = 0;
  private startOffset = 0;
  private playing = false;
  private stoppedManually = false;
  private previewSource: AudioBufferSourceNode | null = null;
  private muted = [false, false];
  onEnded: (() => void) | null = null;

  private getContext(): AudioContext {
    if (!this.context) {
      const Context = window.AudioContext;
      this.context = new Context();
    }
    return this.context;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  setRender(render: RenderResult): void {
    this.snapshot = {
      channels: render.channels,
      sampleRate: render.sampleRate,
      duration: render.duration,
    };
  }

  setMuted(channel: number, muted: boolean): void {
    this.muted[channel] = muted;
    const gain = this.sourceGains[channel];
    if (gain) gain.gain.value = muted ? 0 : 1;
  }

  getPosition(): number {
    if (!this.snapshot) return 0;
    if (!this.playing || !this.context) return Math.min(this.startOffset, this.snapshot.duration);
    const elapsed = Math.max(0, this.context.currentTime - this.startContextTime);
    return Math.min(this.snapshot.duration, this.startOffset + elapsed);
  }

  async play(position: number): Promise<number> {
    if (!this.snapshot) return position;
    this.stopNode();
    this.stopPreview();
    const context = this.getContext();
    if (context.state === "suspended") await context.resume();
    const duration = this.snapshot.duration;
    const offset = Math.max(0, Math.min(position, duration - 0.002));
    const buffer = context.createBuffer(
      this.snapshot.channels.length,
      this.snapshot.channels[0].length,
      this.snapshot.sampleRate,
    );
    for (let channel = 0; channel < this.snapshot.channels.length; channel += 1) {
      buffer.copyToChannel(this.snapshot.channels[channel], channel);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    const splitter = context.createChannelSplitter(buffer.numberOfChannels);
    const merger = context.createChannelMerger(buffer.numberOfChannels);
    const gains = Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
      const gain = context.createGain();
      gain.gain.value = this.muted[channel] ? 0 : 1;
      splitter.connect(gain, channel);
      gain.connect(merger, 0, channel);
      return gain;
    });
    const master = context.createGain();
    master.gain.value = 0.94;
    source.connect(splitter);
    merger.connect(master);
    master.connect(context.destination);

    this.stoppedManually = false;
    source.onended = () => {
      if (this.source !== source) return;
      this.playing = false;
      this.source = null;
      this.sourceGains = [];
      this.disconnectChain();
      if (!this.stoppedManually) this.onEnded?.();
    };
    source.start(0, offset);
    this.source = source;
    this.sourceGains = gains;
    this.sourceChain = [source, splitter, merger, master, ...gains];
    this.startContextTime = context.currentTime;
    this.startOffset = offset;
    this.playing = true;
    return offset;
  }

  pause(): number {
    const position = this.getPosition();
    this.startOffset = position;
    this.stopNode();
    return position;
  }

  stop(): void {
    this.stopNode();
    this.startOffset = 0;
  }

  private stopNode(): void {
    if (this.source) {
      this.stoppedManually = true;
      try {
        this.source.stop();
      } catch {
        // A source that has already ended cannot be stopped twice.
      }
      this.source.disconnect();
    }
    this.disconnectChain();
    this.source = null;
    this.sourceGains = [];
    this.playing = false;
  }

  private disconnectChain(): void {
    for (const node of this.sourceChain) {
      try {
        node.disconnect();
      } catch {
        // Nodes may already have been disconnected by an ended source.
      }
    }
    this.sourceChain = [];
  }

  async playClip(
    channels: Float32Array[],
    sampleRate: number,
    startSeconds: number,
    durationSeconds: number,
  ): Promise<void> {
    this.stopNode();
    this.stopPreview();
    const context = this.getContext();
    if (context.state === "suspended") await context.resume();
    const channelCount = Math.max(1, Math.min(2, channels.length));
    const startFrame = Math.max(0, Math.round(startSeconds * sampleRate));
    const totalFrames = channels[0]?.length || 0;
    const frameCount = Math.max(1, Math.min(
      Math.round(durationSeconds * sampleRate),
      totalFrames - startFrame,
    ));
    const buffer = context.createBuffer(channelCount, frameCount, sampleRate);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const source = channels[Math.min(channel, channels.length - 1)];
      const slice = source.slice(startFrame, startFrame + frameCount);
      buffer.copyToChannel(slice, channel);
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    const fade = Math.min(0.012, durationSeconds / 5);
    const now = context.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.96, now + fade);
    gain.gain.setValueAtTime(0.96, now + Math.max(fade, durationSeconds - fade));
    gain.gain.linearRampToValueAtTime(0, now + durationSeconds);
    source.connect(gain);
    gain.connect(context.destination);
    source.onended = () => {
      if (this.previewSource === source) this.previewSource = null;
      gain.disconnect();
    };
    source.start(0);
    this.previewSource = source;
  }

  private stopPreview(): void {
    if (!this.previewSource) return;
    try {
      this.previewSource.stop();
      this.previewSource.disconnect();
    } catch {
      // Ignore a preview that has already completed.
    }
    this.previewSource = null;
  }
}
