// Node-side self test for everything that does not need a real browser:
// determinism of the generator, muxer structure, metrics, aggregation,
// type stripping, and a full harness round trip with a simulated browser.
//
// Run: node test/selftest.ts

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createPrng, hashString } from '../src/shared/prng.ts';
import { buildMatrix } from '../src/shared/matrix.ts';
import { generateFrame, videoFrameLayout, chromaLayout } from '../src/shared/frames.ts';
import { frameToRgba, deviation, distribution } from '../src/shared/metrics.ts';
import { muxFmp4, listBoxes } from '../src/shared/fmp4.ts';
import { summarizeConfig } from '../src/shared/result.ts';
import type { RunResult } from '../src/shared/result.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// --- PRNG determinism -------------------------------------------------
{
  const a = createPrng(123);
  const b = createPrng(123);
  const c = createPrng(124);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  check('prng: same seed same sequence', seqA.every((v, i) => v === seqB[i]));
  check('prng: different seed differs', seqA.some((v, i) => v !== seqC[i]));
  check('prng: hash stable', hashString('avc1') === hashString('avc1') && hashString('a') !== hashString('b'));
}

// --- Frame generation determinism -------------------------------------
{
  const f1 = generateFrame('cfg-x', 320, 180, 'I420', 5);
  const f2 = generateFrame('cfg-x', 320, 180, 'I420', 5);
  const f3 = generateFrame('cfg-x', 320, 180, 'I420', 6);
  const f4 = generateFrame('cfg-y', 320, 180, 'I420', 5);
  const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);
  check('frames: identical inputs identical bytes', same(f1.data, f2.data));
  check('frames: index changes output', !same(f1.data, f3.data));
  check('frames: seed changes output', !same(f1.data, f4.data));
  const nv12 = generateFrame('cfg-x', 320, 180, 'NV12', 5);
  const i444 = generateFrame('cfg-x', 320, 180, 'I444', 5);
  check('frames: NV12 packed size', nv12.data.length === 320 * 180 * 1.5);
  check('frames: I444 packed size', i444.data.length === 320 * 180 * 3);
  check('frames: NV12 layout has 2 planes', videoFrameLayout(nv12).length === 2);
  check('frames: I420 layout has 3 planes', videoFrameLayout(f1).length === 3);
  check('frames: chroma layout subsampling', chromaLayout('I422').planes[1].subY === 0);
}

// --- Metrics -----------------------------------------------------------
{
  const black = generateFrame('k', 64, 64, 'I420', 0);
  const rgba = frameToRgba(black);
  check('metrics: rgba size', rgba.length === 64 * 64 * 4);
  const d0 = deviation(rgba, rgba);
  check('metrics: identical frames zero deviation', d0.mae === 0 && d0.psnrDb === Infinity);
  const base = new Uint8ClampedArray(400).fill(100);
  const shifted = new Uint8ClampedArray(400).fill(110);
  const d1 = deviation(base, shifted);
  check('metrics: constant shift gives mae 10', Math.abs(d1.mae - 10) < 0.001, `mae=${d1.mae}`);
  const dist = distribution([2, 4, 4, 4, 5, 5, 7, 9]);
  check('metrics: distribution mean/std', dist.mean === 5 && Math.abs(dist.stddev - 2) < 1e-9);
}

// --- fMP4 muxer ---------------------------------------------------------
{
  const avcC = new Uint8Array([1, 100, 0, 40, 255, 0xe1, 0, 4, 1, 2, 3, 4, 1, 0, 4, 5, 6, 7, 8]);
  const samples = [
    { data: new Uint8Array([9, 9, 9]), duration: 3000, keyframe: true, ctsOffset: 0 },
    { data: new Uint8Array([7, 7]), duration: 3000, keyframe: false, ctsOffset: 0 },
    { data: new Uint8Array([5]), duration: 3000, keyframe: false, ctsOffset: 0 },
  ];
  const mp4 = muxFmp4(
    { codecId: 'avc1', codecString: 'avc1.640028', width: 320, height: 180, timescale: 90000, description: avcC },
    samples,
  );
  const top = listBoxes(mp4).map((b) => b.type);
  check('muxer: top-level boxes', top.join(',') === 'ftyp,moov,moof,mdat', top.join(','));
  const text = Array.from(mp4).map((b) => String.fromCharCode(b)).join('');
  for (const needle of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC', 'mvex', 'trex', 'mfhd', 'traf', 'tfhd', 'tfdt', 'trun']) {
    check(`muxer: contains ${needle}`, text.includes(needle));
  }
  const mdat = listBoxes(mp4).find((b) => b.type === 'mdat')!;
  check('muxer: mdat size matches samples', mdat.size === 8 + 3 + 2 + 1);
  const vp9 = muxFmp4(
    { codecId: 'vp09', codecString: 'vp09.00.10.08', width: 64, height: 64, timescale: 90000 },
    [{ data: new Uint8Array([1]), duration: 3000, keyframe: true, ctsOffset: 0 }],
  );
  check('muxer: vp09 sample entry', Array.from(vp9).map((b) => String.fromCharCode(b)).join('').includes('vpcC'));
}

