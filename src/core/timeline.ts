/**
 * 时间线纯函数：画面 / 节拍 / 音轨共用同一套时间坐标与换算规则。
 */

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** 线性插值。 */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 秒 -> 时间线像素。 */
export const timeToX = (time: number, pxPerSec: number, scrollX = 0): number =>
  time * pxPerSec - scrollX;

/** 时间线像素 -> 秒。 */
export const xToTime = (x: number, pxPerSec: number, scrollX = 0): number =>
  (x + scrollX) / pxPerSec;

/** 秒 -> 微秒（WebCodecs 时间戳）。 */
export const secToUs = (sec: number): number => Math.round(sec * 1_000_000);

/** 微秒 -> 秒。 */
export const usToSec = (us: number): number => us / 1_000_000;

/** 秒 -> 采样数。 */
export const secToSamples = (sec: number, sampleRate: number): number =>
  Math.round(sec * sampleRate);

/** 格式化 mm:ss.sss，用于切点表。 */
export function formatTimecode(sec: number): string {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const mss = String(ms === 1000 ? 999 : ms).padStart(3, "0");
  return `${mm}:${ss}.${mss}`;
}

/** 在有序时间数组中二分查找最后一个 <= time 的下标，没有则返回 -1。 */
export function findLastLE(times: readonly number[], time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 把目标时间吸附到最近的节拍上。
 * 返回吸附后的时间与距离；超出 maxDistance 则保持原时间。
 */
export function snapToBeats(
  target: number,
  beats: readonly { time: number; downbeat: boolean }[],
  maxDistance: number,
  preferDownbeat: boolean,
): { time: number; distance: number; index: number } {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const distance = Math.abs(b.time - target);
    if (distance > maxDistance) continue;
    // downbeat 倾向：重拍在等距时优先，远距离惩罚更小。
    const score = distance * (preferDownbeat && b.downbeat ? 0.5 : 1);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return { time: target, distance: Infinity, index: -1 };
  return { time: beats[best].time, distance: Math.abs(beats[best].time - target), index: best };
}

/** 判断 time 是否落在某个说话区间内。 */
export function findContainingSpeech(
  time: number,
  speech: readonly { start: number; end: number }[],
): { start: number; end: number } | null {
  for (const span of speech) {
    if (time >= span.start && time <= span.end) return span;
  }
  return null;
}
