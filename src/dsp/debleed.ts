// 双领夹麦串音（bleed/crosstalk）软衰减核心。
// 两支麦同时录音、时间对齐。当 A 麦电平远高于 B 麦、且 B 的电平可以被
// “A 的信号经串音比泄漏到 B”解释时，认为 B 此刻只有串音，对 B 做有限深度
// 的软衰减；攻击/释放/保持时间常数较大，避免门限机器音。自然重叠讲话与
// 笑声会使 B 的包络高于串音预测底线，从而不被衰减。

export interface DeBleedOptions {
  sampleRate: number;
  /** 最大衰减深度（dB，正数）。限制深度是避免“门限感”的关键。 */
  maxAttenuationDb?: number;
  /** 增益收紧攻击时间（ms） */
  attackMs?: number;
  /** 增益恢复释放时间（ms） */
  releaseMs?: number;
  /** 确信是本人发声时的快速恢复时间（ms），避免词头被压住 */
  fastReleaseMs?: number;
  /** 衰减保持时间（ms），防止字间气口抖动 */
  holdMs?: number;
  /** 介入延时（ms）：条件需持续满足才启动衰减，避免笑声脉冲间隙误触发 */
  engageDelayMs?: number;
  /** 判定余量（dB）：包络低于“预测串音底线 + 余量”才衰减。
   *  取值关键是“只衰减能被串音完全解释的内容”：余量过大会把
   *  比重叠对方轻几 dB 的真实发言误判为串音。 */
  bleedMarginDb?: number;
  /** 绝对静音门限（dBFS），对方低于此电平不触发衰减 */
  silenceDb?: number;
  /** 是否做长时电平匹配（缓解切机位后的音量跳变） */
  levelMatch?: boolean;
}

export interface AttenuationSegment {
  startSec: number;
  endSec: number;
  maxDepthDb: number;
}

export interface TrackResult {
  samples: Float32Array;
  /** 每个控制帧的增益（dB，<= 0），用于可视化 */
  gainDb: Float32Array;
  segments: AttenuationSegment[];
  /** 电平匹配施加的恒定增益（dB） */
  levelMatchGainDb: number;
}

export interface DeBleedResult {
  a: TrackResult;
  b: TrackResult;
  /** 控制帧率（gainDb 数组每秒帧数） */
  controlFps: number;
  /** 估计的串音比：A 漏进 B 的相对电平（dB） */
  bleedRatioAbDb: number;
  /** 估计的串音比：B 漏进 A 的相对电平（dB） */
  bleedRatioBaDb: number;
}

const CONTROL_FPS = 100;
const DB_FLOOR = -100;

function toDb(x: number): number {
  return x <= 0 ? DB_FLOOR : Math.max(DB_FLOOR, 20 * Math.log10(x));
}

function fromDb(db: number): number {
  return Math.pow(10, db / 20);
}

// 分帧峰值包络 + 攻击/释放单极点平滑，输出 dB。
function envelopeDb(x: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / CONTROL_FPS));
  const frames = Math.ceil(x.length / hop);
  const envDb = new Float32Array(frames);
  const attackCoef = 1 - Math.exp(-1 / (0.005 * CONTROL_FPS));
  // 释放 150ms：笑声脉冲间隙（约 100ms）内包络不会跌穿串音底线
  const releaseCoef = 1 - Math.exp(-1 / (0.15 * CONTROL_FPS));
  let env = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const end = Math.min(start + hop, x.length);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(x[i]);
      if (v > peak) peak = v;
    }
    const coef = peak > env ? attackCoef : releaseCoef;
    env += (peak - env) * coef;
    envDb[f] = toDb(env);
  }
  return envDb;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((p, q) => p - q);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 估计串音比：在“对方明显占优”的帧上，取本麦与对方包络差的中位数。
// 返回“对方电平漏进本麦的相对 dB 值”（负数）。
function estimateBleedRatioDb(
  selfEnvDb: Float32Array,
  otherEnvDb: Float32Array,
  silenceDb: number,
): number {
  const diffs: number[] = [];
  for (let f = 0; f < selfEnvDb.length; f++) {
    const other = otherEnvDb[f];
    if (other > silenceDb + 10 && other - selfEnvDb[f] > 8) {
      diffs.push(selfEnvDb[f] - other);
    }
  }
  const m = median(diffs);
  if (Number.isNaN(m)) return -18; // 找不到占优段时的保守默认
  return Math.min(-3, Math.max(-40, m));
}

