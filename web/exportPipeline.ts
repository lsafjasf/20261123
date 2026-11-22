// 导出管线：解码/合成帧 -> TileRenderer 分块 GPU 渲染 -> 拼回整帧 ->
// WebCodecs 编码 -> WebM 封装，同时产出每块耗时与显存统计、重叠区一致性指标。

import { TileRenderer, type FramePerf, type TilePerf } from './tileRenderer.ts';
import { WebmMuxer } from './webmMuxer.ts';
import type { FilterParams } from '../shared/filters.ts';
import type { TileGrid } from '../shared/tiling.ts';

export interface ExportOptions {
  width: number;
  height: number;
  cols: number;
  rows: number;
  halo: number;
  fps: number;
  codec: 'vp9' | 'av1';
  filter: FilterParams;
}

export interface OverlapCheck {
  /** 重叠区被比对的像素对数 */
  samples: number;
  /** 最大绝对差异（0..255），0 表示完全一致 */
  maxDiff: number;
  /** 平均绝对差异 */
  meanDiff: number;
}

export interface ExportReport {
  frames: FramePerf[];
  overlap: OverlapCheck;
  /** 汇总：每块平均墙钟/GPU 耗时 */
  tileAverages: TilePerf[];
  webm: Uint8Array;
  peakBytes: number;
}

export class ExportPipeline {
  private readonly renderer: TileRenderer;
  private grid: TileGrid;
  private readonly muxer: WebmMuxer;
  private encoder: VideoEncoder | null = null;
  private peakBytes = 0;

  constructor(canvas: HTMLCanvasElement, private readonly options: ExportOptions) {
    this.renderer = new TileRenderer(canvas);
    this.grid = this.renderer.configure(
      options.width, options.height, options.cols, options.rows, options.halo,
    );
    this.muxer = new WebmMuxer({
      id: 1, kind: 'video', codec: options.codec,
      width: options.width, height: options.height,
    });
  }

  get tileGrid(): TileGrid {
    return this.grid;
  }

  async init(): Promise<void> {
    const codecString = this.options.codec === 'vp9' ? 'vp09.00.10.08' : 'av01.0.04M.08';
    const config: VideoEncoderConfig = {
      codec: codecString,
      width: this.options.width,
      height: this.options.height,
      bitrate: 16_000_000,
      framerate: this.options.fps,
    };
    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`浏览器不支持编码配置: ${codecString}`);
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        this.muxer.muxVideo({
          data: buf,
          timestampMicros: chunk.timestamp,
          isKey: chunk.type === 'key',
        });
      },
      error: (err) => {
        throw err;
      },
    });
    this.encoder.configure(config);
  }

  /** 处理一帧：分块渲染、重叠一致性校验、整帧拼接后送入编码器。 */
  async processFrame(frame: VideoFrame, frameIndex: number): Promise<FramePerf> {
    this.renderer.uploadFrame(frame);
    const perf = this.renderer.renderFrame(frameIndex, this.options.filter);
    this.peakBytes = Math.max(this.peakBytes, perf.allocatedBytes);
    const stitched = this.stitchFrame();
    const outFrame = new VideoFrame(stitched, {
      timestamp: frame.timestamp,
      duration: Math.floor(1_000_000 / this.options.fps),
    });
    this.encoder!.encode(outFrame, { keyFrame: frameIndex === 0 });
    outFrame.close();
    frame.close();
    return perf;
  }

  /** 把各块核心区画到整帧 canvas（奇数尺寸也精确对齐），返回拼接结果。 */
  stitchFrame(): HTMLCanvasElement {
    const { width, height } = this.options;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    for (const tile of this.grid.tiles) {
      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = tile.width;
      tileCanvas.height = tile.height;
      this.renderer.blitTileCore(tile.index, tileCanvas.getContext('2d')!);
      ctx.drawImage(tileCanvas, tile.x0, tile.y0);
    }
    return canvas;
  }

  /**
   * 重叠区一致性：读取相邻块各自 FBO 在共享 halo 像素上的结果并比对。
   * 着色器按整帧坐标计算，理论差异为 0；这里量化为实际测量值。
   */
  checkOverlapConsistency(): OverlapCheck {
    let samples = 0;
    let maxDiff = 0;
    let sumDiff = 0;
    const gl = this.renderer.ctx.gl;
    for (let i = 0; i < this.grid.tiles.length; i++) {
      for (let j = i + 1; j < this.grid.tiles.length; j++) {
        const a = this.grid.tiles[i];
        const b = this.grid.tiles[j];
        const ox0 = Math.max(a.sx0, b.sx0);
        const oy0 = Math.max(a.sy0, b.sy0);
        const ox1 = Math.min(a.sx1, b.sx1);
        const oy1 = Math.min(a.sy1, b.sy1);
        if (ox0 >= ox1 || oy0 >= oy1) continue;
        const pa = this.readTilePixels(i);
        const pb = this.readTilePixels(j);
        for (let y = oy0; y < oy1; y++) {
          for (let x = ox0; x < ox1; x++) {
            const ia = ((y - a.sy0) * a.sampleWidth + (x - a.sx0)) * 4;
            const ib = ((y - b.sy0) * b.sampleWidth + (x - b.sx0)) * 4;
            for (let c = 0; c < 3; c++) {
              const diff = Math.abs(pa[ia + c] - pb[ib + c]);
              maxDiff = Math.max(maxDiff, diff);
              sumDiff += diff;
              samples++;
            }
          }
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { samples, maxDiff, meanDiff: samples ? sumDiff / samples : 0 };
  }

  private readTilePixels(index: number): Uint8ClampedArray {
    const target = this.renderer.getTarget(index);
    const gl = this.renderer.ctx.gl;
    const { tile } = target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const raw = new Uint8ClampedArray(tile.sampleWidth * tile.sampleHeight * 4);
    gl.readPixels(0, 0, tile.sampleWidth, tile.sampleHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // WebGL 原点在左下：翻回图像（上到下）行序，使帧坐标索引一致
    const topDown = new Uint8ClampedArray(raw.length);
    const rowBytes = tile.sampleWidth * 4;
    for (let y = 0; y < tile.sampleHeight; y++) {
      const src = (tile.sampleHeight - 1 - y) * rowBytes;
      topDown.set(raw.subarray(src, src + rowBytes), y * rowBytes);
    }
    return topDown;
  }

  async finish(frames: FramePerf[]): Promise<ExportReport> {
    await this.encoder!.flush();
    this.encoder!.close();
    const webm = this.muxer.build();
    const overlap = this.checkOverlapConsistency();
    const tileAverages = this.averageTileStats(frames);
    this.renderer.dispose();
    return {
      frames,
      overlap,
      tileAverages,
      webm,
      peakBytes: this.peakBytes,
    };
  }

  /** 由调用方累积的逐帧性能计算每块平均耗时。 */
  averageTileStats(frames: FramePerf[]): TilePerf[] {
    const all = frames;
    if (!all.length) return [];
    const count = this.grid.tiles.length;
    const acc = new Array<TilePerf>(count);
    for (let t = 0; t < count; t++) {
      const perFrame = all.map((f) => f.tiles[t]);
      const wallAvg = perFrame.reduce((s, p) => s + p.wallMs, 0) / perFrame.length;
      const gpu = perFrame.every((p) => p.gpuNanos !== null)
        ? perFrame.reduce((s, p) => s + (p.gpuNanos ?? 0), 0) / perFrame.length
        : null;
      acc[t] = { ...perFrame[0], wallMs: wallAvg, gpuNanos: gpu };
    }
    return acc;
  }

}
