/**
 * Exact rational arithmetic on bigints.
 *
 * Frame rates such as 30000/1001 and speed factors such as 0.1% ramps
 * cannot be represented exactly in binary floating point. All timeline
 * math in the migrator goes through Rational so that a cut point is
 * either exact or carries a precisely known rounding error.
 */

export interface Rational {
  readonly num: bigint;
  readonly den: bigint; // always > 0, always reduced
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export function rational(num: bigint | number, den: bigint | number = 1n): Rational {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) throw new RangeError("rational: denominator is zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

export const ZERO: Rational = rational(0n);
export const ONE: Rational = rational(1n);

/** Parses "30000/1001", "29.97", "25", "-1.5" into an exact Rational. */
export function parseRational(text: string): Rational {
  const s = text.trim();
  const slash = s.indexOf("/");
  if (slash >= 0) {
    const n = s.slice(0, slash).trim();
    const d = s.slice(slash + 1).trim();
    if (!/^[+-]?\d+$/.test(n) || !/^[+-]?\d+$/.test(d)) {
      throw new SyntaxError(`rational: bad fraction "${text}"`);
    }
    return rational(BigInt(n), BigInt(d));
  }
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) throw new SyntaxError(`rational: bad number "${text}"`);
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2];
  const fracPart = m[3] ?? "";
  const exp = m[4] ? BigInt(m[4]) : 0n;
  let num = BigInt(intPart + fracPart) * sign;
  let den = 10n ** BigInt(fracPart.length);
  if (exp >= 0n) num *= 10n ** exp;
  else den *= 10n ** -exp;
  return rational(num, den);
}

/** Converts a JS number to a Rational via its shortest decimal string. */
export function fromNumber(value: number): Rational {
  if (!Number.isFinite(value)) {
    throw new RangeError(`rational: non-finite number ${value}`);
  }
  return parseRational(String(value));
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new RangeError("rational: division by zero");
  return rational(a.num * b.den, a.den * b.num);
}

export function neg(a: Rational): Rational {
  return rational(-a.num, a.den);
}

export function abs(a: Rational): Rational {
  return a.num < 0n ? neg(a) : a;
}

export function cmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function toNumber(a: Rational): number {
  return Number(a.num) / Number(a.den);
}

export interface RoundedInt {
  readonly value: bigint;
  /** Signed error (exact - rounded), magnitude <= 1/2. */
  readonly error: Rational;
  readonly exact: boolean;
}

/** Rounds to the nearest integer; ties round away from zero. */
export function roundToInt(a: Rational): RoundedInt {
  const q = a.num / a.den;
  const r = a.num % a.den; // sign follows num
  const twice = r * 2n;
  let value = q;
  if (twice >= a.den) value = q + 1n;
  else if (twice <= -a.den) value = q - 1n;
  const error = sub(a, rational(value));
  return { value, error, exact: error.num === 0n };
}

export function toString(a: Rational): string {
  if (a.den === 1n) return a.num.toString();
  return `${a.num}/${a.den}`;
}
