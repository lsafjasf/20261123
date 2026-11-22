/**
 * Frame-rate descriptors and SMPTE timecode conversion, including
 * 29.97 drop-frame. A FrameRate is an exact rational (frames per second).
 */

import { rat, toNumber, toString as ratToString } from "./rational.ts";
import type { Rational } from "./rational.ts";

export interface FrameRate {
  /** Frames per second as an exact rational. */
  readonly fps: Rational;
  /** True for NTSC drop-frame counting (only meaningful at 30000/1001). */
  readonly drop: boolean;
  /** Human label, e.g. "23.976", "25", "29.97 DF". */
  readonly label: string;
}

export const RATE_23976: FrameRate = { fps: rat(24000, 1001), drop: false, label: "23.976" };
export const RATE_24: FrameRate = { fps: rat(24), drop: false, label: "24" };
export const RATE_25: FrameRate = { fps: rat(25), drop: false, label: "25" };
export const RATE_2997_NDF: FrameRate = { fps: rat(30000, 1001), drop: false, label: "29.97 NDF" };
export const RATE_2997_DF: FrameRate = { fps: rat(30000, 1001), drop: true, label: "29.97 DF" };
export const RATE_30: FrameRate = { fps: rat(30), drop: false, label: "30" };

const KNOWN: FrameRate[] = [RATE_23976, RATE_24, RATE_25, RATE_2997_NDF, RATE_2997_DF, RATE_30];

/** Nominal (integer) frame count used by timecode arithmetic. */
export function nominalFps(rate: FrameRate): number {
  // 30000/1001 -> 30, 24000/1001 -> 24, 25 -> 25
  return Math.round(toNumber(rate.fps));
}

export function rateFromRational(num: number, den: number, drop = false): FrameRate {
  const fps = rat(num, den);
  for (const k of KNOWN) {
    if (k.fps.num === fps.num && k.fps.den === fps.den && k.drop === drop) return k;
  }
  const approx = toNumber(fps);
  const label = `${Number.isInteger(approx) ? approx : approx.toFixed(3)}${drop ? " DF" : ""}`;
  return { fps, drop, label };
}

/** Loose matcher for strings like "23.976", "23.98", "25", "29.97", "30". */
export function rateFromNumber(value: number, drop = false): FrameRate {
  const scaled = Math.round(value * 1001);
  const candidates: Array<[number, number]> = [
    [scaled, 1001],
    [Math.round(value), 1],
  ];
  for (const [n, d] of candidates) {
    const r = rateFromRational(n, d, drop);
    if (Math.abs(toNumber(r.fps) - value) < 0.01) return r;
  }
  return rateFromRational(Math.round(value * 1000), 1000, drop);
}

export function describeRate(rate: FrameRate): string {
  return `${rate.label} (${ratToString(rate.fps)} fps${rate.drop ? ", drop-frame" : ""})`;
}

export interface TimecodeParts {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly frames: number;
}

/**
 * Parse "HH:MM:SS:FF" (non-drop) or "HH:MM:SS;FF" (drop) into a frame count
 * at the given rate. The separator overrides rate.drop when it is ";".
 */
export function parseTimecode(text: string, rate: FrameRate): number {
  const m = /^(\d{1,3})[:.](\d{2})[:.](\d{2})[:;.](\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`invalid timecode: "${text}"`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const frames = Number(m[4]);
  const drop = text.includes(";") ? true : rate.drop;
  const nominal = nominalFps(rate);
  if (frames >= nominal) throw new Error(`frame ${frames} out of range for ${rate.label}`);
  if (drop) {
    if (nominal !== 30) throw new Error(`drop-frame only supported at 29.97, got ${rate.label}`);
    // Note: real-world EDLs sometimes reference dropped frame numbers
    // (e.g. 00:01:00:00). We tolerate them and map by the standard formula.
    const totalMinutes = 60 * hours + minutes;
    return (totalMinutes * 60 + seconds) * 30 + frames - 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
}

/** Format a frame count as SMPTE timecode at the given rate. */
export function formatTimecode(frameCount: number, rate: FrameRate): string {
  if (!Number.isFinite(frameCount) || frameCount < 0) {
    throw new Error(`cannot format frame count ${frameCount}`);
  }
  const nominal = nominalFps(rate);
  let n = Math.round(frameCount);
  if (rate.drop) {
    if (nominal !== 30) throw new Error(`drop-frame only supported at 29.97, got ${rate.label}`);
    const framesPer10Minutes = 17982;
    const framesPerMinute = 1798;
    const d = Math.floor(n / framesPer10Minutes);
    const m = n % framesPer10Minutes;
    n += 18 * d + 2 * Math.floor(Math.max(0, m - 2) / framesPerMinute);
  }
  const frames = n % nominal;
  const totalSeconds = Math.floor(n / nominal);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const sep = rate.drop ? ";" : ":";
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(hours)}:${p(minutes)}:${p(seconds)}${sep}${p(frames)}`;
}

/** Seconds (exact rational) for a frame count at a rate. */
export function framesToSeconds(frameCount: number | bigint, rate: FrameRate): Rational {
  return rat(BigInt(frameCount) * rate.fps.den, rate.fps.num);
}

/**
 * Convert a frame count from one rate's grid to another's, rounding to the
 * nearest frame on the target grid. Exact rational math, no float drift.
 */
export function convertFrames(frameCount: number | bigint, from: FrameRate, to: FrameRate): bigint {
  const seconds = framesToSeconds(frameCount, from);
  const target = rat(seconds.num * to.fps.num, seconds.den * to.fps.den);
  const q = target.num / target.den;
  const r = target.num % target.den;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice < target.den) return q;
  return target.num >= 0n ? q + 1n : q - 1n;
}
