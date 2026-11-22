// Frame <-> sample conversion with rational frame rates.
// All rounding uses exact integer (BigInt) arithmetic so trigger points
// are sample-accurate and reproducible at any frame rate.

export interface FrameRate {
  num: number; // frames per second = num / den
  den: number;
}

export const FRAME_RATES: ReadonlyArray<{ label: string; rate: FrameRate }> = [
  { label: '23.976', rate: { num: 24000, den: 1001 } },
  { label: '24', rate: { num: 24, den: 1 } },
  { label: '25', rate: { num: 25, den: 1 } },
  { label: '29.97', rate: { num: 30000, den: 1001 } },
  { label: '30', rate: { num: 30, den: 1 } },
  { label: '50', rate: { num: 50, den: 1 } },
  { label: '59.94', rate: { num: 60000, den: 1001 } },
  { label: '60', rate: { num: 60, den: 1 } },
];

// Floor of n / d for positive d, exact for negative n too.
function divFloor(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

// Ceil of n / d for positive d, exact for negative n too.
function divCeil(n: bigint, d: bigint): bigint {
  return -divFloor(-n, d);
}

function assertFrameRate(rate: FrameRate): void {
  if (!Number.isInteger(rate.num) || !Number.isInteger(rate.den) || rate.num <= 0 || rate.den <= 0) {
    throw new RangeError(`invalid frame rate ${rate.num}/${rate.den}`);
  }
}

/**
 * First sample index that belongs to the given frame: ceil(frame * sr / fps).
 * This never places a trigger before its frame's true start, and inverts
 * exactly under sampleToFrame (for fps <= sampleRate). Frames may be negative.
 */
export function frameToSample(frame: number, rate: FrameRate, sampleRate: number): number {
  assertFrameRate(rate);
  if (!Number.isInteger(frame)) throw new RangeError(`frame must be an integer, got ${frame}`);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`bad sampleRate ${sampleRate}`);
  const n = BigInt(frame) * BigInt(sampleRate) * BigInt(rate.den);
  return Number(divCeil(n, BigInt(rate.num)));
}

/** Frame that contains the given sample index (floor semantics). */
export function sampleToFrame(sample: number, rate: FrameRate, sampleRate: number): number {
  assertFrameRate(rate);
  if (!Number.isInteger(sample)) throw new RangeError(`sample must be an integer, got ${sample}`);
  const n = BigInt(sample) * BigInt(rate.num);
  const d = BigInt(sampleRate) * BigInt(rate.den);
  return Number(divFloor(n, d));
}

/** Float seconds for a sample index — for WebAudio clocks only, never stored. */
export function sampleToSeconds(sample: number, sampleRate: number): number {
  return sample / sampleRate;
}

/** Nominal integer fps for timecode display, e.g. 24 for 24000/1001. */
export function nominalFps(rate: FrameRate): number {
  return Math.round(rate.num / rate.den);
}

/** HH:MM:SS:FF timecode, display only. */
export function formatTimecode(frame: number, rate: FrameRate): string {
  const fps = nominalFps(rate);
  const neg = frame < 0;
  let f = Math.abs(frame);
  const ff = f % fps;
  f = (f - ff) / fps;
  const ss = f % 60;
  f = (f - ss) / 60;
  const mm = f % 60;
  const hh = (f - mm) / 60;
  const p = (v: number) => String(v).padStart(2, '0');
  return `${neg ? '-' : ''}${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}
