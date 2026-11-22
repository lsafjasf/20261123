// 播放器：用 requestVideoFrameCallback 枚举真实呈现帧的 mediaTime，
// 得到 VFR/掉帧/暂停都安全的 帧号↔PTS 索引；支持逐帧寻址。
export class Player {
  readonly video: HTMLVideoElement;
  framePts: number[] = []; // 毫秒，单调递增
  private objectUrl: string | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  loadFile(file: File): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.framePts = [];
  }

  loadUrl(url: string): void {
    this.video.src = url;
    this.framePts = [];
  }

  /** 播放扫描全片，收集每一帧的呈现时间（毫秒）。rate 越大越快但可能漏帧。 */
  async scanFrames(rate: number, onProgress?: (done: number, total: number) => void): Promise<number[]> {
    const v = this.video;
    if (!v.src) throw new Error('尚未载入视频');
    await new Promise<void>((resolve, reject) => {
      if (v.readyState >= 1) resolve();
      else {
        v.addEventListener('loadedmetadata', () => resolve(), { once: true });
        v.addEventListener('error', () => reject(new Error('视频解码失败')), { once: true });
      }
    });
    const pts: number[] = [];
    const seen = new Set<number>();
    v.muted = true;
    v.playbackRate = rate;
    v.currentTime = 0;
    await v.play();
    await new Promise<void>((resolve) => {
      const cb: VideoFrameRequestCallback = (_now, meta) => {
        const ms = Math.round(meta.mediaTime * 100000) / 100; // 0.01ms 精度去重
        if (!seen.has(ms)) {
          seen.add(ms);
          pts.push(Math.round(meta.mediaTime * 1000 * 100) / 100);
        }
        onProgress?.(meta.mediaTime, v.duration || 1);
        if (v.ended) resolve();
        else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.addEventListener('ended', () => resolve(), { once: true });
    });
    v.pause();
    v.playbackRate = 1;
    pts.sort((a, b) => a - b);
    this.framePts = pts;
    return pts;
  }

  /** 逐帧寻址：seek 到该帧 PTS 稍前，等待 seeked 后微调 */
  async seekFrame(i: number): Promise<void> {
    const pts = this.framePts;
    if (i < 0 || i >= pts.length) throw new Error(`帧号越界: ${i}`);
    const v = this.video;
    const target = pts[i] / 1000;
    v.pause();
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        // currentTime 可能落在前一帧；若偏差超过半帧则再试一次
        const cur = v.currentTime;
        if (cur < target - 0.001 && i > 0 && pts[i] - pts[i - 1] > 2) {
          v.currentTime = target + 0.0005;
          return;
        }
        v.removeEventListener('seeked', onSeeked);
        resolve();
      };
      v.addEventListener('seeked', onSeeked);
      v.currentTime = target + 0.0005;
    });
  }

  /** 当前播放位置对应的帧号（pts <= t 的最后一帧） */
  currentFrame(): number {
    const t = this.video.currentTime * 1000;
    const pts = this.framePts;
    let lo = 0, hi = pts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  get frameCount(): number { return this.framePts.length; }
}
