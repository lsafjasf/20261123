// 扫描编排：逐帧 Canvas 采样 → 指标分批上传 → 检查点续扫。
// 中断（关页/刷新/暂停）后重新选择同一文件，哈希命中检查点即从 lastFrameIndex+1 继续。
import { api } from './api.js';
import { hashFile } from './hash.js';
import { FrameMetricExtractor } from './metrics.js';
import { AudioProbe } from './audio.js';
import { loadIntoVideo } from './mse-loader.js';

export class VideoScanner {
  constructor({ canvas, video, onProgress, onLog }) {
    this.canvas = canvas;
    this.video = video;
    this.onProgress = onProgress ?? (() => {});
    this.onLog = onLog ?? (() => {});
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
    this.video.pause();
  }

  async scan(file, { sampleEvery, batchSize, blackPixelLuma, engineVersion }) {
    this.aborted = false;
    this.onLog(`计算文件哈希: ${file.name}`);
    const sha256 = await hashFile(file, (ratio) =>
      this.onProgress({ phase: 'hash', ratio, file: file.name }),
    );

    const existing = await api.getScan(sha256).catch(() => null);
    let resumeFrame = 0;
    let batchIndex = 0;
    if (existing?.status === 'scanning') {
      resumeFrame = existing.lastFrameIndex + 1;
      batchIndex = existing.nextBatchIndex;
      this.onLog(`发现检查点，从第 ${resumeFrame} 帧继续（批次 ${batchIndex}）`);
    }

    const audio = new AudioProbe();
    const hasAudio = await audio.load(file);
    await loadIntoVideo(this.video, file, (msg) => this.onLog(msg));
    await this.waitLoaded();

    const frameRate = readFrameRate(this.video);
    const frameCount = Math.round(this.video.duration * frameRate);
    const videoMeta = {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      frameRate,
      frameCount,
      durationSec: this.video.duration,
      hasAudio,
    };
    this.onLog(`元数据: ${videoMeta.width}x${videoMeta.height} @ ${frameRate}fps，共 ${frameCount} 帧`);

    const extractor = new FrameMetricExtractor(this.canvas, blackPixelLuma);
    let pending = [];
    let frameIndex = 0;

    const flush = async () => {
      if (pending.length === 0) return;
      const upload = {
        sha256,
        fileName: file.name,
        size: file.size,
        engineVersion,
        batchIndex,
        sampleEvery,
        videoMeta,
        frames: pending,
      };
      const ack = await api.uploadBatch(upload);
      batchIndex = ack.nextBatchIndex;
      pending = [];
      this.onProgress({
        phase: 'scan',
        ratio: Math.min(1, (frameIndex + 1) / frameCount),
        file: file.name,
        checkpoint: ack.lastFrameIndex,
      });
    };

    await this.seek(0);
    while (frameIndex < frameCount && !this.aborted) {
      const pts = frameIndex / frameRate;
      await this.seek(pts);
      const audioRms = audio.rmsAt(pts, 1 / frameRate);
      const metric = extractor.capture(this.video, pts, audioRms);
      metric.pts = pts;
      const sampled = frameIndex % sampleEvery === 0;
      const alreadyUploaded = frameIndex < resumeFrame;
      if (sampled && !alreadyUploaded) {
        pending.push(metric);
        if (pending.length >= batchSize) await flush();
      }
      frameIndex += 1;
    }
    await flush();
    audio.dispose();

    if (this.aborted) {
      this.onLog('扫描已中断，检查点已保存，下次可从断点继续');
      return { sha256, aborted: true, frameCount };
    }
    await api.complete(sha256, frameCount);
    this.onLog('扫描完成，指标已全部持久化');
    return { sha256, aborted: false, frameCount };
  }

  waitLoaded() {
    return new Promise((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.addEventListener('loadeddata', resolve, { once: true });
    });
  }

  seek(seconds) {
    return new Promise((resolve) => {
      const onSeeked = () => {
        this.video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      this.video.addEventListener('seeked', onSeeked);
      this.video.currentTime = seconds;
    });
  }
}

function readFrameRate(video) {
    const tracks = video.captureStream?.().getVideoTracks?.() ?? [];
    const settings = tracks[0]?.getSettings?.();
    if (settings?.frameRate) return Math.round(settings.frameRate);
    return 30;
}
