import type { LoudnessResult, MasterResult } from "./types.ts";

const K_SHELF = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};

const K_HIGHPASS = {
  b0: 1,
  b1: -2,
  b2: 1,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function linearToDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

function biquad(input: Float32Array, coefficients: typeof K_SHELF): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x0 = input[index];
    const y0 =
      coefficients.b0 * x0 +
      coefficients.b1 * x1 +
      coefficients.b2 * x2 -
      coefficients.a1 * y1 -
      coefficients.a2 * y2;
    output[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

function kWeighted(channels: Float32Array[]): Float32Array[] {
  return channels.map((channel) => biquad(biquad(channel, K_SHELF), K_HIGHPASS));
}

function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  if (channels.length === 0 || channels[0].length === 0) return -Infinity;
  const weighted = kWeighted(channels);
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4));
  const step = Math.max(1, Math.round(sampleRate * 0.1));
  const sampleCount = Math.min(...weighted.map((channel) => channel.length));
  const blockCount = Math.max(1, Math.floor(Math.max(0, sampleCount - blockSize) / step) + 1);
  const blockLoudness: number[] = [];

  for (let block = 0; block < blockCount; block += 1) {
    const start = block * step;
    const end = Math.min(start + blockSize, sampleCount);
    if (end <= start) continue;
    let sumSquares = 0;
    for (const channel of weighted) {
      for (let index = start; index < end; index += 1) {
        const sample = channel[index];
        sumSquares += sample * sample;
      }
    }
    const meanSquare = sumSquares / (end - start);
    if (meanSquare <= 0) continue;
    blockLoudness.push(-0.691 + 10 * Math.log10(meanSquare));
  }

  const absolutelyGated = blockLoudness.filter((value) => value > -70);
  if (absolutelyGated.length === 0) return -Infinity;
  const absoluteMean = absolutelyGated.reduce((sum, value) => sum + Math.pow(10, value / 10), 0) /
    absolutelyGated.length;
  const relativeGate = -0.691 + 10 * Math.log10(absoluteMean) - 10;
  const gated = absolutelyGated.filter((value) => value > relativeGate);
  if (gated.length === 0) return -Infinity;
  const mean = gated.reduce((sum, value) => sum + Math.pow(10, value / 10), 0) / gated.length;
  return -0.691 + 10 * Math.log10(mean);
}

function blackman(position: number, radius: number): number {
  const x = clamp(position / radius, -1, 1);
  return 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-9) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function buildInterpolationPhases(radius = 8): Float32Array[] {
  const phases: Float32Array[] = [];
  for (let phase = 1; phase < 4; phase += 1) {
    const fraction = phase / 4;
    const taps = new Float32Array(radius * 2);
    let sum = 0;
    for (let offset = -radius + 1; offset <= radius; offset += 1) {
      const distance = fraction - offset;
      const weight = sinc(distance) * blackman(distance, radius);
      taps[offset + radius - 1] = weight;
      sum += weight;
    }
    if (Math.abs(sum) > 1e-9) {
      for (let index = 0; index < taps.length; index += 1) taps[index] /= sum;
    }
    phases.push(taps);
  }
  return phases;
}

const interpolationPhases = buildInterpolationPhases();

function truePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      peak = Math.max(peak, Math.abs(channel[index]));
    }
  }

  const radius = 8;
  for (const taps of interpolationPhases) {
    for (const channel of channels) {
      for (let index = 0; index < channel.length; index += 1) {
        let interpolated = 0;
        for (let tap = 0; tap < taps.length; tap += 1) {
          const sampleIndex = index + tap - radius + 1;
          if (sampleIndex >= 0 && sampleIndex < channel.length) {
            interpolated += channel[sampleIndex] * taps[tap];
          }
        }
        peak = Math.max(peak, Math.abs(interpolated));
      }
    }
  }
  return peak;
}

