// 应用主控：把分块 GPU 渲染、滚动浏览器、导出管线与 MSE 回放串起来。
// 所有入口都在浏览器内完成，不连云端、不装第三方包。

import { TileRenderer } from './tileRenderer.ts';
import { TileViewer } from './tileViewer.ts';
import { ExportPipeline, type ExportReport } from './exportPipeline.ts';
import { generateSyntheticClip, frameToVideoFrame, type SyntheticClip } from './syntheticSource.ts';
import { AudioEngine, type AudioStats } from './audioEngine.ts';
import { MsePlayer, VP9_WEBM_MIME } from './msePlayer.ts';
import { DEFAULT_FILTER, type FilterParams } from '../shared/filters.ts';
import type { FramePerf } from './tileRenderer.ts';

export interface AppConfig {
  width: number;
  height: number;
  cols: number;
  rows: number;
  halo: number;
  fps: number;
  frameCount: number;
  filter: FilterParams;
}

export const DEFAULT_CONFIG: AppConfig = {
  width: 3840,
  height: 2160,
  cols: 4,
  rows: 2,
  halo: 16,
  fps: 30,
  frameCount: 12,
  filter: { ...DEFAULT_FILTER },
};

export class App {
  private renderer: TileRenderer | null = null;
  private viewer: TileViewer | null = null;
  private clip: SyntheticClip | null = null;
  private audio = new AudioEngine();
  private audioStats: AudioStats | null = null;
  readonly framePerf: FramePerf[] = [];

  constructor(private readonly host: HTMLElement) {}

  /** 生成素材并建立分块网格，准备滚动浏览。 */
  async setup(config: AppConfig): Promise<void> {
    this.clip = generateSyntheticClip(config.width, config.height, config.frameCount, config.fps);
    const canvas = document.createElement('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    this.renderer = new TileRenderer(canvas);
    const grid = this.renderer.configure(config.width, config.height, config.cols, config.rows, config.halo);
    this.audioStats = await this.audio.analyze(
      this.clip.audio.samples, this.clip.audio.sampleRate, this.clip.audio.channels,
    );
    const firstFrame = frameToVideoFrame(this.clip.frames[0], config.width, config.height, 0);
    this.renderer.uploadFrame(firstFrame);
    firstFrame.close();
    this.viewer = new TileViewer(this.renderer, grid, this.host);
    this.viewer.setFilter(config.filter);
  }

  get tileViewer(): TileViewer | null {
    return this.viewer;
  }

  /** 切换显示的帧（滚动浏览的数据源）。 */
  showFrame(frameIndex: number, filter: FilterParams): void {
    if (!this.clip || !this.renderer || !this.viewer) throw new Error('请先 setup()');
    const frame = frameToVideoFrame(
      this.clip.frames[frameIndex], this.clip.width, this.clip.height,
      frameIndex * Math.floor(1_000_000 / this.clip.fps),
    );
    this.renderer.uploadFrame(frame);
    frame.close();
    this.viewer.setFilter(filter);
  }

  /** 导出：逐帧分块处理 + 编码 + 封装，产出报告与 WebM 字节。 */
  async runExport(config: AppConfig, onProgress: (ratio: number, label: string) => void): Promise<ExportReport> {
    if (!this.clip) throw new Error('请先 setup()');
    this.framePerf.length = 0;
    const canvas = document.createElement('canvas');
    const pipeline = new ExportPipeline(canvas, {
      width: config.width,
      height: config.height,
      cols: config.cols,
      rows: config.rows,
      halo: config.halo,
      fps: config.fps,
      codec: 'vp9',
      filter: config.filter,
    });
    await pipeline.init();
    const frameDuration = Math.floor(1_000_000 / config.fps);
    for (let i = 0; i < this.clip.frameCount; i++) {
      const frame = frameToVideoFrame(this.clip.frames[i], config.width, config.height, i * frameDuration);
      const perf = await pipeline.processFrame(frame, i);
      this.framePerf.push(perf);
      onProgress((i + 1) / this.clip.frameCount, `帧 ${i + 1}/${this.clip.frameCount}`);
    }
    return pipeline.finish(this.framePerf);
  }

  /** 通过 MediaSource 回放导出的 WebM。 */
  async playViaMse(video: HTMLVideoElement, webm: Uint8Array): Promise<void> {
    const player = new MsePlayer();
    await player.attach(video, VP9_WEBM_MIME);
    player.append(webm);
    await player.endOfStream();
    await video.play();
  }

  get lastAudioStats(): AudioStats | null {
    return this.audioStats;
  }

  /** 回放合成音轨（WebAudio 图）。 */
  async playAudio(): Promise<void> {
    if (!this.clip) throw new Error('请先 setup()');
    await this.audio.play(
      this.clip.audio.samples,
      this.clip.audio.sampleRate,
      this.clip.audio.channels,
    );
  }

  dispose(): void {
    this.viewer?.dispose();
    this.renderer?.dispose();
    void this.audio.close();
  }
}