// --- Matrix --------------------------------------------------------------
{
  const a = buildMatrix({ full: false, frames: 48 });
  const b = buildMatrix({ full: false, frames: 48 });
  check('matrix: deterministic order', a.map((c) => c.id).join() === b.map((c) => c.id).join());
  check('matrix: unique ids', new Set(a.map((c) => c.id)).size === a.length);
  check('matrix: covers all chroma formats', ['i420', 'nv12', 'i422', 'i444'].every((c) => a.some((x) => x.id.includes(`_${c}_`))));
  check('matrix: covers all fps', [24, 30, 60].every((f) => a.some((x) => x.fps === f)));
  const only = buildMatrix({ full: false, frames: 48, only: a[0].id });
  check('matrix: --only filters', only.length === 1 && only[0].id === a[0].id);
}

// --- Aggregation ---------------------------------------------------------
{
  const mk = (status: 'pass' | 'fail', ttff: number): RunResult => ({
    configId: 'c', runIndex: 0, status,
    failStage: status === 'fail' ? 'encode' : undefined,
    claimedSupport: { encoder: true, decoder: true, mse: true },
    timing: { generateMs: 1, encodeMs: 10, firstChunkMs: 2, decodeMs: 5, ttffMs: ttff, mseMs: null },
    memory: { peakJsHeapBytes: 1_000_000 },
    quality: { mae: 1, psnrDb: 40, framesCompared: 48 },
    frames: { expected: 48, encoded: 48, decoded: 48 },
    mse: 'pass', userAgent: 'ua', platform: 'p', startedAt: '', durationMs: 1,
  });
  check('aggregate: stable pass', summarizeConfig('c', [mk('pass', 10), mk('pass', 11)]).conclusion === 'pass');
  check('aggregate: stable fail', summarizeConfig('c', [mk('fail', 10), mk('fail', 10)]).conclusion === 'fail');
  check('aggregate: flaky', summarizeConfig('c', [mk('pass', 10), mk('fail', 10)]).conclusion === 'flaky');
  const s = summarizeConfig('c', [mk('pass', 10), mk('pass', 14)]);
  check('aggregate: ttff stats', s.ttffMs !== null && s.ttffMs.mean === 12 && s.ttffMs.cv > 0);
}

// --- Type stripping of browser modules -----------------------------------
{
  const dir = join(ROOT, 'src/browser');
  const tmp = mkdtempSync(join(tmpdir(), 'selftest-strip-'));
  let allOk = true;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const stripped = stripTypeScriptTypes(readFileSync(join(dir, file), 'utf8'), { mode: 'strip' });
    const out = join(tmp, file.replace(/\.ts$/, '.mjs'));
    writeFileSync(out, stripped);
    const res = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
    if (res.status !== 0) {
      allOk = false;
      console.log(`  syntax error in ${file}: ${res.stderr}`);
    }
  }
  check('strip: browser modules parse as JS', allOk);
  rmSync(tmp, { recursive: true, force: true });
}

// --- Harness end to end with a simulated browser -------------------------
{
  const outDir = mkdtempSync(join(tmpdir(), 'selftest-report-'));
  const port = 23000 + Math.floor(Math.random() * 2000);
  const child = spawn(
    process.execPath,
    [join(ROOT, 'src/node/harness.ts'), '--only', 'avc1-bl_320x180_24fps_i420_128k', '--repeat', '1', '--port', String(port), '--out', outDir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverUp = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('bench server')) serverUp = true;
  });
  const deadline = Date.now() + 15000;
  while (!serverUp && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  check('harness: server starts', serverUp);
  if (serverUp) {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    check('harness: index served', page.ok && (await page.text()).includes('runner.ts'));
    const mod = await fetch(`http://127.0.0.1:${port}/src/browser/runner.ts`);
    const modText = await mod.text();
    check('harness: ts stripped to js', mod.ok && !modText.includes('interface ') && modText.includes('fetch'));
    const cfgRes = await fetch(`http://127.0.0.1:${port}/api/config?id=avc1-bl_320x180_24fps_i420_128k`);
    const cfgJson = (await cfgRes.json()) as { config: { id: string } };
    check('harness: config api', cfgJson.config.id === 'avc1-bl_320x180_24fps_i420_128k');
    const fake = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/pass-result.json'), 'utf8')) as RunResult;
    const post = await fetch(`http://127.0.0.1:${port}/api/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fake),
    });
    check('harness: result accepted', post.ok);
    const exitCode = await new Promise((r) => child.on('exit', r));
    check('harness: exit code 0 on pass', exitCode === 0, `got ${exitCode}`);
    check('harness: report.json written', existsSync(join(outDir, 'report.json')));
    const md = readFileSync(join(outDir, 'report.md'), 'utf8');
    check('harness: report.md lists config', md.includes('avc1-bl_320x180_24fps_i420_128k'));
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    check('harness: summary conclusion pass', report.summaries[0].conclusion === 'pass');
  } else {
    child.kill('SIGKILL');
  }
  rmSync(outDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall self tests passed' : `\n${failures} self test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
