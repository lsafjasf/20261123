import { test } from 'node:test';
import assert from 'node:assert/strict';
// 浏览器端引擎是纯逻辑 ESM，可直接在 Node 中加载做双端一致性校验。
// @ts-ignore 无类型声明的 JS 模块
import { analyze } from '../src/web/lib/engine.js';
import { analyzeBundle } from '../src/shared/engine.ts';
import { DEFAULT_CONFIG } from '../src/shared/config.ts';
import { buildBundle, FIXTURE_SPECS } from '../src/server/fixtures.ts';

test('双端引擎一致：浏览器 JS 引擎与 Node TS 引擎对同批指标给出相同区间', () => {
  for (const spec of FIXTURE_SPECS) {
    const bundle = buildBundle(spec);
    const web = analyze(bundle.frames, bundle.video.frameRate, DEFAULT_CONFIG);
    const node = analyzeBundle(bundle, DEFAULT_CONFIG, new Date('2026-01-01T00:00:00Z'));
    assert.deepEqual(
      web.black.map((r: { start: number; end: number }) => [r.start, r.end]),
      node.black.map((segment) => {
        const start = bundle.frames.findIndex((f) => f.index === segment.startFrame);
        const end = bundle.frames.findIndex((f) => f.index === segment.endFrame);
        return [start, end];
      }),
      `${spec.name} 黑场区间不一致`,
    );
    assert.equal(web.shots.length, node.shots.length, `${spec.name} 镜头数不一致`);
    assert.equal(web.shake.length, node.shake.length, `${spec.name} 抖动区间不一致`);
    assert.equal(web.freeze.length, node.freeze.length, `${spec.name} 静止区间不一致`);
    assert.equal(web.cuts.length, node.shots.length - 1, `${spec.name} 切点数应等于镜头数-1`);
  }
});
