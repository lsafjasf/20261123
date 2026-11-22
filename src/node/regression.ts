// 回归测试：程序合成“合唱式”重叠双人语音（含相互串音与同时大笑），
// 跑去串音核心，检查：
//   1) 错误衰减率：本人发声（含重叠、笑声）时被衰减超过 3dB 的帧占比
//   2) 残留串音：本人静音、对方发声段，输出相对输入的串音残余（dB）
//   3) 增益曲线平滑度：无门限式瞬时跳变
//   4) WAV 编解码往返精度
// 运行：node dist/node/regression.js

import { deBleed } from "../dsp/debleed.js";
import { synthScene } from "../dsp/synth.js";
import { encodeWav, decodeWav } from "../dsp/wav.js";

const FALSE_ATTEN_THRESHOLD_DB = 3;
const GUARD_FRAMES = 15; // 活动掩码前后 150ms 不计入残留串音统计（包络拖尾）
const ONSET_RAMP_FRAMES = 10; // 发声起点 100ms 内允许软启动斜坡，不计误衰减

function rmsDb(x: Float32Array, sampleRate: number, frameIndices: number[]): number {
  const hop = Math.round(sampleRate / 100);
  let sum = 0;
  let count = 0;
  for (const f of frameIndices) {
    const start = f * hop;
    const end = Math.min(start + hop, x.length);
    for (let i = start; i < end; i++) {
      sum += x[i] * x[i];
      count++;
    }
  }
  return count === 0 ? -100 : 10 * Math.log10(sum / count);
}

interface TrackMetrics {
  falseAttenRate: number;
  overlapAttenRate: number;
  residualCrosstalkDb: number;
  maxGainStepDb: number;
}

function measureTrack(
  input: Float32Array,
  output: Float32Array,
  gainDb: Float32Array,
  levelMatchGainDb: number,
  selfActive: Uint8Array,
  otherActive: Uint8Array,
  sampleRate: number,
): TrackMetrics {
  const frames = gainDb.length;
  let selfFrames = 0;
  let falseAtten = 0;
  let overlapFrames = 0;
  let overlapAtten = 0;
  const bleedFrames: number[] = [];

  for (let f = 0; f < frames; f++) {
    const self = selfActive[f] === 1;
    const other = otherActive[f] === 1;
    if (self) {
      // 软启动宽容：发声段开头 100ms 内增益可能仍在恢复斜坡中
      const runStart = f === 0 || selfActive[f - 1] === 0;
      let inRamp = false;
      if (!runStart) {
        let back = 0;
        for (let g = f - 1; g >= 0 && selfActive[g] === 1 && back < ONSET_RAMP_FRAMES; g--) back++;
        inRamp = back < ONSET_RAMP_FRAMES;
      } else {
        inRamp = true;
      }
      selfFrames++;
      if (!inRamp && gainDb[f] < -FALSE_ATTEN_THRESHOLD_DB) falseAtten++;
      if (other) {
        overlapFrames++;
        if (!inRamp && gainDb[f] < -FALSE_ATTEN_THRESHOLD_DB) overlapAtten++;
      }
    }
    // 本人静音（含保护带）且对方发声 → 纯串音帧
    if (!self && other) {
      let nearSelf = false;
      for (let g = Math.max(0, f - GUARD_FRAMES); g <= Math.min(frames - 1, f + GUARD_FRAMES); g++) {
        if (selfActive[g] === 1) {
          nearSelf = true;
          break;
        }
      }
      if (!nearSelf) bleedFrames.push(f);
    }
  }

  let maxStep = 0;
  for (let f = 1; f < frames; f++) {
    const step = Math.abs(gainDb[f] - gainDb[f - 1]);
    if (step > maxStep) maxStep = step;
  }

  const inDb = rmsDb(input, sampleRate, bleedFrames);
  const outDb = rmsDb(output, sampleRate, bleedFrames);
  // 电平匹配是恒定增益，衡量串音抑制时需扣除
  const residualDb = outDb - inDb - levelMatchGainDb;

  return {
    falseAttenRate: selfFrames === 0 ? 0 : falseAtten / selfFrames,
    overlapAttenRate: overlapFrames === 0 ? 0 : overlapAtten / overlapFrames,
    residualCrosstalkDb: residualDb,
    maxGainStepDb: maxStep,
  };
}

