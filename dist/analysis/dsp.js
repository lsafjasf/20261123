export function clamp(value        , min        , max        )         {
  return Math.max(min, Math.min(max, value));
}

export function median(values                   )         {
  if (!values.length) return 0;
  const copy = Float32Array.from(values);
  copy.sort();
  const middle = copy.length >> 1;
  return copy.length % 2
    ? copy[middle]
    : (copy[middle - 1] + copy[middle]) * 0.5;
}

export function percentile(values                   , ratio        )         {
  if (!values.length) return 0;
  const copy = Float32Array.from(values);
  copy.sort();
  return copy[clamp(Math.floor((copy.length - 1) * ratio), 0, copy.length - 1)];
}

export function fftReal(real              , imag              )       {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const realValue = real[i];
      const imagValue = imag[i];
      real[i] = real[j];
      imag[i] = imag[j];
      real[j] = realValue;
      imag[j] = imagValue;
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      const half = length >> 1;
      for (let offset = 0; offset < half; offset++) {
        const even = start + offset;
        const odd = even + half;
        const oddReal =
          real[odd] * twiddleReal - imag[odd] * twiddleImag;
        const oddImag =
          real[odd] * twiddleImag + imag[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

export function hannWindow(size        )               {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return window;
}

export function dbFromRms(rms        )         {
  return 20 * Math.log10(Math.max(rms, 1e-8));
}
