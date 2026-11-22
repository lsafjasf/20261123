// 可疑片段试听：内存中生成 WAV，经 MediaSource 喂给 <audio> 循环播放；
// 浏览器不支持 WAV-in-MSE 时回退到 Blob URL。全程本地，无网络。

export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const writeStr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  writeStr(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return buf;
}

export class ClipPlayer {
  private audio = new Audio();
  private mse: MediaSource | null = null;
  private objUrl: string | null = null;

  async play(pcm: Float32Array, sampleRate: number, start: number, duration: number): Promise<void> {
    this.stop();
    const s = Math.max(0, Math.floor((start - duration / 2) * sampleRate));
    const e = Math.min(pcm.length, Math.floor((start + duration / 2) * sampleRate));
    const clip = pcm.slice(s, e);
    const wav = encodeWav(clip, sampleRate);
    const mime = 'audio/wav; codecs="1"';
    if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime)) {
      this.mse = new MediaSource();
      this.objUrl = URL.createObjectURL(this.mse);
      this.audio.src = this.objUrl;
      await new Promise<void>((resolve) => {
        this.mse!.addEventListener("sourceopen", () => resolve(), { once: true });
      });
      const sb = this.mse.addSourceBuffer(mime);
      sb.appendBuffer(wav);
      await new Promise<void>((resolve) => {
        sb.addEventListener("updateend", () => resolve(), { once: true });
      });
      this.mse.endOfStream();
    } else {
      this.objUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      this.audio.src = this.objUrl;
    }
    this.audio.loop = true;
    await this.audio.play();
  }

  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.objUrl) URL.revokeObjectURL(this.objUrl);
    this.objUrl = null;
    this.mse = null;
  }
}
