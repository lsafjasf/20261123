/**
 * Exact rational arithmetic on BigInt. All timeline math goes through this
 * module so that 24000/1001 vs 25/1 conversions never accumulate float error.
 */

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function rat(num: bigint | number, den: bigint | number = 1): Rational {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) throw new Error("rational with zero denominator");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(abs(n), d);
  return { num: n / g, den: d / g };
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export function add(a: Rational, b: Rational): Rational {
  return rat(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Rational, b: Rational): Rational {
  return rat(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return rat(a.num * b.num, a.den * b.den);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new Error("rational division by zero");
  return rat(a.num * b.den, a.den * b.num);
}

export function cmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

/** Round to nearest integer; ties go away from zero. */
export function round(a: Rational): bigint {
  const q = a.num / a.den;
  const r = a.num % a.den;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice < a.den) return q;
  return a.num >= 0n ? q + 1n : q - 1n;
}

export function floor(a: Rational): bigint {
  const q = a.num / a.den;
  return a.num % a.den !== 0n && a.num < 0n ? q - 1n : q;
}

export function toNumber(a: Rational): number {
  return Number(a.num) / Number(a.den);
}

export function toString(a: Rational): string {
  return a.den === 1n ? `${a.num}` : `${a.num}/${a.den}`;
}