interface GainComputerParams {
  maxAttenuationDb: number;
  bleedMarginDb: number;
  silenceDb: number;
  attackCoef: number;
  releaseCoef: number;
  fastReleaseCoef: number;
  holdFrames: number;
  engageFrames: number;
}

// 由双方包络计算本麦的软衰减增益曲线（dB，<= 0）。
// 软拐点：低于“预测串音底线+余量”越多，衰减越深，斜率 2:1，封顶 maxAttenu
// 保持计时器防止字间气口造成增益抖动；攻击/释放不对称平滑避免门限感。
function computeGainDb(
  selfEnvDb: Float32Array,
  otherEnvDb: Float32Array,
  bleedRatioDb: number,
  p: GainComputerParams,
): Float32Array {
  const frames = selfEnvDb.length;
  const gainDb = new Float32Array(frames);
  let current = 0;
  let holdValue = 0;
  let holdTimer = 0;
  let engageTimer = 0;
  for (let f = 0; f < frames; f++) {
    const other = otherEnvDb[f];
    const self = selfEnvDb[f];
    const otherActive = other > p.silenceDb;
    const predictedFloor = other + bleedRatioDb;
    // 本人包络高于串音预测底线 → 确信是自己在说话（含笑声、重叠），
    // 用于取消保持计时并走快速恢复。
    const confidentOwn = self > predictedFloor + p.bleedMarginDb + 2;
    let target = 0;
    let shortfall = 0;
    if (otherActive) {
      shortfall = predictedFloor + p.bleedMarginDb - self;
    }
    if (shortfall > 0) {
      engageTimer++;
      // 介入延时：条件持续足够久才衰减，笑声脉冲间的短暂跌落不触发。
      // 软拐点斜率 5:1：越能被串音解释衰减越深，封顶 maxAttenuationDb。
      if (engageTimer > p.engageFrames) {
        target = -Math.min(p.maxAttenuationDb, shortfall * 5);
      }
    } else {
      engageTimer = 0;
    }
    if (target < 0) {
      holdValue = target;
      holdTimer = p.holdFrames;
    } else if (holdTimer > 0 && !confidentOwn) {
      target = holdValue;
      holdTimer--;
    } else {
      holdTimer = 0;
    }
    let coef: number;
    if (target < current) coef = p.attackCoef;
    else coef = confidentOwn ? p.fastReleaseCoef : p.releaseCoef;
    current += (target - current) * coef;
    gainDb[f] = current > -0.05 ? 0 : current;
  }
  return gainDb;
}

// 活动帧（包络高于静音门限+6dB）的 RMS 电平（dBFS），用于电平匹配。
function activeRmsDb(x: Float32Array, sampleRate: number, silenceDb: number): number {
  const hop = Math.max(1, Math.round(sampleRate / CONTROL_FPS));
  const thresh = fromDb(silenceDb + 6);
  const frames = Math.ceil(x.length / hop);
  const framePeak = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const end = Math.min(start + hop, x.length);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(x[i]);
      if (v > peak) peak = v;
    }
    framePeak[f] = peak;
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    if (framePeak[Math.floor(i / hop)] > thresh) {
      sum += x[i] * x[i];
      count++;
    }
  }
  return count === 0 ? DB_FLOOR : toDb(Math.sqrt(sum / count));
}

function extractSegments(gainDb: Float32Array, fps: number): AttenuationSegment[] {
  const segments: AttenuationSegment[] = [];
  let start = -1;
  let depth = 0;
  for (let f = 0; f <= gainDb.length; f++) {
    const g = f < gainDb.length ? gainDb[f] : 0;
    if (g < -1) {
      if (start < 0) {
        start = f;
        depth = 0;
      }
      if (-g > depth) depth = -g;
    } else if (start >= 0) {
      segments.push({ startSec: start / fps, endSec: f / fps, maxDepthDb: depth });
      start = -1;
    }
  }
  return segments;
}

