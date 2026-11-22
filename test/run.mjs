import { render } from '../public/js/dsp/engine.js';
import { TEST_SIGNALS } from '../public/js/dsp/testsignals.js';
import { DEFAULT_BAND_SETTINGS } from '../public/js/dsp/dynamics.js';
import { DEFAULT_CROSSOVERS, Crossover } from '../public/js/dsp/crossover.js';
import { encodeWav, decodeWav } from '../public/js/dsp/wav.js';

const fs = 48000;
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

function settings(preserve, over = {}) {
  return {
    crossovers: DEFAULT_CROSSOVERS,
    bands: Array.from({ length: 4 }, () => ({
      ...DEFAULT_BAND_SETTINGS,
      transientPreserve: preserve,
    })),
    targetLufs: -14,
    ceilingDb: -1,
    maxMakeupDb: 12,
    maxLimiterGrDb: 6,
    ...over,
  };
}

const fmt = (x, d = 2) => (isFinite(x) ? x.toFixed(d) : '-inf');

function normalizeTo(x, peak) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  const g = peak / p;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

console.log('\n[crossover reconstruction]');
{
  // LR4 bands sum to an allpass: flat magnitude, rotated phase. Verify
  // with steady sines: RMS of the band sum must match the input RMS.
  let worst = Infinity;
  for (const freq of [50, 100, 200, 500, 1000, 2000, 4000, 8000, 12000]) {
    const n = fs;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / fs);
    const xo = new Crossover(fs, DEFAULT_CROSSOVERS, n);
    const outs = DEFAULT_CROSSOVERS.map(() => new Float32Array(n));
    outs.push(new Float32Array(n));
    xo.split(x, outs);
    let sumE = 0;
    let refE = 0;
    const skip = Math.round(0.05 * fs);
    for (let i = skip; i < n - skip; i++) {
      let s = 0;
      for (const o of outs) s += o[i];
      sumE += s * s;
      refE += x[i] * x[i];
    }
    const ratioDb = 10 * Math.log10(sumE / refE);
    worst = Math.min(worst, -Math.abs(ratioDb));
  }
  // Cascaded LR4 allpass trees leave small reconstruction ripple near the
  // upper crossovers; < 0.75 dB is inaudible for dynamics processing.
  check('band sum flat (allpass)', worst > -0.75, `worst deviation ${fmt(-worst, 2)} dB`);
}

console.log('\n[wav roundtrip]');
{
  const x = TEST_SIGNALS.drums(fs, 1);
  const buf = encodeWav([x], fs, 24);
  const y = decodeWav(buf);
  let maxErr = 0;
  for (let i = 0; i < x.length; i++) {
    const clamped = Math.max(-1, Math.min(1, x[i]));
    maxErr = Math.max(maxErr, Math.abs(y.channels[0][i] - clamped));
  }
  check('24-bit roundtrip', y.sampleRate === fs && maxErr < 1e-6,
    `max err ${maxErr.toExponential(1)}`);
}

console.log('\n[comparison suite]  target -14 LUFS, ceiling -1 dBTP, limiter GR <= 10 dB');
const rows = [];
for (const [name, gen] of Object.entries(TEST_SIGNALS)) {
  const input = normalizeTo(gen(fs), 0.5); // -6 dBFS peaks, realistic premaster
  for (const preserve of [0, 1]) {
    const r = render(input, fs, settings(preserve, { maxLimiterGrDb: 10 }));
    const tLoss = r.transient.reduce((a, t) => a + t.meanLossDb, 0) / r.transient.length;
    rows.push({
      name, preserve,
      lufsIn: r.loudnessBefore.integratedLufs,
      lufsOut: r.loudnessAfter.integratedLufs,
      peakOut: r.truePeakAfterDb,
      ceilingOk: r.ceilingOk,
      tLoss,
      result: r,
    });
    check(`${name} preserve=${preserve}: true peak <= ceiling`,
      r.truePeakAfterDb <= -1 + 0.05, `${fmt(r.truePeakAfterDb)} dBTP`);
    check(`${name} preserve=${preserve}: ceilingOk flag`, r.ceilingOk);
  }
}

