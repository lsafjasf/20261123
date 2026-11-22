// 端到端核心测试：合成已知信号 -> 特征提取 -> 检测 -> 断言。
// 同时把测试音频写到 public/demo.wav 供浏览器试用。
// 运行: node test/run.mjs
import { FeatureExtractor, ANALYSIS_RATE } from '../public/js/features.js';
import { Analyzer } from '../public/js/store.js';
import { writeFileSync } from 'node:fs';

const RATE = ANALYSIS_RATE;
const totalSec = 34;
const pcm = new Float32Array(RATE * totalSec);

// 语音模型：相位积分的基频滑动谐波 + 轻度低通噪声。
// 保证相邻采样跳变 < 0.5（不误报爆音），谱平坦度 > 0.12（不误判音乐）。
let phase = 0;
let noiseLp = 0;
function speech(t, dt) {
  const f0 = 150 + 40 * Math.sin(2 * Math.PI * 0.3 * t);
  phase += 2 * Math.PI * f0 * dt;
  const env = 0.65 + 0.35 * Math.sin(2 * Math.PI * 3 * t);
  let v = 0;
  for (let h = 1; h <= 4; h++) {
    v += (0.3 / h) * Math.sin(phase * h);
  }
  noiseLp += 0.5 * ((Math.random() * 2 - 1) - noiseLp);
  v += 0.45 * noiseLp;
  return env * v;
}
function music(t) {
  return 0.2 * Math.sin(2 * Math.PI * 220 * t)
       + 0.2 * Math.sin(2 * Math.PI * 330 * t)
       + 0.2 * Math.sin(2 * Math.PI * 440 * t);
}
function noise() { return 0.032 * (Math.random() * 2 - 1) * 1.7; }

for (let i = 0; i < pcm.length; i++) {
  const t = i / RATE;
  let v = 0;
  if (t < 3.0) v = speech(t, 1 / RATE);
  else if (t < 3.4) v = 0;                       // 掉字 0.4s
  else if (t < 6.0) v = speech(t, 1 / RATE);
  else if (t < 11.0) v = 0;                      // 异常空白 5s
  else if (t < 14.0) v = speech(t, 1 / RATE);
  else if (t < 14.6) {                           // 持续削波 0.6s
    v = Math.max(-1, Math.min(1, 1.5 * Math.sin(2 * Math.PI * 440 * t)));
  }
  else if (t < 17.0) v = speech(t, 1 / RATE);
  else if (t < 25.0) v = noise();                // 持续噪声 8s
  else if (t < 31.0) v = music(t);               // 音乐 6s
  else if (t < 31.8) v = 0;                      // 正常停顿 0.8s（待白名单）
  else v = speech(t, 1 / RATE);
  pcm[i] = v;
}
// 单点爆音 @12.5s（邻采样清零，跳变确定为 1.0）
const popAt = Math.floor(12.5 * RATE);
pcm[popAt - 1] = 0; pcm[popAt] = 1.0; pcm[popAt + 1] = 0;

// ---- 特征提取 ----
const ex = new FeatureExtractor();
ex.push(pcm);
const feats = ex.finish();
console.log(`frames=${feats.count} (${(feats.count * feats.hopSec).toFixed(1)}s)`);

// ---- 检测 ----
const an = new Analyzer();
an.setFeatures(feats);
const segs = an.segments;
for (const s of segs) {
  console.log(`${s.kind.padEnd(8)} ${s.start.toFixed(2)}-${s.end.toFixed(2)}  ${s.detail}`);
}

let failures = 0;
function expect(kind, atSec, tolSec, msg) {
  const hit = segs.find(s => s.kind === kind &&
    s.start <= atSec + tolSec && s.end >= atSec - tolSec);
  if (hit) console.log(`PASS ${msg}`);
  else { console.error(`FAIL ${msg}: 未找到 ${kind}@${atSec}s`); failures++; }
}
function expectNone(kind, fromSec, toSec, msg) {
  const hit = segs.find(s => s.kind === kind && s.start < toSec && s.end > fromSec);
  if (!hit) console.log(`PASS ${msg}`);
  else { console.error(`FAIL ${msg}: 误报 ${kind}@${hit.start.toFixed(2)}`); failures++; }
}

expect('dropout', 3.2, 0.3, '掉字 0.4s');
expect('silence', 8.0, 1.0, '异常空白 5s');
expect('pop', 12.5, 0.1, '单点爆音');
expect('clip', 14.3, 0.3, '持续削波 0.6s');
expect('noise', 21.0, 1.0, '持续噪声 8s');
expect('music', 28.0, 1.0, '音乐 6s（信息项）');
expectNone('silence', 31.0, 31.8, '0.8s 停顿不算异常空白');

// ---- 白名单：0.8s 停顿标记为正常 ----
an.setWhitelist([{ minSec: 0.7, maxSec: 0.9, label: '正常停顿' }]);
const wl = an.segments.find(s => s.whitelisted);
if (wl && wl.kind === 'pause' && Math.abs(wl.start - 31) < 0.2) {
  console.log('PASS 白名单命中 0.8s 停顿');
} else { console.error('FAIL 白名单未命中'); failures++; }

// ---- 增量重算：帧级阈值只重算候选窗口 ----
const st1 = an.updateThresholds({ noiseFlatness: 0.6 });
console.log(`noiseFlatness 0.45->0.6: 重算 ${st1.reevaluatedWindows}/${st1.totalWindows} 窗口, ` +
  `segmentOnly=${st1.segmentOnly}, ${st1.elapsedMs.toFixed(1)}ms`);
if (st1.reevaluatedWindows > 0 && st1.reevaluatedWindows < st1.totalWindows) {
  console.log('PASS 帧级阈值增量重算');
} else { console.error('FAIL 增量重算窗口数异常'); failures++; }

// ---- 增量重算：时长阈值只重跑分段合并 ----
const st2 = an.updateThresholds({ silenceMinSec: 3 });
if (st2.segmentOnly && st2.reevaluatedWindows === 0) {
  console.log('PASS 时长阈值只重跑分段合并');
} else { console.error('FAIL 时长阈值不应重算帧'); failures++; }

// ---- 导出 demo.wav ----
const buf = Buffer.alloc(44 + pcm.length * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4);
buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
}
writeFileSync('public/demo.wav', buf);
console.log('wrote public/demo.wav');

process.exit(failures ? 1 : 0);
