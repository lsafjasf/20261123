import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticMp4 } from './fixtures.ts';
import { inspect, clean, verify } from '../src/service.ts';
import { NodeFileReader } from '../src/node-reader.ts';
import { parseFile } from '../src/mp4.ts';
import { buildManifest } from '../src/sample-table.ts';
import { CATEGORIES, type CategoryId } from '../src/types.ts';

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vidpriv-'));
  const fixture = buildSyntheticMp4();
  const videoPath = join(dir, 'clip.mp4');
  await writeFile(videoPath, fixture.bytes);

  // Sidecar files that must be reported, never touched.
  await writeFile(join(dir, 'clip.xmp'), '<x:xmpmeta/>');
  await writeFile(join(dir, 'clip.json'), JSON.stringify({ geoData: {} }));
  await writeFile(join(dir, '._clip.mp4'), 'appledouble');
  await writeFile(join(dir, 'clip.aae'), '<adjustments/>');
  await writeFile(join(dir, 'clip.thm'), 'thumb');
  await writeFile(join(dir, 'unrelated.txt'), 'keep me');
  return dir;
}

test('inspect finds all four privacy categories and sidecars', async () => {
  const dir = await makeWorkspace();
  const report = await inspect(join(dir, 'clip.mp4'));
  const ids = new Set(report.findings.map((f) => f.category));
  for (const category of CATEGORIES) assert.ok(ids.has(category.id), `缺少类别 ${category.id}`);
  assert.ok(report.findings.some((f) => f.key === 'covr'));
  assert.ok(report.findings.some((f) => f.boxType === 'uuid' && f.confidence === 'confirmed'));
  assert.ok(report.findings.some((f) => f.risk === 'breaks-timing') === false);

  const sidecarNames = report.sidecars.map((s) => s.path);
  assert.ok(sidecarNames.some((p) => p.endsWith('clip.xmp')));
  assert.ok(sidecarNames.some((p) => p.endsWith('clip.json')));
  assert.ok(sidecarNames.some((p) => p.endsWith('._clip.mp4')));
  assert.ok(sidecarNames.some((p) => p.endsWith('clip.aae')));
  assert.ok(!sidecarNames.some((p) => p.endsWith('unrelated.txt')));
});

test('clean rewrites container only and keeps coded bytes identical', async () => {
  const dir = await makeWorkspace();
  const input = join(dir, 'clip.mp4');
  const output = join(dir, 'clip.cleaned.mp4');
  const result = await clean(input, {
    categories: new Set(CATEGORIES.map((c) => c.id)),
    includeReview: false,
    output,
    manifestPath: join(dir, 'hashes.json'),
    perSampleHashes: false,
  });

  assert.equal(result.reencoded, false);
  assert.equal(result.hashMatch, true);
  assert.ok(result.removed.length > 0);
  assert.ok(result.freeSpaceBytes > 0);

  const before = buildSyntheticMp4();
  const afterBytes = await readFile(output);
  // The coded sample window must be byte-identical at the same file offset.
  assert.deepEqual(
    afterBytes.subarray(before.codedStart, before.codedStart + before.codedBytes.length),
    before.codedBytes,
  );

  // Output still parses as valid ISO-BMFF.
  const reader = await NodeFileReader.create(output);
  try {
    const root = await parseFile(reader);
    const manifest = await buildManifest(reader, root, 'clip.cleaned.mp4');
    assert.equal(manifest.tracks[0]?.samplesHash, result.beforeManifest.tracks[0]?.samplesHash);
    assert.equal(
      manifest.mdats[0]?.payloadHash,
      result.beforeManifest.mdats[0]?.payloadHash,
    );
  } finally {
    await reader.close();
  }

  // Removed textual privacy data must no longer appear anywhere in output.
  assert.ok(!afterBytes.includes(Buffer.from('Pixel-Test 9')));
  assert.ok(!afterBytes.includes(Buffer.from('31.2304')));
  assert.ok(!afterBytes.includes(Buffer.from('stEvt:action')));
  // Slack space is zeroed, not left as deleted-but-recoverable text.
  const freeHits = countFreeBoxes(afterBytes);
  assert.ok(freeHits >= result.removed.length);

  // Sidecar files remain untouched on disk.
  assert.equal((await readFile(join(dir, 'clip.xmp'))).toString(), '<x:xmpmeta/>');

  // verify subcommand reproduces the same conclusion from the saved manifest.
  const checked = await verify(output, join(dir, 'hashes.json'));
  assert.equal(checked.match, true);
});

test('review-only items are kept unless explicitly included', async () => {
  const dir = await makeWorkspace();
  const input = join(dir, 'clip.mp4');
  const output = join(dir, 'out.mp4');
  const result = await clean(input, {
    categories: new Set<CategoryId>(['edit-history']),
    includeReview: false,
    output,
    perSampleHashes: false,
  });
  // XMP edit history is confirmed and removable; C2PA is review and must stay.
  assert.ok(result.removed.some((f) => f.boxType === 'uuid' && f.key?.startsWith('be7a')));
  assert.ok(result.keptForReview.some((f) => f.key?.startsWith('d8fe')));
  const afterBytes = await readFile(output);
  assert.ok(afterBytes.includes(Buffer.from('JUMBF-C2PA-TEST')));

  const inclusive = await clean(input, {
    categories: new Set<CategoryId>(['edit-history']),
    includeReview: true,
    output: join(dir, 'out2.mp4'),
    perSampleHashes: false,
  });
  // C2PA still removed only when review allowed; elst-style timing boxes would never be.
  assert.ok(inclusive.removed.some((f) => f.key?.startsWith('d8fe')));
  const after2 = await readFile(join(dir, 'out2.mp4'));
  assert.ok(!after2.includes(Buffer.from('JUMBF-C2PA-TEST')));
});

test('tampered output fails verification', async () => {
  const dir = await makeWorkspace();
  const input = join(dir, 'clip.mp4');
  const output = join(dir, 'clip.cleaned.mp4');
  const manifest = join(dir, 'hashes.json');
  await clean(input, {
    categories: new Set(CATEGORIES.map((c) => c.id)),
    includeReview: true,
    output,
    manifestPath: manifest,
    perSampleHashes: false,
  });
  const bytes = await readFile(output);
  const fixture = buildSyntheticMp4();
  // Flip a byte inside the coded sample, not in free-box slack space.
  bytes[fixture.codedStart + 3] = (bytes[fixture.codedStart + 3] ?? 0) ^ 0xff;
  await writeFile(join(dir, 'tampered.mp4'), bytes);
  const checked = await verify(join(dir, 'tampered.mp4'), manifest);
  assert.equal(checked.match, false);
});

function countFreeBoxes(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i + 8 <= buf.length; i++) {
    if (buf.toString('ascii', i + 4, i + 8) === 'free') {
      const size = buf.readUInt32BE(i);
      if (size >= 8 && i + size <= buf.length) {
        count++;
        i += size - 1;
      }
    }
  }
  return count;
}

