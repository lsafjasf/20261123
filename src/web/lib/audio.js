// WebAudio 音频 RMS 提取：解码整个音轨后按帧时间窗取能量。
// 无音轨或解码失败时优雅降级为全 0，不影响视频检测。
export class AudioProbe {
  constructor() {
    this.context = null;
    this.channelData = null;
    this.sampleRate = 0;
  }

  async load(file) {
    if (!globalThis.AudioContext && !globalThis.webkitAudioContext) return false;
    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.context = new Ctx();
      const buffer = await file.arrayBuffer();
      const audioBuffer = await this.context.decodeAudioData(buffer.slice(0));
      this.channelData = audioBuffer.getChannelData(0);
      this.sampleRate = audioBuffer.sampleRate;
      return true;
    } catch {
      this.channelData = null;
      return false;
    }
  }

  /** 返回 pts 附近一帧时长内的 RMS。 */
  rmsAt(pts, frameDurationSec) {
    if (!this.channelData) return 0;
    const startSample = Math.floor(pts * this.sampleRate);
    const endSample = Math.min(
      this.channelData.length,
      Math.floor((pts + frameDurationSec) * this.sampleRate),
    );
    if (endSample <= startSample) return 0;
    let sumSquares = 0;
    for (let i = startSample; i < endSample; i += 1) {
      sumSquares += this.channelData[i] * this.channelData[i];
    }
    return Math.sqrt(sumSquares / (endSample - startSample));
  }

  dispose() {
    this.context?.close?.();
    this.context = null;
    this.channelData = null;
  }
}