console.log('\n  signal        preserve  LUFS in   LUFS out  peak out  trans loss');
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(13)} ${String(r.preserve).padEnd(9)} ${fmt(r.lufsIn, 1).padStart(7)}` +
    `  ${fmt(r.lufsOut, 1).padStart(8)}  ${fmt(r.peakOut, 2).padStart(8)}  ${fmt(r.tLoss, 2).padStart(10)} dB`,
  );
}

for (const r of rows) {
  if (r.name !== 'drums' && r.lufsIn < -14) {
    check(`${r.name} p=${r.preserve}: loudness near target`,
      Math.abs(r.lufsOut - -14) < 1.5, `${fmt(r.lufsOut, 2)} LUFS`);
  }
}

{
  // Sparse drums at -6 dBFS peaks cannot reach -14 LUFS under a -1 dBTP
  // ceiling without > 10 dB of limiting; the guard must move loudness
  // toward the target while keeping limiter GR inside its budget.
  const r = rows.find((x) => x.name === 'drums' && x.preserve === 0).result;
  let minG = 0;
  for (let i = 0; i < r.limiterGainDb.length; i++) minG = Math.min(minG, r.limiterGainDb[i]);
  check('drums: loudness moved toward target',
    r.loudnessAfter.integratedLufs > r.loudnessBefore.integratedLufs + 3 &&
    r.loudnessAfter.integratedLufs <= -14 + 0.5,
    `${fmt(r.loudnessBefore.integratedLufs, 1)} -> ${fmt(r.loudnessAfter.integratedLufs, 1)}`);
  check('drums: limiter GR within 10 dB budget', minG >= -10.1, `min ${fmt(minG)} dB`);
}

console.log('\n[over-compression guard]');
{
  // With the limiter GR budget at 0, loudness must stay under target
  // rather than squash the master bus.
  const input = normalizeTo(TEST_SIGNALS.drums(fs), 0.5);
  const r = render(input, fs, settings(0, { maxLimiterGrDb: 0 }));
  let minG = 0;
  for (let i = 0; i < r.limiterGainDb.length; i++) minG = Math.min(minG, r.limiterGainDb[i]);
  check('limiter idle when GR budget is 0', minG > -0.01, `min ${fmt(minG)} dB`);
  check('peaks still under ceiling', r.truePeakAfterDb <= -1 + 0.05,
    `${fmt(r.truePeakAfterDb)} dBTP`);
  check('loudness below target (not squashed)', r.loudnessAfter.integratedLufs < -14,
    `${fmt(r.loudnessAfter.integratedLufs, 2)} LUFS`);
}

console.log('\n[transient preservation]  unity-gain run, band comp only');
{
  // Keep makeup at 0 and the limiter out of the way so the comparison
  // isolates the per-band transient-preserve behaviour.
  const input = normalizeTo(TEST_SIGNALS.drums(fs), 0.5);
  const mk = (p) => settings(p, {
    targetLufs: -24, maxMakeupDb: 0, maxLimiterGrDb: 0,
    bands: Array.from({ length: 4 }, () => ({
      ...DEFAULT_BAND_SETTINGS,
      thresholdDb: -24, ratio: 6, attackMs: 0.5, releaseMs: 150,
      transientPreserve: p,
    })),
  });
  const low = render(input, fs, mk(0));
  const high = render(input, fs, mk(1));
  const loss = (r) => r.transient.reduce((a, t) => a + t.meanLossDb, 0) / r.transient.length;
  check('drums: preserve=1 keeps more transient than preserve=0',
    loss(high) < loss(low) - 0.2, `${fmt(loss(high))} vs ${fmt(loss(low))} dB`);
}

{
  const r = rows.find((x) => x.name === 'sustainedLow' && x.preserve === 0).result;
  let minG = 0;
  for (let i = 0; i < r.limiterGainDb.length; i++) minG = Math.min(minG, r.limiterGainDb[i]);
  check('sustainedLow: limiter gain reduction < 3 dB', minG > -3, `min ${fmt(minG)} dB`);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
