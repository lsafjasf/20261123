import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticMp4, box, fullBox, u32 } from './fixtures.ts';
import { clean, inspect } from '../src/service.ts';
import type { CategoryId } from '../src/types.ts';
import { planRewrite, rewriteContainer } from '../src/rewriter.ts';
import { NodeFileReader } from '../src/node-reader.ts';
import { parseFile } from '../src/mp4.ts';
import { buildManifest } from '../src/sample-table.ts';

test('elst edit lists are never auto-removed even with include-review', async () => {
  // Inject an edts/elst into the synthetic moov by appending it inside trak.
  const fixture = buildSyntheticMp4();
  const elstPayload = Buffer.concat([
    u32(1),
    u32(1),
    u32(1000),
    u32(0),
    Buffer.from([0, 0, 1, 0]),
  ]);
  const edts = box('edts', fullBox('elst', elstPayload));
  // Simplest reliable placement: append a second top-level edts is non-standard,
  // so instead splice right before the moov box's closing region by rebuilding:
  // locate 'trak' end via the known marker is fragile; insert after mdat end.
  const marker = Buffer.from('moov');
  const moovTypeAt = fixture.bytes.indexOf(marker);
  const moovSizeAt = moovTypeAt - 4;
  const moovSize = fixture.bytes.readUInt32BE(moovSizeAt);
  const moovEnd = moovSizeAt + moovSize;
  const injected = Buffer.concat([
    fixture.bytes.subarray(0, moovEnd),
    edts,
  ]);
  // Grow moov size so the parser still accepts the trailing edts inside moov.
  injected.writeUInt32BE(moovSize + edts.length, moovSizeAt);

  const dir = await mkdtemp(join(tmpdir(), 'vidpriv-elst-'));
  const input = join(dir, 'elst.mp4');
  const output = join(dir, 'elst.out.mp4');
  await writeFile(input, injected);

  const report = await inspect(input);
  const elstFinding = report.findings.find((f) => f.boxType === 'elst');
  assert.ok(elstFinding, '应识别出 elst 编辑时间轴');
  assert.equal(elstFinding!.risk, 'breaks-timing');

  const result = await clean(input, {
    categories: new Set<CategoryId>(['edit-history']),
    includeReview: true,
    output,
    perSampleHashes: false,
  });
  assert.ok(!result.removed.some((f) => f.boxType === 'elst'), 'elst 绝不能被自动删除');
  assert.ok(result.keptForReview.some((f) => f.boxType === 'elst'));
  const after = await readFile(output);
  assert.ok(after.includes(Buffer.from('elst')), 'elst 盒必须保留在输出中');
});

test('rewrite across the 4 MiB stream window preserves every non-removed byte', async () => {
  const fixture = buildSyntheticMp4();
  // Insert a >4 MiB filler box so removed metadata lands after a chunk boundary.
  const bigFiller = box('free', Buffer.alloc(5 * 1024 * 1024, 0x5a));
  const bytes = Buffer.concat([bigFiller, fixture.bytes]);
  const dir = await mkdtemp(join(tmpdir(), 'vidpriv-big-'));
  const input = join(dir, 'big.mp4');
  const output = join(dir, 'big.out.mp4');
  await writeFile(input, bytes);

  const report = await inspect(input);
  const seen = new Set<string>();
  const removable = report.findings.filter((f) => {
    if (f.confidence !== 'confirmed') return false;
    const key = `${f.start}:${f.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  assert.ok(removable.length > 0);
  const plan = planRewrite(removable);
  await rewriteContainer(input, output, plan);

  const before = await readFile(input);
  const after = await readFile(output);
  assert.equal(before.length, after.length, '等长替换不得改变文件大小');

  const removed = new Set(plan.ranges.flatMap((r) => {
    const indexes: number[] = [];
    for (let i = r.start; i < r.end; i++) indexes.push(i);
    return indexes;
  }));
  for (let i = 0; i < before.length; i++) {
    if (!removed.has(i)) assert.equal(before[i], after[i], `字节 ${i} 必须保持不变`);
  }
  // Each removed range now starts with a valid 'free' header.
  for (const range of plan.ranges) {
    assert.equal(after.toString('ascii', range.start + 4, range.start + 8), 'free');
    assert.equal(after.readUInt32BE(range.start), range.end - range.start);
  }

  const reader = await NodeFileReader.create(output);
  try {
    const root = await parseFile(reader);
    const manifest = await buildManifest(reader, root, 'big.out.mp4');
    const beforeReader = await NodeFileReader.create(input);
    try {
      const beforeRoot = await parseFile(beforeReader);
      const beforeManifest = await buildManifest(beforeReader, beforeRoot, 'big.mp4');
      assert.deepEqual(manifest.tracks, beforeManifest.tracks);
      assert.deepEqual(manifest.mdats, beforeManifest.mdats);
    } finally {
      await beforeReader.close();
    }
  } finally {
    await reader.close();
  }
});
