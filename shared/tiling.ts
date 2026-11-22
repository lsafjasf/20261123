// 分块网格计算：支持奇数尺寸、带重叠边界（halo）的按帧分块。
// 纯函数、无平台依赖，Node 与浏览器共用。

export interface TileRect {
  /** 分块序号（行优先，从 0 开始） */
  index: number;
  col: number;
  row: number;
  /** 输出（核心区）在整帧中的像素范围，左闭右开 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 采样区（核心区 + 重叠 halo，再按帧边界裁剪） */
  sx0: number;
  sy0: number;
  sx1: number;
  sy1: number;
  /** 输出核心区宽高（奇数也精确） */
  width: number;
  height: number;
  /** 采样区宽高 */
  sampleWidth: number;
  sampleHeight: number;
  /** 各边实际可用 halo（贴边时小于请求值） */
  haloLeft: number;
  haloTop: number;
  haloRight: number;
  haloBottom: number;
}

export interface TileGrid {
  frameWidth: number;
  frameHeight: number;
  cols: number;
  rows: number;
  halo: number;
  tiles: TileRect[];
}

/**
 * 把任意尺寸（含奇数）帧切成 cols x rows 块，每块外扩 halo 像素作为重叠边界。
 * 核心区采用 floor/ceil 边界分配，保证并集恰好覆盖整帧、互不重叠。
 */
export function buildTileGrid(
  frameWidth: number,
  frameHeight: number,
  cols: number,
  rows: number,
  halo: number,
): TileGrid {
  if (!Number.isInteger(frameWidth) || !Number.isInteger(frameHeight) ||
      frameWidth <= 0 || frameHeight <= 0) {
    throw new Error(`非法帧尺寸: ${frameWidth}x${frameHeight}`);
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new Error(`非法网格: ${cols}x${rows}`);
  }
  if (!Number.isInteger(halo) || halo < 0) {
    throw new Error(`非法重叠宽度: ${halo}`);
  }

  const xs = axisCuts(frameWidth, cols);
  const ys = axisCuts(frameHeight, rows);
  const tiles: TileRect[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = xs[col];
      const x1 = xs[col + 1];
      const y0 = ys[row];
      const y1 = ys[row + 1];
      const sx0 = Math.max(0, x0 - halo);
      const sy0 = Math.max(0, y0 - halo);
      const sx1 = Math.min(frameWidth, x1 + halo);
      const sy1 = Math.min(frameHeight, y1 + halo);
      tiles.push({
        index: row * cols + col,
        col,
        row,
        x0, y0, x1, y1,
        sx0, sy0, sx1, sy1,
        width: x1 - x0,
        height: y1 - y0,
        sampleWidth: sx1 - sx0,
        sampleHeight: sy1 - sy0,
        haloLeft: x0 - sx0,
        haloTop: y0 - sy0,
        haloRight: sx1 - x1,
        haloBottom: sy1 - y1,
      });
    }
  }

  return { frameWidth, frameHeight, cols, rows, halo, tiles };
}

/**
 * 单轴切分：边界用 floor(i * size / n)，天然处理奇数尺寸，
 * 相邻块首尾相接（cuts[i+1] === cuts[i] 下一段起点）。
 */
export function axisCuts(size: number, n: number): number[] {
  const cuts: number[] = [];
  for (let i = 0; i <= n; i++) cuts.push(Math.floor((i * size) / n));
  return cuts;
}

/** 校验核心区无重叠、无遗漏地铺满整帧（供测试与调试断言）。 */
export function assertFullCoverage(grid: TileGrid): void {
  const { frameWidth: w, frameHeight: h, cols, rows, tiles } = grid;
  const seen = new Uint8Array(w * h);
  for (const tile of tiles) {
    for (let y = tile.y0; y < tile.y1; y++) {
      for (let x = tile.x0; x < tile.x1; x++) {
        const offset = y * w + x;
        if (seen[offset]) throw new Error(`核心区重叠于 (${x},${y})`);
        seen[offset] = 1;
      }
    }
  }
  let covered = 0;
  for (const value of seen) covered += value;
  if (covered !== w * h) {
    throw new Error(`核心区未铺满: ${covered}/${w * h}`);
  }
  if (tiles.length !== cols * rows) throw new Error('分块数量不符');
  const last = tiles[tiles.length - 1];
  if (last.x1 !== w || last.y1 !== h) throw new Error('右/下边界未对齐帧边缘');
}

/** 估算一块采样区在 GPU 上的字节占用（RGBA32F 纹理 + 同尺寸 FBO 颜色面）。 */
export function estimateTileBytes(tile: TileRect, bytesPerTexel = 4): number {
  const texels = tile.sampleWidth * tile.sampleHeight;
  // 输入纹理 + 输出 FBO 颜色缓冲，各占一份
  return texels * bytesPerTexel * 2;
}
