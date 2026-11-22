export type RoundingMode = "floor" | "ceil" | "trunc" | "half-up" | "half-even";

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function integerFrom(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer; use a rational string for exact values`);
  }
  return BigInt(value);
}

/**
 * An immutable, normalized rational number. Media timing never uses this
 * class's decimal form except at an external API boundary.
 */
export class Rational {
  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    if (d === 0n) throw new RangeError("rational denominator cannot be zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const divisor = gcd(n, d);
    this.n = n / divisor;
    this.d = d / divisor;
  }

  static of(numerator: bigint | number, denominator: bigint | number = 1n): Rational {
    return new Rational(
      integerFrom(numerator, "numerator"),
      integerFrom(denominator, "denominator"),
    );
  }

  static integer(value: bigint | number): Rational {
    return Rational.of(value);
  }

  static zero(): Rational {
    return Rational.of(0n);
  }

  static one(): Rational {
    return Rational.of(1n);
  }

  static parse(input: string | bigint | number): Rational {
    if (typeof input === "bigint") return Rational.integer(input);
    if (typeof input === "number") return Rational.integer(input);
    const text = input.trim();
    const ratio = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(text);
    if (ratio) return Rational.of(BigInt(ratio[1]), BigInt(ratio[2]));
    if (/^[+-]?\d+$/.test(text)) return Rational.integer(BigInt(text));
    throw new TypeError(`not an exact rational: ${JSON.stringify(input)}`);
  }

  static fromDecimal(input: string): Rational {
    const text = input.trim();
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new TypeError(`not a decimal literal: ${JSON.stringify(input)}`);
    const sign = match[1] === "-" ? -1n : 1n;
    const fraction = match[3] ?? "";
    const denominator = 10n ** BigInt(fraction.length);
    return Rational.of(sign * BigInt(`${match[2]}${fraction}`), denominator);
  }

  add(other: Rational): Rational {
    return new Rational(this.n * other.d + other.n * this.d, this.d * other.d);
  }

  sub(other: Rational): Rational {
    return new Rational(this.n * other.d - other.n * this.d, this.d * other.d);
  }

  mul(other: Rational): Rational {
    return new Rational(this.n * other.n, this.d * other.d);
  }

  div(other: Rational): Rational {
    if (other.n === 0n) throw new RangeError("division by zero");
    return new Rational(this.n * other.d, this.d * other.n);
  }

  neg(): Rational {
    return new Rational(-this.n, this.d);
  }

  abs(): Rational {
    return this.n < 0n ? this.neg() : this;
  }

  compare(other: Rational): -1 | 0 | 1 {
    const left = this.n * other.d;
    const right = other.n * this.d;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.n === other.n && this.d === other.d;
  }

  isInteger(): boolean {
    return this.d === 1n;
  }

  floor(): bigint {
    const quotient = this.n / this.d;
    return this.n < 0n && this.n % this.d !== 0n ? quotient - 1n : quotient;
  }

  ceil(): bigint {
    const quotient = this.n / this.d;
    return this.n > 0n && this.n % this.d !== 0n ? quotient + 1n : quotient;
  }

  trunc(): bigint {
    return this.n / this.d;
  }

  round(mode: RoundingMode = "half-even"): bigint {
    if (mode === "floor") return this.floor();
    if (mode === "ceil") return this.ceil();
    if (mode === "trunc") return this.trunc();

    const lower = this.floor();
    const remainder = this.sub(Rational.integer(lower));
    const twice = remainder.mul(Rational.of(2n));
    const comparison = twice.compare(Rational.one());
    if (comparison < 0) return lower;
    if (comparison > 0) return lower + 1n;
    if (mode === "half-up") return lower + 1n;
    return lower % 2n === 0n ? lower : lower + 1n;
  }

  /**
   * Lossy by definition. Use only when a platform API requires a number.
   * Internal storage and comparisons must remain rational.
   */
  toPlatformNumber(): number {
    return Number(this.n) / Number(this.d);
  }

  toDecimal(places: number, rounding: RoundingMode = "half-even"): string {
    if (!Number.isInteger(places) || places < 0 || places > 18) {
      throw new RangeError("places must be an integer from 0 through 18");
    }
    const scale = 10n ** BigInt(places);
    const scaled = this.mul(Rational.integer(scale));
    const rounded = scaled.round(rounding);
    const sign = rounded < 0n ? "-" : "";
    const magnitude = rounded < 0n ? -rounded : rounded;
    if (places === 0) return `${sign}${magnitude}`;
    const text = magnitude.toString().padStart(places + 1, "0");
    return `${sign}${text.slice(0, -places)}.${text.slice(-places)}`;
  }

  toString(): string {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }

  toJSON(): { n: string; d: string } {
    return { n: this.n.toString(), d: this.d.toString() };
  }
}

export function rational(input: string | bigint | number): Rational {
  return Rational.parse(input);
}

export function minRational(left: Rational, right: Rational): Rational {
  return left.compare(right) <= 0 ? left : right;
}

export function maxRational(left: Rational, right: Rational): Rational {
  return left.compare(right) >= 0 ? left : right;
}
