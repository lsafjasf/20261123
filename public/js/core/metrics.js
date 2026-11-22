                                                           

export function lumaMae(a           , b           , mask             )         {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("Frames must have identical dimensions");
  }
  let total = 0;
  let count = 0;
  for (let pixel = 0, index = 0; pixel < a.width * a.height; pixel += 1, index += 4) {
    if (mask && !mask[pixel]) continue;
    const aLuma = (a.data[index] * 77 + a.data[index + 1] * 150 + a.data[index + 2] * 29) >> 8;
    const bLuma = (b.data[index] * 77 + b.data[index + 1] * 150 + b.data[index + 2] * 29) >> 8;
    total += Math.abs(aLuma - bLuma);
    count += 1;
  }
  return count ? total / count : 0;
}

export function peakLumaError(a           , b           , mask             )         {
  let peak = 0;
  for (let pixel = 0, index = 0; pixel < a.width * a.height; pixel += 1, index += 4) {
    if (mask && !mask[pixel]) continue;
    const aLuma = (a.data[index] * 77 + a.data[index + 1] * 150 + a.data[index + 2] * 29) >> 8;
    const bLuma = (b.data[index] * 77 + b.data[index + 1] * 150 + b.data[index + 2] * 29) >> 8;
    peak = Math.max(peak, Math.abs(aLuma - bLuma));
  }
  return peak;
}

export function countMask(mask            )         {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) count += 1;
  }
  return count;
}

export function formatInterval(summary               )         {
  return `${summary.averageIntervalMs.toFixed(3)} ms`;
}
