import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTileGrid, axisCuts, assertFullCoverage, estimateTileBytes } from '../shared/tiling.ts';

test('axisCuts 处理奇数尺寸且首尾相接', () => {
  assert.deepEqual(axisCuts(7, 3), [0, 2, 4, 7]);
  assert.deepEqual(axisCuts(3840, 2), [0, 1920, 3840]);
  assert.deepEqual(axisCuts(2161, 2), [0, 1080, 2161]);
});

test('偶数 4K 2x2 网格核心区铺满且无重叠', () => {
  const grid = buildTileGrid(3840, 2160, 2, 2, 16);
  assertFullCoverage(grid);
  assert.equal(grid.tiles[0].width, 1920);
  assert.equal(grid.tiles[0].height, 1080);
  // 左上块：左/上贴边 halo 被裁，右/下 halo 完整
  const t0 = grid.tiles[0];
  assert.equal(t0.haloLeft, 0);
  assert.equal(t0.haloTop, 0);
  assert.equal(t0.haloRight, 16);
  assert.equal(t0.haloBottom, 16);
  assert.equal(t0.sampleWidth, 1936);
  assert.equal(t0.sampleHeight, 1096);
  // 右下块右/下贴边
  const t3 = grid.tiles[3];
  assert.equal(t3.haloRight, 0);
  assert.equal(t3.haloBottom, 0);
  assert.equal(t3.sx1, 3840);
  assert.equal(t3.sy1, 2160);
});

test('奇数尺寸 3x3 网格精确拼接', () => {
  const grid = buildTileGrid(1921, 1081, 3, 3, 8);
  assertFullCoverage(grid);
  const widths = grid.tiles.filter((t) => t.row === 0).map((t) => t.width);
  assert.deepEqual(widths, [640, 640, 641]);
  const heights = grid.tiles.filter((t) => t.col === 0).map((t) => t.height);
  assert.deepEqual(heights, [360, 360, 361]);
});

test('halo 为 0 时采样区等于核心区', () => {
  const grid = buildTileGrid(10, 10, 2, 2, 0);
  for (const t of grid.tiles) {
    assert.equal(t.sampleWidth, t.width);
    assert.equal(t.sampleHeight, t.height);
  }
  assertFullCoverage(grid);
});

test('网格大于帧尺寸时仍合法（1px 块）', () => {
  const grid = buildTileGrid(3, 1, 5, 1, 2);
  assertFullCoverage(grid);
  assert.equal(grid.tiles.length, 5);
});

test('非法参数抛错', () => {
  assert.throws(() => buildTileGrid(0, 10, 2, 2, 1));
  assert.throws(() => buildTileGrid(10, 10, 0, 2, 1));
  assert.throws(() => buildTileGrid(10, 10, 2, 2, -1));
});

test('显存估算随采样区线性增长', () => {
  const grid = buildTileGrid(100, 100, 2, 2, 4);
  const corner = estimateTileBytes(grid.tiles[0]);
  assert.equal(corner, 54 * 54 * 4 * 2);
});