function applyGain(x: Float32Array, gainDb: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / CONTROL_FPS));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const f = Math.min(gainDb.length - 1, Math.floor(i / hop));
    out[i] = x[i] * fromDb(gainDb[f]);
  }
  return out;
}

/**
 * 主入口：对两支时间对齐的单声道轨做去串音软衰减 + 可选电平匹配。
 * 输入不被修改（非破坏性），返回处理后的新缓冲与可视化数据。
 */
export function deBleed(
  trackA: Float32Array,
  trackB: Float32Array,
  opts: DeBleedOptions,
): DeBleedResult {
  const sampleRate = opts.sampleRate;
  const maxAttenuationDb = opts.maxAttenuationDb ?? 14;
  const bleedMarginDb = opts.bleedMarginDb ?? 3;
  const silenceDb = opts.silenceDb ?? -50;
  const attackMs = opts.attackMs ?? 30;
  const releaseMs = opts.releaseMs ?? 250;
  const fastReleaseMs = opts.fastReleaseMs ?? 60;
  const holdMs = opts.holdMs ?? 120;
  const engageDelayMs = opts.engageDelayMs ?? 120;
  const levelMatch = opts.levelMatch ?? true;

  const len = Math.max(trackA.length, trackB.length);
  const a = padTo(trackA, len);
  const b = padTo(trackB, len);

  const envA = envelopeDb(a, sampleRate);
  const envB = envelopeDb(b, sampleRate);

  const bleedRatioAbDb = estimateBleedRatioDb(envB, envA, silenceDb);
  const bleedRatioBaDb = estimateBleedRatioDb(envA, envB, silenceDb);

  const params: GainComputerParams = {
    maxAttenuationDb,
    bleedMarginDb,
    silenceDb,
    attackCoef: 1 - Math.exp(-1 / ((attackMs / 1000) * CONTROL_FPS)),
    releaseCoef: 1 - Math.exp(-1 / ((releaseMs / 1000) * CONTROL_FPS)),
    fastReleaseCoef: 1 - Math.exp(-1 / ((fastReleaseMs / 1000) * CONTROL_FPS)),
    holdFrames: Math.round((holdMs / 1000) * CONTROL_FPS),
    engageFrames: Math.round((engageDelayMs / 1000) * CONTROL_FPS),
  };

  const gainA = computeGainDb(envA, envB, bleedRatioBaDb, params);
  const gainB = computeGainDb(envB, envA, bleedRatioAbDb, params);

  // 电平匹配：把两轨活动段 RMS 拉到同一目标（较响的一轨），限幅 ±8 dB。
  let levelGainA = 0;
  let levelGainB = 0;
  if (levelMatch) {
    const rmsA = activeRmsDb(a, sampleRate, silenceDb);
    const rmsB = activeRmsDb(b, sampleRate, silenceDb);
    const target = Math.max(rmsA, rmsB);
    levelGainA = Math.max(-8, Math.min(8, target - rmsA));
    levelGainB = Math.max(-8, Math.min(8, target - rmsB));
  }

  const outA = applyGain(a, gainA, sampleRate);
  const outB = applyGain(b, gainB, sampleRate);
  const linA = fromDb(levelGainA);
  const linB = fromDb(levelGainB);
  if (linA !== 1) for (let i = 0; i < outA.length; i++) outA[i] *= linA;
  if (linB !== 1) for (let i = 0; i < outB.length; i++) outB[i] *= linB;

  return {
    a: {
      samples: outA,
      gainDb: gainA,
      segments: extractSegments(gainA, CONTROL_FPS),
      levelMatchGainDb: levelGainA,
    },
    b: {
      samples: outB,
      gainDb: gainB,
      segments: extractSegments(gainB, CONTROL_FPS),
      levelMatchGainDb: levelGainB,
    },
    controlFps: CONTROL_FPS,
    bleedRatioAbDb,
    bleedRatioBaDb,
  };
}

function padTo(x: Float32Array, len: number): Float32Array {
  if (x.length >= len) return x;
  const out = new Float32Array(len);
  out.set(x);
  return out;
}
