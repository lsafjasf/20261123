// 检测层：稳健 z 分数 + 多通道投票。单一通道超阈（如衣料摩擦造成的样本跳变）
// 默认不构成判定；正常换气/停顿只表现为能量变化，底噪与相位曲线保持连续。
import type { FeatureSet } from "./features.ts";
import { robustZ } from "./dsp.ts";

export interface Boundary {
  time: number;
  frame: number;
  votes: number;
  severity: "high" | "mid" | "low";
  scores: { floor: number; phase: number; jump: number; repeat: number };
  benign: string | null; // 若存在良性解释则注明，不直接判为篡改
}

export interface DetectOptions {
  sensitivity: number; // 0..100
  minVotes: number;
}

function pickPeaks(score: Float64Array, thresh: number, refractory: number): number[] {
  const peaks: number[] = [];
  let last = -refractory;
  for (let i = 1; i < score.length - 1; i++) {
    if (score[i] < thresh) continue;
    if (score[i] < score[i - 1] || score[i] < score[i + 1]) continue;
    if (i - last < refractory) {
      if (peaks.length && score[i] > score[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      last = i;
      continue;
    }
    peaks.push(i);
    last = i;
  }
  return peaks;
}

export function detectBoundaries(f: FeatureSet, opt: DetectOptions): Boundary[] {
  const n = f.times.length;
  const rms = f.rms;
  // 灵敏度映射：越高阈值越低。默认 50 → z≈4；0 → z≈7；100 → z≈2.5。
  const zThresh = 7 - (opt.sensitivity / 100) * 4.5;
  const zFloor = robustZ(f.floorStep);
  const zPhase = robustZ(f.phaseBreak);
  const zJump = robustZ(f.sampleJump);
  const zDc = robustZ(f.dcStep);
  // 重复痕迹用绝对相关 + 稳健 z 双重门槛，避免自然底噪的弱相似误报。
  const zRepeat = robustZ(f.repeatScore);

  const chan: Float64Array[] = [zFloor, zPhase, zJump, zRepeat];
  const fused = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const z of chan) s += Math.max(0, z[i] - zThresh);
    s += Math.max(0, zDc[i] - zThresh) * 0.5;
    fused[i] = s;
  }
  const fps = n > 1 ? (n - 1) / (f.times[n - 1] - f.times[0]) : 4;
  const peaks = pickPeaks(fused, 0.1, Math.max(1, Math.round(0.4 * fps)));

  const out: Boundary[] = [];
  for (const p of peaks) {
    const votes =
      (zFloor[p] >= zThresh ? 1 : 0) +
      (zPhase[p] >= zThresh ? 1 : 0) +
      (zJump[p] >= zThresh || zDc[p] >= zThresh ? 1 : 0) +
      (f.repeatScore[p] >= 0.985 && zRepeat[p] >= zThresh ? 1 : 0);
    if (votes < opt.minVotes) continue;

    // 良性解释：低能量（停顿/换气）且底噪、相位连续 → 注明而非判定。
    const localRms = rms[p] ?? 0;
    let peakRms = 0;
    for (let i = 0; i < n; i++) if (rms[i] > peakRms) peakRms = rms[i];
    const quiet = localRms < 0.08 * peakRms;
    const continuous = zFloor[p] < zThresh && zPhase[p] < zThresh;
    const benign = quiet && continuous
      ? "低能量事件（换气/停顿），底噪与相位连续"
      : zJump[p] >= zThresh && votes === 1
        ? "仅样本跳变（可能为衣料摩擦/爆音），无旁证"
        : null;

    const severity: Boundary["severity"] = votes >= 3 ? "high" : votes === 2 ? "mid" : "low";
    out.push({
      time: f.times[p],
      frame: p,
      votes,
      severity,
      scores: {
        floor: zFloor[p],
        phase: zPhase[p],
        jump: Math.max(zJump[p], zDc[p]),
        repeat: f.repeatScore[p],
      },
      benign,
    });
  }
  return out;
}
