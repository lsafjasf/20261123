import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distortInverse,
  renderFrameCpu,
  renderPixel,
  makeEdgeClampSampler,
  DEFAULT_FILTER,
  type FilterParams,
} from '../shared/filters.ts';
import { buildTileGrid } from '../shared/tiling.ts';

test('畸变逆映射：零系数恒等、中心不动、桶形外点向内收', () => {
  assert.deepEqual(distortInverse(0.3, -0.2, 0), [0.3, -0.2]);
  const [cx, cy] = distortInverse(0, 0, 0.3);
  assert.equal(cx, 0);
  assert.equal(cy, 0);
  const [dx] = distortInverse(0.8, 0, 0.2);
  assert.ok(dx < 0.8, '桶形畸变采样半径应小于输出半径');
  // 反演精度：正向映射回来应接近原半径
  const rin = dx;
  const back = rin * (1 + 0.2 * rin * rin);
  assert.ok(Math.abs(back - 0.8) < 1e-5);
});

test('renderPixel 与分块无关：同坐标结果逐位相同（重叠区一致性）', () => {
  const w = 37;
  const h = 23;
  const src = makeNoise(w, h);
  const sampler = makeEdgeClampSampler(src, w, h);
  const params: FilterParams = { brightness: 1.1, sharpen: 0.5, distortion: 0.15 };
  const ref = renderPixel(10, 7, w, h, params, sampler);
  // 即使该像素分别处于不同分块的 halo / 核心区，函数签名里没有分块信息
  const grid = buildTileGrid(w, h, 3, 2, 4);
  for (const tile of grid.tiles) {
    const inSampleX = 10 >= tile.sx0 && 10 < tile.sx1;
    const inSampleY = 7 >= tile.sy0 && 7 < tile.sy1;
    if (inSampleX && inSampleY) {
      const got = renderPixel(10, 7, w, h, params, sampler);
      assert.deepEqual(got, ref);
    }
  }
});

test('分块渲染拼接 == 整帧渲染（奇数尺寸 + 全滤镜）', () => {
  const w = 53;
  const h = 41;
  const src = makeNoise(w, h);
  const params: FilterParams = { brightness: 1.06, sharpen: 0.7, distortion: -0.1 };
  const full = renderFrameCpu(src, w, h, params);

  const grid = buildTileGrid(w, h, 3, 3, 2);
  const stitched = new Uint8ClampedArray(w * h * 4);
  const sampler = makeEdgeClampSampler(src, w, h);
  for (const tile of grid.tiles) {
    for (let y = tile.y0; y < tile.y1; y++) {
      for (let x = tile.x0; x < tile.x1; x++) {
        const [r, g, b] = renderPixel(x, y, w, h, params, sampler);
        const off = (y * w + x) * 4;
        stitched[off] = Math.round(r * 255);
        stitched[off + 1] = Math.round(g * 255);
        stitched[off + 2] = Math.round(b * 255);
        stitched[off + 3] = 255;
      }
    }
  }
  // 允许 1 个量化级的舍入差异（两者量化路径相同，实际应完全相等）
  let maxDiff = 0;
  for (let i = 0; i < full.length; i++) maxDiff = Math.max(maxDiff, Math.abs(full[i] - stitched[i]));
  assert.ok(maxDiff <= 1, `最大差异 ${maxDiff}`);
});

test('关闭滤镜时输出近似原图（仅量化误差）', () => {
  const w = 16;
  const h = 16;
  const src = makeNoise(w, h);
  const identity: FilterParams = { brightness: 1, sharpen: 0, distortion: 0 };
  const out = renderFrameCpu(src, w, h, identity);
  let maxDiff = 0;
  for (let i = 0; i < src.length; i++) maxDiff = Math.max(maxDiff, Math.abs(src[i] - out[i]));
  assert.ok(maxDiff <= 1);
});

test('默认参数可构造且范围合法', () => {
  assert.ok(DEFAULT_FILTER.brightness > 0);
  assert.ok(DEFAULT_FILTER.sharpen >= 0);
});

function makeNoise(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 123456789;
  const rand = (): number => {
    // 确定性 LCG，保证测试可复现
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = Math.floor(rand() * 255);
    data[i * 4 + 1] = Math.floor(rand() * 255);
    data[i * 4 + 2] = Math.floor(rand() * 255);
    data[i * 4 + 3] = 255;
  }
  return data;
}
