import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTileGrid, assertFullCoverage, estimateTileBytes } from '../shared/tiling.ts';
import { renderPixel, makeEdgeClampSampler, type FilterParams } from '../shared/filters.ts';
import { WebmMuxer } from '../web/webmMuxer.ts';

// 模拟浏览器导出循环：分块 GPU 渲染在 Node 无 WebGL，用 CPU 参考实现
// 逐块产出核心区并拼接，验证统计字段、奇数尺寸拼接与封装可消费性。

interface SimTilePerf {
  index: number;
  wallMs: number;
  gpuNanos: number;
  bytes: number;
}

function simulateFrame(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  cols: number,
  rows: number,
  halo: number,
  params: FilterParams,
): { stitched: Uint8ClampedArray; perTile: SimTilePerf[]; frameBytes: number } {
  const grid = buildTileGrid(width, height, cols, rows, halo);
  assertFullCoverage(grid);
  const sampler = makeEdgeClampSampler(src, width, height);
  const stitched = new Uint8ClampedArray(width * height * 4);
  const perTile: SimTilePerf[] = [];
  let frameBytes = 0;

  for (const tile of grid.tiles) {
    const start = performance.now();
    for (let y = tile.y0; y < tile.y1; y++) {
      for (let x = tile.x0; x < tile.x1; x++) {
        const [r, g, b] = renderPixel(x, y, width, height, params, sampler);
        const off = (y * width + x) * 4;
        stitched[off] = Math.round(r * 255);
        stitched[off + 1] = Math.round(g * 255);
        stitched[off + 2] = Math.round(b * 255);
        stitched[off + 3] = 255;
      }
    }
    const wallMs = performance.now() - start;
    const bytes = estimateTileBytes(tile);
    frameBytes += bytes;
    perTile.push({ index: tile.index, wallMs, gpuNanos: wallMs * 1e6, bytes });
  }
  return { stitched, perTile, frameBytes };
}

test('多帧导出循环：奇数尺寸拼接稳定、统计可聚合、WebM 持续可写', () => {
  const width = 1921;
  const height = 1081;
  const frames = 4;
  const params: FilterParams = { brightness: 1.1, sharpen: 0.5, distortion: 0.1 };
  const muxer = new WebmMuxer({ id: 1, kind: 'video', codec: 'vp9', width, height });

  const allPerTile: SimTilePerf[][] = [];
  let peakBytes = 0;
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };

  for (let f = 0; f < frames; f++) {
    const src = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = Math.floor(rand() * 255);
      src[i + 1] = Math.floor(rand() * 255);
      src[i + 2] = Math.floor(rand() * 255);
      src[i + 3] = 255;
    }
    const { stitched, perTile, frameBytes } = simulateFrame(src, width, height, 3, 3, 5, params);
    allPerTile.push(perTile);
    peakBytes = Math.max(peakBytes, frameBytes);

    // 每帧拼接结果必须铺满（无透明/未写像素）
    let written = 0;
    for (let i = 3; i < stitched.length; i += 4) if (stitched[i] === 255) written++;
    assert.equal(written, width * height);

    // 封装：首帧关键帧，其余增量
    const chunk = muxer.muxVideo({
      data: stitched.subarray(0, 64),
      timestampMicros: f * 33333,
      isKey: f === 0,
    });
    assert.ok(chunk.length > 0);
  }
  muxer.flush();
  const webm = muxer.build();
  assert.deepEqual(Array.from(webm.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);

  // 统计聚合：9 块 x 4 帧，每块都有平均耗时
  assert.equal(allPerTile.length, frames);
  assert.equal(allPerTile[0].length, 9);
  const tileCount = 9;
  for (let t = 0; t < tileCount; t++) {
    const avg = allPerTile.reduce((sum, frame) => sum + frame[t].wallMs, 0) / frames;
    assert.ok(avg >= 0);
  }
  assert.ok(peakBytes > 0);
});

test('halo 扩大只增加采样区，不改变核心区拼接边界', () => {
  const params: FilterParams = { brightness: 1, sharpen: 0.4, distortion: 0 };
  const src = new Uint8ClampedArray(31 * 17 * 4);
  for (let i = 0; i < src.length; i++) src[i] = (i * 7) % 256;
  const a = simulateFrame(src, 31, 17, 2, 2, 0, params).stitched;
  const b = simulateFrame(src, 31, 17, 2, 2, 8, params).stitched;
  // 锐化在 halo=0 时边缘钳制与 halo=8 不同，中心区域应一致；
  // 这里校验尺寸与铺满，差异仅允许出现在块边缘 1px
  assert.equal(a.length, b.length);
  let innerDiffs = 0;
  const grid = buildTileGrid(31, 17, 2, 2, 8);
  const boundary = new Set<number>();
  for (const tile of grid.tiles) {
    for (let x = tile.x0; x < tile.x1; x++) {
      boundary.add(tile.y0 * 31 + x);
      boundary.add((tile.y1 - 1) * 31 + x);
    }
  }
  for (let p = 0; p < 31 * 17; p++) {
    if (boundary.has(p)) continue;
    for (let c = 0; c < 4; c++) {
      if (a[p * 4 + c] !== b[p * 4 + c]) innerDiffs++;
    }
  }
  assert.equal(innerDiffs, 0, '非块边缘像素不应受 halo 宽度影响');
});
