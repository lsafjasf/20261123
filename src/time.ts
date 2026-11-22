// 整数时间基元：所有时间以 (ticks, timescale) 的有理数对表示，
// 运算全程使用 BigInt，绝不把秒当浮点数累加。

export interface Ticks {
  ticks: bigint;
  timescale: number; // 每秒多少 tick，正整数
}

export function ticks(value: bigint | number, timescale: number): Ticks {
  if (!Number.isSafeInteger(timescale) || timescale <= 0) {
    throw new Error(`非法 timescale: ${timescale}`);
  }
  return { ticks: BigInt(value), timescale };
}

export function zeroOf(timescale: number): Ticks {
  return { ticks: 0n, timescale };
}

export function addTicks(a: Ticks, b: Ticks): Ticks {
  if (a.timescale !== b.timescale) {
    throw new Error(`timescale 不一致: ${a.timescale} vs ${b.timescale}`);
  }
  return { ticks: a.ticks + b.ticks, timescale: a.timescale };
}

export function subTicks(a: Ticks, b: Ticks): bigint {
  if (a.timescale !== b.timescale) {
    throw new Error(`timescale 不一致: ${a.timescale} vs ${b.timescale}`);
  }
  return a.ticks - b.ticks;
}

export interface Converted {
  ticks: bigint; // 商（向零取整）
  rem: bigint; // 余数，0 表示完全整除
  timescale: number;
}

// 精确换算：ticks * toScale / fromScale，返回商与余数，不丢信息。
export function convertExact(t: Ticks, toScale: number): Converted {
  const num = t.ticks * BigInt(toScale);
  const den = BigInt(t.timescale);
  const q = num / den;
  return { ticks: q, rem: num - q * den, timescale: toScale };
}

export interface Rounded {
  ticks: bigint;
  exact: boolean; // 换算是否无舍入
  errorNum: bigint; // 舍入误差 = errorNum / (2 * fromScale) tick（目标刻度）
  errorDen: bigint;
}

// 换算到目标刻度并做最近舍入（仅在最终落点舍入一次，且如实报告误差）。
export function convertRound(t: Ticks, toScale: number): Rounded {
  const num = t.ticks * BigInt(toScale);
  const den = BigInt(t.timescale);
  let q = num / den;
  const r = num - q * den; // 与 num 同号
  const twice = r * 2n;
  if (twice >= den) q += 1n;
  else if (twice <= -den) q -= 1n;
  const err = num - q * den; // 目标刻度下的残差（相对 fromScale 分母）
  return {
    ticks: q,
    exact: err === 0n,
    errorNum: err < 0n ? -err : err,
    errorDen: den,
  };
}

// 第 n 帧的时间戳：anchor + n * num / den，按帧号直接计算（非累加），
// 误差恒小于 1 tick，永不随时长漂移。
export function frameTicksAt(
  index: bigint,
  frameDurNum: bigint,
  frameDurDen: bigint,
): bigint {
  const num = index * frameDurNum;
  const q = num / frameDurDen;
  const r = num - q * frameDurDen;
  return r * 2n >= frameDurDen ? q + 1n : q;
}

// 帧率 -> 每帧 tick 数（既约有理数）。
export function frameDuration(
  fpsNum: number,
  fpsDen: number,
  timescale: number,
): { num: bigint; den: bigint; exact: boolean } {
  const num = BigInt(timescale) * BigInt(fpsDen);
  const den = BigInt(fpsNum);
  const g = gcd(num, den);
  return { num: num / g, den: den / g, exact: den === g };
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

// 精确秒数字符串，如 "12.345600"（微秒位，最近舍入，不进位到整数部分出错）。
export function formatSeconds(t: Ticks, fracDigits = 6): string {
  const scale = BigInt(t.timescale);
  const neg = t.ticks < 0n;
  const abs = neg ? -t.ticks : t.ticks;
  const ip = abs / scale;
  const rem = abs % scale;
  const unit = 10n ** BigInt(fracDigits);
  const fracNum = rem * unit;
  let frac = fracNum / scale;
  if ((fracNum % scale) * 2n >= scale) frac += 1n;
  if (frac >= unit) {
    return `${neg ? "-" : ""}${ip + 1n}.${"0".repeat(fracDigits)}`;
  }
  return `${neg ? "-" : ""}${ip}.${frac.toString().padStart(fracDigits, "0")}`;
}

// 供对照表使用：精确有理数形式 "ticks/timescale"。
export function formatRational(t: Ticks): string {
  return `${t.ticks}/${t.timescale}`;
}
