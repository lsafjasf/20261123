/**
 * WebAudio 播放：把确定性渲染的交错立体声 PCM 装进 AudioBuffer。
 * 这是不支持 WebCodecs/MediaSource 时的等价回退路径，
 * 音频内容仍来自同一个离线混音器，可复现性不变。
 */

import { SAMPLE_RATE } from '../core/types.ts';

export class PcmPlayer {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private playing = false;

  private readonly pcm: Float32Array;

  constructor(pcm: Float32Array) {
    this.pcm = pcm;
  }

  private ensureBuffer(): AudioBuffer {
    if (this.buffer) return this.buffer;
    const frameCount = Math.floor(this.pcm.length / 2);
    const audioBuffer = new AudioContext().createBuffer(
      2,
      frameCount,
      SAMPLE_RATE,
    );
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    for (let i = 0; i < frameCount; i++) {
      left[i] = this.pcm[i * 2];
      right[i] = this.pcm[i * 2 + 1];
    }
    this.buffer = audioBuffer;
    return audioBuffer;
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    const source = this.context.createBufferSource();
    source.buffer = this.ensureBuffer();
    source.connect(this.context.destination);
    source.onended = () => {
      if (this.source === source) {
        this.playing = false;
        this.offset = 0;
      }
    };
    source.start(0, this.offset);
    this.source = source;
    this.startedAt = this.context.currentTime - this.offset;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing || !this.context || !this.source) return;
    this.offset = this.context.currentTime - this.startedAt;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
    this.playing = false;
  }

  get currentTime(): number {
    if (!this.context) return 0;
    return this.playing ? this.context.currentTime - this.startedAt : this.offset;
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
