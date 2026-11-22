// DSP 冒烟测试：在 Node 中模拟 AudioWorklet 环境，直接驱动 worklet.js。
// 运行：node test/dsp-test.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const code = readFileSync(join(root, 'public', 'worklet.js'), 'utf8');

let ProcessorClass = null;
const sandbox = {
  sampleRate: 48000,
  registerProcessor: (name, ctor) => { ProcessorClass = ctor; },
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { onmessage: null, postMessage: () => {} };
    }
  }
};
// 在受控作用域内执行 worklet 源码
const fn = new Function(...Object.keys(sandbox), code);
fn(...Object.values(sandbox));

if (!ProcessorClass) throw new Error('registerProcessor 未被调用');

function makeProc(config) {
  const proc = new ProcessorClass();
  proc.port.onmessage({ data: { type: 'config', config } });
  return proc;
}

function runBlocks(proc, input) {
  const out = new Float32Array(input.length);
  for (let off = 0; off < input.length; off += 128) {
    const inBlock = input.subarray(off, off + 128);
    const outBlock = out.subarray(off, off + 128);
    proc.process([[inBlock]], [[outBlock]]);
  }
  return out;
}

const baseConfig = () => ({
  order: ['nr', 'clarity', 'limiter'],
  bypass: { nr: true, clarity: true, limiter: true },
  params: { nr: { strength: 0.6 }, clarity: { amount: 0.5 }, limiter: { ceiling: 0.89 } }
});

const results = [];
function check(name, ok, detail) {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

// 1. 全旁路 = 透明直通
{
  const proc = makeProc(baseConfig());
  const input = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.1) * 0.5);
  const out = runBlocks(proc, input);
  let maxDiff = 0;
  for (let i = 0; i < input.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - input[i]));
  check('全旁路透明直通', maxDiff < 1e-6, `maxDiff=${maxDiff.toExponential(2)}`);
}

// 2. 限峰器：幅度 2.0 的正弦被压到 ceiling 以下
{
  const cfg = baseConfig();
  cfg.bypass.limiter = false;
  const proc = makeProc(cfg);
  const input = Float32Array.from({ length: 8192 }, (_, i) => Math.sin(i * 0.05) * 2.0);
  const out = runBlocks(proc, input);
  let peak = 0;
  for (let i = 512; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  check('限峰器限制峰值', peak <= 0.891, `peak=${peak.toFixed(3)} ceiling=0.89`);
}

// 3. 降噪：稳态噪声 RMS 明显下降
{
  const cfg = baseConfig();
  cfg.bypass.nr = false;
  const proc = makeProc(cfg);
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1;
  const input = Float32Array.from({ length: 48000 * 4 }, () => rand() * 0.1);
  const out = runBlocks(proc, input);
  const rms = (arr, from) => {
    let s = 0;
    for (let i = from; i < arr.length; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / (arr.length - from));
  };
  const inRms = rms(input, 48000 * 3);
  const outRms = rms(out, 48000 * 3); // 最后 1 秒，噪声估计已收敛
  check('降噪衰减稳态噪声', outRms < inRms * 0.5, `in=${inRms.toFixed(4)} out=${outRms.toFixed(4)}`);
}

// 4. 清晰度：3.2kHz 正弦获得提升
{
  const cfg = baseConfig();
  cfg.bypass.clarity = false;
  cfg.params.clarity.amount = 1;
  const proc = makeProc(cfg);
  const input = Float32Array.from({ length: 8192 },
    (_, i) => Math.sin((2 * Math.PI * 3200 * i) / 48000) * 0.1);
  const out = runBlocks(proc, input);
  let inPeak = 0, outPeak = 0;
  for (let i = 1024; i < out.length; i++) {
    inPeak = Math.max(inPeak, Math.abs(input[i]));
    outPeak = Math.max(outPeak, Math.abs(out[i]));
  }
  check('清晰度提升 3.2kHz', outPeak > inPeak * 1.5, `增益=${(outPeak / inPeak).toFixed(2)}x`);
}

// 5. 顺序调整生效：限峰在降噪前，爆音先被限制
{
  const cfg = baseConfig();
  cfg.order = ['limiter', 'nr', 'clarity'];
  cfg.bypass.limiter = false;
  const proc = makeProc(cfg);
  const input = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.05) * 3.0);
  const out = runBlocks(proc, input);
  let peak = 0;
  for (let i = 512; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  check('顺序调整后限峰仍生效', peak <= 0.9, `peak=${peak.toFixed(3)}`);
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