export function measureLoudness(channels: Float32Array[], sampleRate: number): LoudnessResult {
  return {
    integratedLufs: integratedLoudness(channels, sampleRate),
    truePeakDb: linearToDb(truePeak(channels)),
    limitedSamples: 0,
  };
}

function applyGain(channels: Float32Array[], gain: number): Float32Array[] {
  return channels.map((channel) => {
    const output = new Float32Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      output[index] = channel[index] * gain;
    }
    return output;
  });
}

function limitPeaks(
  channels: Float32Array[],
  sampleRate: number,
  ceilingDb: number,
): { channels: Float32Array[]; limitedSamples: number } {
  const sampleCount = Math.min(...channels.map((channel) => channel.length));
  const ceiling = dbToLinear(ceilingDb);
  const targetGain = new Float32Array(sampleCount);
  let limitedSamples = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    let peak = 0;
    for (const channel of channels) peak = Math.max(peak, Math.abs(channel[index]));
    const gain = peak > ceiling ? ceiling / peak : 1;
    targetGain[index] = gain;
    if (gain < 0.99999) limitedSamples += 1;
  }

  const lookahead = Math.max(1, Math.round(sampleRate * 0.005));
  const desired = new Float32Array(sampleCount);
  const deque = new Int32Array(sampleCount + 1);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < sampleCount + lookahead; index += 1) {
    if (index < sampleCount) {
      while (tail > head && targetGain[deque[tail - 1]] >= targetGain[index]) tail -= 1;
      deque[tail] = index;
      tail += 1;
    }
    const outputIndex = index - lookahead;
    if (outputIndex >= 0) {
      while (head < tail && deque[head] < outputIndex) head += 1;
      desired[outputIndex] = head < tail ? targetGain[deque[head]] : 1;
    }
  }

  const release = Math.exp(-1 / (sampleRate * 0.08));
  const output = channels.map(() => new Float32Array(sampleCount));
  let gain = 1;
  for (let index = 0; index < sampleCount; index += 1) {
    const required = desired[index];
    gain = required < gain ? required : required + (gain - required) * release;
    gain = clamp(gain, 0, 1);
    for (let channel = 0; channel < channels.length; channel += 1) {
      output[channel][index] = channels[channel][index] * gain;
    }
  }

  return { channels: output, limitedSamples };
}

export function masterAudio(
  channels: Float32Array[],
  sampleRate: number,
  targetLufs: number,
  peakCeilingDb = -1,
): MasterResult {
  let current = channels.map((channel) => channel.slice());
  const initial = integratedLoudness(current, sampleRate);
  if (!Number.isFinite(initial)) {
    return {
      channels: current,
      integratedLufs: initial,
      truePeakDb: linearToDb(truePeak(current)),
      limitedSamples: 0,
      gainDb: 0,
    };
  }

  let totalGainDb = targetLufs - initial;
  let limitedSamples = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const gained = applyGain(current, dbToLinear(targetLufs - integratedLoudness(current, sampleRate)));
    const limited = limitPeaks(gained, sampleRate, peakCeilingDb - 0.08);
    current = limited.channels;
    limitedSamples += limited.limitedSamples;
    const actual = integratedLoudness(current, sampleRate);
    if (!Number.isFinite(actual) || actual >= targetLufs - 0.16) break;
  }

  let measuredPeak = truePeak(current);
  const safetyCeiling = dbToLinear(peakCeilingDb);
  if (measuredPeak > safetyCeiling) {
    const trim = safetyCeiling / measuredPeak;
    current = current.map((channel) => channel.map((sample) => sample * trim));
    measuredPeak *= trim;
    limitedSamples += 1;
  }

  const finalLufs = integratedLoudness(current, sampleRate);
  totalGainDb += targetLufs - finalLufs;
  return {
    channels: current,
    integratedLufs: finalLufs,
    truePeakDb: linearToDb(measuredPeak),
    limitedSamples,
    gainDb: totalGainDb,
  };
}
