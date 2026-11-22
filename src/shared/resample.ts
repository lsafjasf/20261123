export function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input.slice();
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

export function resampleRatio(input: Float32Array, outputLength: number): Float32Array {
  if (outputLength === input.length) return input.slice();
  const ratio = input.length / outputLength;
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

export function cubicAt(input: Float32Array, position: number): number {
  const idx = Math.floor(position);
  const frac = position - idx;
  const p0 = input[idx - 1] ?? input[idx] ?? 0;
  const p1 = input[idx] ?? 0;
  const p2 = input[idx + 1] ?? p1;
  const p3 = input[idx + 2] ?? p2;
  const f2 = frac * frac;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * frac +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f2 * frac)
  );
}