function check(name: string, ok: boolean, detail: string, failures: string[]): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(name);
}

function runScene(seed: number, bleedDb: number, failures: string[]): void {
  console.log(`== 场景 seed=${seed} 串音=${bleedDb}dB ==`);
  const scene = synthScene({ seed, durationSec: 24, bleedDb });

  const result = deBleed(scene.trackA, scene.trackB, { sampleRate: scene.sampleRate });
  console.log(
    `  估计串音比 A→B ${result.bleedRatioAbDb.toFixed(1)}dB, B→A ${result.bleedRatioBaDb.toFixed(1)}dB`,
  );
  console.log(`  衰减段数 A=${result.a.segments.length} B=${result.b.segments.length}`);

  const mA = measureTrack(
    scene.trackA, result.a.samples, result.a.gainDb, result.a.levelMatchGainDb,
    scene.activeA, scene.activeB, scene.sampleRate,
  );
  const mB = measureTrack(
    scene.trackB, result.b.samples, result.b.gainDb, result.b.levelMatchGainDb,
    scene.activeB, scene.activeA, scene.sampleRate,
  );

  const tag = `s${seed}/b${bleedDb}`;
  check(`${tag} A 错误衰减率 < 5%`, mA.falseAttenRate < 0.05, `${(mA.falseAttenRate * 100).toFixed(2)}%`, failures);
  check(`${tag} B 错误衰减率 < 5%`, mB.falseAttenRate < 0.05, `${(mB.falseAttenRate * 100).toFixed(2)}%`, failures);
  check(`${tag} A 重叠段误衰减 < 2%`, mA.overlapAttenRate < 0.02, `${(mA.overlapAttenRate * 100).toFixed(2)}%`, failures);
  check(`${tag} B 重叠段误衰减 < 2%`, mB.overlapAttenRate < 0.02, `${(mB.overlapAttenRate * 100).toFixed(2)}%`, failures);
  check(`${tag} A 残留串音抑制 ≥ 6dB`, mA.residualCrosstalkDb <= -6, `${mA.residualCrosstalkDb.toFixed(1)}dB`, failures);
  check(`${tag} B 残留串音抑制 ≥ 6dB`, mB.residualCrosstalkDb <= -6, `${mB.residualCrosstalkDb.toFixed(1)}dB`, failures);
  check(`${tag} A 增益无门限式跳变 (<5dB/帧)`, mA.maxGainStepDb < 5, `${mA.maxGainStepDb.toFixed(2)}dB`, failures);
  check(`${tag} B 增益无门限式跳变 (<5dB/帧)`, mB.maxGainStepDb < 5, `${mB.maxGainStepDb.toFixed(2)}dB`, failures);
}

function main(): void {
  const failures: string[] = [];

  for (const seed of [20261123, 7, 4242]) {
    for (const bleedDb of [-8, -14]) {
      runScene(seed, bleedDb, failures);
    }
  }

  console.log("== WAV 往返 ==");
  const scene = synthScene({ seed: 1, durationSec: 2 });
  const wav = encodeWav([scene.trackA, scene.trackB], scene.sampleRate);
  const decoded = decodeWav(wav);
  let maxErr = 0;
  for (let i = 0; i < scene.trackA.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(decoded.channels[0][i] - scene.trackA[i]));
  }
  check("采样率一致", decoded.sampleRate === scene.sampleRate, `${decoded.sampleRate}`, failures);
  check("16bit 往返误差 < 1e-3", maxErr < 1e-3, maxErr.toExponential(2), failures);

  if (failures.length > 0) {
    console.error(`\n回归失败 ${failures.length} 项: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\n全部回归通过 ✓");
}

main();
