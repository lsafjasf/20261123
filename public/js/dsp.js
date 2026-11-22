                                                         

const TAU = Math.PI * 2;

export function clamp(value        , min        , max        )         {
  return Math.min(max, Math.max(min, value));
}

export function dbFromAmplitude(value        )         {
  return 20 * Math.log10(Math.max(1e-9, Math.abs(value)));
}

export function amplitudeFromDb(db        )         {
  return Math.pow(10, db / 20);
}

export function percentile(values              , ratio        )         {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort();
  const at = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1);
  return sorted[at];
}

export function median(values          )         {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function downmix(pcm          )               {
  if (pcm.channels.length === 1) return pcm.channels[0];
  const mono = new Float32Array(pcm.length);
  const scale = 1 / pcm.channels.length;
  for (const channel of pcm.channels) {
    for (let index = 0; index < pcm.length; index += 1) mono[index] += channel[index] * scale;
  }
  return mono;
}

export function fft(re              , im              )       {
  const size = re.length;
  if ((size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-TAU) / length;
    const half = length >> 1;
    for (let offset = 0; offset < size; offset += length) {
      for (let index = 0; index < half; index += 1) {
        const cos = Math.cos(angle * index);
        const sin = Math.sin(angle * index);
        const even = offset + index;
        const odd = even + half;
        const oddRe = re[odd] * cos - im[odd] * sin;
        const oddIm = re[odd] * sin + im[odd] * cos;
        re[odd] = re[even] - oddRe;
        im[odd] = im[even] - oddIm;
        re[even] += oddRe;
        im[even] += oddIm;
      }
    }
  }
}

export function makeHann(size        )               {
  const window = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((TAU * index) / (size - 1));
  }
  return window;
}

export function analyzeFrame(
  mono              ,
  sampleRate        ,
  center        ,
  frameSize        ,
  window              ,
  index        ,
)               {
  const start = Math.max(0, Math.min(mono.length - frameSize, center - (frameSize >> 1)));
  const end = Math.min(mono.length, start + frameSize);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  let sum = 0;
  let square = 0;
  let peak = 0;
  let crossings = 0;
  let previous = 0;

  for (let offset = 0; offset < frameSize; offset += 1) {
    const sourceIndex = Math.min(mono.length - 1, start + offset);
    const value = mono[sourceIndex] || 0;
    sum += value;
    square += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (offset > 0 && (value >= 0) !== (previous >= 0)) crossings += 1;
    previous = value;
    re[offset] = value * window[offset];
  }

  const mean = sum / frameSize;
  const rms = Math.sqrt(Math.max(1e-12, square / frameSize));
  fft(re, im);

  let totalPower = 0;
  let weightedFrequency = 0;
  let lowPower = 0;
  let voicePower = 0;
  let highPower = 0;
  let logPower = 0;
  let bins = 0;
  const binWidth = sampleRate / frameSize;
  for (let bin = 2; bin < frameSize / 2; bin += 1) {
    const frequency = bin * binWidth;
    if (frequency > Math.min(8500, sampleRate * 0.46)) break;
    const power = re[bin] * re[bin] + im[bin] * im[bin] + 1e-15;
    totalPower += power;
    weightedFrequency += frequency * power;
    logPower += Math.log(power);
    bins += 1;
    if (frequency >= 24 && frequency < 180) lowPower += power;
    else if (frequency >= 180 && frequency < 2200) voicePower += power;
    else if (frequency >= 2200 && frequency < 8000) highPower += power;
  }

  const magnitudeMean = totalPower / Math.max(1, bins);
  const geometric = Math.exp(logPower / Math.max(1, bins));
  const flatness = clamp(geometric / Math.max(1e-15, magnitudeMean), 0, 1);
  const centroid = weightedFrequency / Math.max(1e-15, totalPower);
  const safeTotal = Math.max(1e-15, totalPower);

  return {
    index,
    start,
    end,
    rmsDb: dbFromAmplitude(rms),
    peakDb: dbFromAmplitude(peak),
    zcr: crossings / Math.max(1, frameSize - 1),
    centroidHz: centroid,
    flatness,
    lowRatio: lowPower / safeTotal,
    voiceRatio: voicePower / safeTotal,
    highRatio: highPower / safeTotal,
    crest: peak / Math.max(1e-6, rms),
    voiced: false,
    transient: false,
  };
}

export function analyzeFrames(
  pcm          ,
  frameSize = 1024,
  hopSize = 256,
)                 {
  const mono = downmix(pcm);
  const window = makeHann(frameSize);
  const frames                 = [];
  const lastCenter = Math.max(frameSize >> 1, mono.length - (frameSize >> 1));
  let index = 0;
  for (let center = frameSize >> 1; center <= lastCenter; center += hopSize) {
    frames.push(analyzeFrame(mono, pcm.sampleRate, center, frameSize, window, index));
    index += 1;
  }
  return frames;
}

export function measureRmsDb(pcm          , start        , end        )         {
  let square = 0;
  let count = 0;
  const from = clamp(Math.floor(start), 0, pcm.length);
  const to = clamp(Math.ceil(end), from, pcm.length);
  for (const channel of pcm.channels) {
    for (let index = from; index < to; index += 1) {
      square += channel[index] * channel[index];
      count += 1;
    }
  }
  return dbFromAmplitude(Math.sqrt(square / Math.max(1, count)));
}

export function measurePeak(pcm          )         {
  let peak = 0;
  for (const channel of pcm.channels) {
    for (let index = 0; index < channel.length; index += 1) {
      peak = Math.max(peak, Math.abs(channel[index]));
    }
  }
  return peak;
}

export function interleaveFloat32(pcm          )               {
  const output = new Float32Array(pcm.length * pcm.channels.length);
  for (let frame = 0; frame < pcm.length; frame += 1) {
    for (let channel = 0; channel < pcm.channels.length; channel += 1) {
      output[frame * pcm.channels.length + channel] = pcm.channels[channel][frame] || 0;
    }
  }
  return output;
}

export function encodeWavFloat32(pcm          )              {
  const channelCount = pcm.channels.length;
  const bytesPerSample = 4;
  const dataBytes = pcm.length * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset        , text        ) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 32, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < pcm.length; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      view.setFloat32(offset, pcm.channels[channel][frame] || 0, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

export function cosineFadeIn(index        , length        )         {
  if (length <= 0) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * clamp(index, 0, length)) / length);
}

export function cosineFadeOut(index        , length        )         {
  return 1 - cosineFadeIn(index, length);
}
