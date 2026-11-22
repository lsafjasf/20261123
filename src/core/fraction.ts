export interface Fraction {
  readonly numerator: number;
  readonly denominator: number;
}

function gcd(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left === 0 ? 1 : left;
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} is outside the safe integer range: ${value}`);
  }
}

export function fraction(numerator: number, denominator = 1): Fraction {
  assertSafeInteger(numerator, "fraction numerator");
  assertSafeInteger(denominator, "fraction denominator");
  if (denominator === 0) {
    throw new RangeError("fraction denominator cannot be zero");
  }
  const sign = denominator < 0 ? -1 : 1;
  const divisor = gcd(numerator, denominator);
  return {
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  };
}

export const ZERO = fraction(0);

export function add(left: Fraction, right: Fraction): Fraction {
  const numerator =
    left.numerator * right.denominator + right.numerator * left.denominator;
  const denominator = left.denominator * right.denominator;
  assertSafeInteger(numerator, "fraction sum numerator");
  assertSafeInteger(denominator, "fraction sum denominator");
  return fraction(numerator, denominator);
}

export function subtract(left: Fraction, right: Fraction): Fraction {
  return add(left, fraction(-right.numerator, right.denominator));
}

export function compare(left: Fraction, right: Fraction): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference === 0 ? 0 : difference < 0 ? -1 : 1;
}

export function equals(left: Fraction, right: Fraction): boolean {
  return compare(left, right) === 0;
}

export function lessThan(left: Fraction, right: Fraction): boolean {
  return compare(left, right) < 0;
}

export function min(left: Fraction, right: Fraction): Fraction {
  return lessThan(left, right) ? left : right;
}

export function max(left: Fraction, right: Fraction): Fraction {
  return lessThan(left, right) ? right : left;
}

export function floorFraction(value: Fraction): number {
  return Math.floor(value.numerator / value.denominator);
}

export function ceilFraction(value: Fraction): number {
  return Math.ceil(value.numerator / value.denominator);
}

export function toNumber(value: Fraction): number {
  return value.numerator / value.denominator;
}

export function clamp(value: Fraction, lower: Fraction, upper: Fraction): Fraction {
  if (lessThan(value, lower)) {
    return lower;
  }
  if (lessThan(upper, value)) {
    return upper;
  }
  return value;
}

export function framesToMicroseconds(frames: Fraction, sampleRate: number): number {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive integer");
  }
  return (toNumber(frames) * 1_000_000) / sampleRate;
}

export function microsecondsToFrames(
  microseconds: number,
  sampleRate: number,
): Fraction {
  if (!Number.isFinite(microseconds)) {
    throw new RangeError("microseconds must be finite");
  }
  const microsecondsPerSecond = 1_000_000;
  return fraction(
    Math.round(microseconds * sampleRate),
    microsecondsPerSecond,
  );
}
