// 无头仿真测试：用 Node 标准库对程序生成素材做 STFT，
// 将 dB 频谱帧喂给 HowlDetector，验证：
//   1) 啸叫注入素材在注入频率附近触发；
//   2) 扫频 / 持续长音 / 合成讲话不触发（不误伤）。
import { renderMaterial } from '../public/js/material.js';
import { HowlDetector } from '../public/js/detector.js';

const SR = 48000;
const FFT = 4096;
const FPS = 20;
const HOP = SR / FPS;

// 迭代基-2 FFT（仅测试用）
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

const hann = new Float32Array(FFT);
for (let i = 0; i < FFT; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT));

function frameDb(data, offset) {
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) re[i] = (data[offset + i] ?? 0) * hann[i];
  fft(re, im);
  const db = new Float32Array(FFT / 2);
  for (let i = 0; i < FFT / 2; i++) {
    const mag = Math.hypot(re[i], im[i]) / (FFT / 2);
    db[i] = 20 * Math.log10(mag + 1e-9);
  }
  return db;
}

function runCase(kind) {
  const { data, howlFreq } = renderMaterial(kind, SR);
  const det = new HowlDetector({
    sampleRate: SR, fftSize: FFT, framesPerSecond: FPS, sensitivity: 0.5,
  });
  const events = [];
  for (let off = 0; off + FFT <= data.length; off += HOP) {
    const evs = det.analyze(frameDb(data, off), events.map((e) => e.freq));
    for (const e of evs) events.push({ ...e, t: off / SR });
  }
  return { events, howlFreq };
}

let fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) fail++;
}

for (const kind of ['sweep', 'tone', 'speech']) {
  const { events } = runCase(kind);
  check(`${kind} 不误触发`, events.length === 0, `触发 ${events.length} 次`);
}

{
  const { events, howlFreq } = runCase('howl');
  const near = events.filter((e) => Math.abs(e.freq - howlFreq) / howlFreq < 0.05);
  check('howl 素材触发', events.length > 0, `共 ${events.length} 次`);
  check('触发频率命中注入频点(±5%)', near.length > 0,
    near.length ? `命中 ${near[0].freq.toFixed(0)}Hz @ ${near[0].t.toFixed(1)}s（注入 ${howlFreq}Hz）`
      : `未命中，触发: ${events.map((e) => e.freq.toFixed(0)).join(', ') || '无'}`);
}

{
  const { events, howlFreq } = runCase('mix');
  const near = events.filter((e) => Math.abs(e.freq - howlFreq) / howlFreq < 0.05);
  check('mix 素材仅命中啸叫频点', near.length > 0 && events.length <= 3,
    `触发 ${events.length} 次: ${events.map((e) => `${e.freq.toFixed(0)}Hz@${e.t.toFixed(1)}s`).join(', ') || '无'}`);
}

process.exit(fail ? 1 : 0);
