// GPU 分块渲染器：整帧纹理（永不降采样）+ 每块独立 FBO。
// 着色器按整帧坐标计算，分块只切换 viewport / uniform，
// 所以重叠 halo 内同一像素在相邻块上结果一致。

import { createGlContext, createProgram, uniformLocs, createQuadBuffer, createTimer, pollTimer, type GpuTimer } from './gl.ts';
import { FILTER_VERT, FILTER_FRAG } from '../shared/shader.ts';
import { buildTileGrid, estimateTileBytes, type TileGrid, type TileRect } from '../shared/tiling.ts';
import type { FilterParams } from '../shared/filters.ts';

export interface TilePerf {
  index: number;
  col: number;
  row: number;
  width: number;
  height: number;
  sampleWidth: number;
  sampleHeight: number;
  /** CPU 墙钟（毫秒，含提交与回读） */
  wallMs: number;
  /** GPU 纳秒，不支持计时扩展时为 null */
  gpuNanos: number | null;
  /** 该块显式分配的 GPU 字节（输入共享纹理按采样区折算 + 私有 FBO） */
  bytes: number;
}

export interface FramePerf {
  frameIndex: number;
  tiles: TilePerf[];
  totalWallMs: number;
  totalGpuMs: number | null;
  /** 整帧管线的显式 GPU 字节（共享纹理 + 全部 FBO + 缓冲） */
  allocatedBytes: number;
  /** 浏览器实际显存查询（仅部分驱动支持，否则 null） */
  deviceBytes: number | null;
}

interface TileTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  timer: GpuTimer | null;
}

export class TileRenderer {
  readonly ctx: ReturnType<typeof createGlContext>;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly loc: Record<string, WebGLUniformLocation | null>;
  private readonly quad: WebGLBuffer;
  private readonly sourceTex: WebGLTexture;
  private grid: TileGrid | null = null;
  private targets: TileTarget[] = [];
  private baseBytes = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = createGlContext(canvas);
    const gl = this.ctx.gl;
    this.gl = gl;
    this.program = createProgram(gl, FILTER_VERT, FILTER_FRAG);
    this.loc = uniformLocs(gl, this.program, [
      'u_viewportSize', 'u_sampleOrigin', 'u_src', 'u_frameSize',
      'u_brightness', 'u_sharpen', 'u_distortion',
    ]);
    this.quad = createQuadBuffer(gl);
    this.sourceTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  get tileGrid(): TileGrid | null {
    return this.grid;
  }

