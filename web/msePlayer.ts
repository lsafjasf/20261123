// MediaSource 播放：把 WebM 分片通过 SourceBuffer 喂给 <video>，
// 模拟导出即播放的流式场景，无需落盘或服务端往返。

export class MsePlayer {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private objectUrl = '';

  async attach(video: HTMLVideoElement, mime: string): Promise<void> {
    if (!('MediaSource' in window)) throw new Error('当前环境不支持 MediaSource');
    if (!MediaSource.isTypeSupported(mime)) {
      throw new Error(`MSE 不支持该 MIME: ${mime}`);
    }
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    video.src = this.objectUrl;
    await new Promise<void>((resolve) => {
      this.mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true });
    });
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
    this.sourceBuffer.mode = 'segments';
    this.sourceBuffer.addEventListener('updateend', () => this.pump());
  }

  /** 追加一片 WebM 字节（header 或 cluster 均可）。 */
  append(data: Uint8Array): void {
    this.queue.push(data);
    this.pump();
  }

  private pump(): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      this.sourceBuffer.appendBuffer(next);
    } catch (err) {
      // 队列冲突时放回队首，等 updateend 再试
      this.queue.unshift(next);
    }
  }

  async endOfStream(): Promise<void> {
    await this.waitForDrain();
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      this.mediaSource.endOfStream();
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.sourceBuffer || (!this.sourceBuffer.updating && this.queue.length === 0)) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  detach(video: HTMLVideoElement): void {
    this.queue = [];
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    video.removeAttribute('src');
    video.load();
    this.mediaSource = null;
    this.sourceBuffer = null;
  }
}

export const VP9_WEBM_MIME = 'video/webm;codecs=vp9';
export const AV1_WEBM_MIME = 'video/webm;codecs=av1';