  /** 按帧尺寸/网格重建 FBO（奇数尺寸同样逐块精确分配）。 */
  configure(width: number, height: number, cols: number, rows: number, halo: number): TileGrid {
    const gl = this.gl;
    this.deleteTargets();
    this.grid = buildTileGrid(width, height, cols, rows, halo);

    for (const tile of this.grid.tiles) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tile.sampleWidth, tile.sampleHeight);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`分块 ${tile.index} FBO 不完整`);
      }
      this.targets.push({ fbo, texture, timer: createTimer(gl, this.ctx.timerExt) });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.baseBytes = width * height * 4 // 整帧源纹理（RGBA8）
      + this.targets.reduce((sum, _, i) => sum + this.grid!.tiles[i].sampleWidth * this.grid!.tiles[i].sampleHeight * 4, 0);
    return this.grid;
  }

  /** 上传一整帧（VideoFrame 经 texImage2D，内部保持原始 4K 分辨率）。 */
  uploadFrame(frame: VideoFrame): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // @ts-expect-error lib.dom 类型在部分 TS 版本缺少 VideoFrame 重载
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }

  /** 渲染全部分块，返回逐块性能与显存统计。 */
  renderFrame(frameIndex: number, params: FilterParams): FramePerf {
    if (!this.grid) throw new Error('尚未调用 configure()');
    const gl = this.gl;
    const grid = this.grid;
    const perfTiles: TilePerf[] = [];
    const t0 = performance.now();

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.uniform1i(this.loc.u_src, 0);
    gl.uniform2f(this.loc.u_frameSize, grid.frameWidth, grid.frameHeight);
    gl.uniform1f(this.loc.u_brightness, params.brightness);
    gl.uniform1f(this.loc.u_sharpen, params.sharpen);
    gl.uniform1f(this.loc.u_distortion, params.distortion);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const posLoc = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    for (const tile of grid.tiles) {
      const target = this.targets[tile.index];
      const wallStart = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, tile.sampleWidth, tile.sampleHeight);
      gl.uniform2f(this.loc.u_viewportSize, tile.sampleWidth, tile.sampleHeight);
      gl.uniform2f(this.loc.u_sampleOrigin, tile.sx0, tile.sy0);
      if (target.timer) gl.beginQuery(this.ctx.timerExt!.TIME_ELAPSED_EXT, target.timer.query);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (target.timer) gl.endQuery(this.ctx.timerExt!.TIME_ELAPSED_EXT);
      gl.finish();
      const wallMs = performance.now() - wallStart;
      let gpuNanos: number | null = null;
      if (target.timer && pollTimer(gl, this.ctx.timerExt!, target.timer)) gpuNanos = target.timer.nanos;
      perfTiles.push({
        index: tile.index, col: tile.col, row: tile.row,
        width: tile.width, height: tile.height,
        sampleWidth: tile.sampleWidth, sampleHeight: tile.sampleHeight,
        wallMs, gpuNanos, bytes: this.tileBytes(tile),
      });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const totalWallMs = performance.now() - t0;
    const gpuMsList = perfTiles.map((t) => t.gpuNanos).filter((v): v is number => v !== null);
    return {
      frameIndex,
      tiles: perfTiles,
      totalWallMs,
      totalGpuMs: gpuMsList.length ? gpuMsList.reduce((a, b) => a + b, 0) / 1e6 : null,
      allocatedBytes: this.baseBytes,
      deviceBytes: this.queryDeviceBytes(),
    };
  }

  /** 把某块的核心区（去掉 halo）绘制到目标 2D canvas，用于滚动浏览与编码。 */
  blitTileCore(tileIndex: number, dest: CanvasRenderingContext2D): void {
    if (!this.grid) throw new Error('尚未调用 configure()');
    const gl = this.gl;
    const tile = this.grid.tiles[tileIndex];
    const target = this.targets[tileIndex];
    const w = tile.sampleWidth;
    const h = tile.sampleHeight;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d')!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // WebGL 原点在左下，翻回图像坐标
    const imageData = tctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w * 4;
      imageData.data.set(pixels.subarray(srcRow, srcRow + w * 4), y * w * 4);
    }
    tctx.putImageData(imageData, 0, 0);
    // 仅拷贝核心区，halo 丢弃 => 块间无缝
    dest.drawImage(tmp, tile.haloLeft, tile.haloTop, tile.width, tile.height, 0, 0, tile.width, tile.height);
  }

  getTarget(tileIndex: number): { fbo: WebGLFramebuffer; texture: WebGLTexture; tile: TileRect } {
    const tile = this.grid!.tiles[tileIndex];
    return { fbo: this.targets[tileIndex].fbo, texture: this.targets[tileIndex].texture, tile };
  }

  /** 仅重绘单个分块（滚动懒渲染用），uniform/视口与整帧路径完全一致。 */
  renderSingleTile(tileIndex: number, params: FilterParams): number {
    if (!this.grid) throw new Error('尚未调用 configure()');
    const gl = this.gl;
    const tile = this.grid.tiles[tileIndex];
    const target = this.targets[tileIndex];
    const start = performance.now();
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.uniform1i(this.loc.u_src, 0);
    gl.uniform2f(this.loc.u_frameSize, this.grid.frameWidth, this.grid.frameHeight);
    gl.uniform1f(this.loc.u_brightness, params.brightness);
    gl.uniform1f(this.loc.u_sharpen, params.sharpen);
    gl.uniform1f(this.loc.u_distortion, params.distortion);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const posLoc = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, tile.sampleWidth, tile.sampleHeight);
    gl.uniform2f(this.loc.u_viewportSize, tile.sampleWidth, tile.sampleHeight);
    gl.uniform2f(this.loc.u_sampleOrigin, tile.sx0, tile.sy0);
    if (target.timer) gl.beginQuery(this.ctx.timerExt!.TIME_ELAPSED_EXT, target.timer.query);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (target.timer) gl.endQuery(this.ctx.timerExt!.TIME_ELAPSED_EXT);
    gl.finish();
    return performance.now() - start;
  }

  private tileBytes(tile: TileRect): number {
    // 私有 FBO 全尺寸 + 共享源纹理中采样区的折算占用
    return tile.sampleWidth * tile.sampleHeight * 4 + estimateTileBytes(tile) / 2;
  }

  private queryDeviceBytes(): number | null {
    const debug = this.gl.getExtension('WEBGL_debug_renderer_info');
    if (!debug) return null;
    // 标准 Web 无显存查询 API；返回 null 表示不可得，统计以 allocatedBytes 为准
    return null;
  }

  private deleteTargets(): void {
    const gl = this.gl;
    for (const target of this.targets) {
      if (target.timer) gl.deleteQuery(target.timer.query);
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.texture);
    }
    this.targets = [];
  }

  dispose(): void {
    this.deleteTargets();
    this.gl.deleteTexture(this.sourceTex);
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteProgram(this.program);
  }
}
