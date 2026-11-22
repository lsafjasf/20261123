import type {
  AudioSource,
  DetectedPause,
  RenderOptions,
  RenderResult,
  SegmentTimeline,
} from "./types.ts";

interface SpliceResult {
  channels: Float32Array[];
  sourceDuration: number;
  timeline: SegmentTimeline[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function copyRange(
  target: Float32Array,
  targetOffset: number,
  source: Float32Array,
  sourceOffset: number,
  length: number,
): void {
  if (length <= 0) return;
  const safeLength = Math.min(length, source.length - sourceOffset, target.length - targetOffset);
  if (safeLength <= 0) return;
  target.set(source.subarray(sourceOffset, sourceOffset + safeLength), targetOffset);
}

function splicePauses(source: AudioSource, options: RenderOptions): SpliceResult {
  const sampleRate = source.sampleRate;
  const sourceLength = source.channels[0].length;
  const sorted = options.segments
    .filter((segment) => segment.duration > 0)
    .slice()
    .sort((a, b) => a.sourceStart - b.sourceStart);

  let removedSamples = 0;
  for (const segment of sorted) {
    if (segment.state !== "active") continue;
    const start = clamp(Math.round(segment.sourceStart * sampleRate), 0, sourceLength);
    const end = clamp(Math.round(segment.sourceEnd * sampleRate), start, sourceLength);
    const target = clamp(
      Math.round((segment.targetMs / 1000) * options.speed * sampleRate),
      0,
      end - start,
    );
    removedSamples += end - start - target;
  }

  const outputLength = Math.max(1, sourceLength - removedSamples);
  const channels = source.channels.map(() => new Float32Array(outputLength));
  const timeline: SegmentTimeline[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;
  const fadeSamples = Math.min(Math.round(sampleRate * 0.008), outputLength);

  for (const segment of sorted) {
    const start = clamp(Math.round(segment.sourceStart * sampleRate), sourceCursor, sourceLength);
    const end = clamp(Math.round(segment.sourceEnd * sampleRate), start, sourceLength);
    const cleanLength = start - sourceCursor;
    if (cleanLength > 0) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        copyRange(channels[channel], outputCursor, source.channels[channel], sourceCursor, cleanLength);
      }
      outputCursor += cleanLength;
      sourceCursor = start;
    }

    const segmentOutputStart = outputCursor;
    if (segment.state === "active") {
      const target = clamp(
        Math.round((segment.targetMs / 1000) * options.speed * sampleRate),
        0,
        end - start,
      );
      const headLength = Math.ceil(target / 2);
      const tailLength = target - headLength;
      const fadeLength = Math.min(fadeSamples, Math.floor(target / 4));
      for (let channel = 0; channel < channels.length; channel += 1) {
        const output = channels[channel];
        const input = source.channels[channel];
        copyRange(output, outputCursor, input, start, headLength);
        if (tailLength > 0) {
          const tailSource = end - tailLength;
          const tailWrite = outputCursor + headLength;
          copyRange(output, tailWrite, input, tailSource, tailLength);
          for (let index = 0; index < fadeLength; index += 1) {
            const mix = (index + 1) / (fadeLength + 1);
            const before = output[tailWrite + index];
            const after = input[tailSource + index];
            output[tailWrite + index] = before * (1 - mix) + after * mix;
          }
        }
      }
      outputCursor += target;
    } else {
      const keepLength = end - start;
      for (let channel = 0; channel < channels.length; channel += 1) {
        copyRange(channels[channel], outputCursor, source.channels[channel], start, keepLength);
      }
      outputCursor += keepLength;
    }
    sourceCursor = end;

    timeline.push({
      segment,
      outputStart: segmentOutputStart / sampleRate,
      outputEnd: outputCursor / sampleRate,
    });
  }

  const tailLength = sourceLength - sourceCursor;
  if (tailLength > 0) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      copyRange(channels[channel], outputCursor, source.channels[channel], sourceCursor, tailLength);
    }
    outputCursor += tailLength;
  }

  return {
    channels,
    sourceDuration: outputCursor / sampleRate,
    timeline,
  };
}

interface FftTables {
  size: number;
  reverse: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

function fftTables(size: number): FftTables {
  const reverse = new Uint32Array(size);
  let bits = 0;
  while (1 << bits < size) bits += 1;
  for (let index = 0; index < size; index += 1) {
    let value = index;
    let reversed = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    reverse[index] = reversed;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let index = 0; index < size / 2; index += 1) {
    cos[index] = Math.cos((Math.PI * 2 * index) / size);
    sin[index] = Math.sin((Math.PI * 2 * index) / size);
  }
  return { size, reverse, cos, sin };
}

function fft(real: Float64Array, imaginary: Float64Array, inverse: boolean, tables: FftTables): void {
  const size = tables.size;
  for (let index = 0; index < size; index += 1) {
    const reversed = tables.reverse[index];
    if (reversed <= index) continue;
    const realValue = real[index];
    const imaginaryValue = imaginary[index];
    real[index] = real[reversed];
    imaginary[index] = imaginary[reversed];
    real[reversed] = realValue;
    imaginary[reversed] = imaginaryValue;
  }

  for (let length = 2; length <= size; length <<= 1) {
    const half = length >> 1;
    const step = size / length;
    for (let start = 0; start < size; start += length) {
      for (let index = 0; index < half; index += 1) {
        const tableIndex = index * step;
        const cosine = tables.cos[tableIndex];
        const sine = inverse ? tables.sin[tableIndex] : -tables.sin[tableIndex];
        const even = start + index;
        const odd = even + half;
        const oddReal = real[odd] * cosine - imaginary[odd] * sine;
        const oddImaginary = real[odd] * sine + imaginary[odd] * cosine;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
      }
    }
  }

  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      real[index] /= size;
      imaginary[index] /= size;
    }
  }
}

function principalPhase(value: number): number {
  const turn = Math.PI * 2;
  return value - turn * Math.round(value / turn);
}

export function timeStretch(channels: Float32Array[], sampleRate: number, speed: number): Float32Array[] {
  const safeSpeed = clamp(speed, 0.5, 2);
  if (Math.abs(safeSpeed - 1) < 0.0001) return channels.map((channel) => channel.slice());
  const sampleCount = Math.min(...channels.map((channel) => channel.length));
  if (sampleCount < 64) return channels.map((channel) => channel.slice());

  const frameSize = 2048;
  const analysisHop = frameSize / 4;
  const synthesisHop = Math.max(1, Math.round(analysisHop / safeSpeed));
  const outputLength = Math.max(1, Math.round(sampleCount / safeSpeed));
  const outputChannels = channels.map(() => new Float32Array(outputLength));
  const normalization = new Float32Array(outputLength + frameSize);
  const window = new Float32Array(frameSize);
  for (let index = 0; index < frameSize; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((Math.PI * 2 * index) / frameSize);
  }

  const tables = fftTables(frameSize);
  const real = new Float64Array(frameSize);
  const imaginary = new Float64Array(frameSize);
  const previousPhase = channels.map(() => new Float64Array(frameSize / 2 + 1));
  const synthesisPhase = channels.map(() => new Float64Array(frameSize / 2 + 1));
  const frequencyBins = new Float64Array(frameSize / 2 + 1);
  for (let bin = 0; bin <= frameSize / 2; bin += 1) {
    frequencyBins[bin] = (Math.PI * 2 * bin) / frameSize;
  }

  const frameCount = Math.ceil(sampleCount / analysisHop);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const inputStart = frame * analysisHop;
    const outputStart = frame * synthesisHop;
    if (outputStart >= outputLength) break;
    for (let index = 0; index < frameSize; index += 1) {
      const sampleIndex = inputStart + index;
      const sample = sampleIndex < sampleCount ? channels[0][sampleIndex] : 0;
      real[index] = sample * window[index];
      imaginary[index] = 0;
    }
    for (let index = 0; index < frameSize; index += 1) {
      normalization[outputStart + index] += window[index] * window[index];
    }

    for (let channel = 0; channel < channels.length; channel += 1) {
      for (let index = 0; index < frameSize; index += 1) {
        const sampleIndex = inputStart + index;
        real[index] = (sampleIndex < sampleCount ? channels[channel][sampleIndex] : 0) * window[index];
        imaginary[index] = 0;
      }
      fft(real, imaginary, false, tables);
      for (let bin = 1; bin < frameSize / 2; bin += 1) {
        const originalReal = real[bin];
        const originalImaginary = imaginary[bin];
        const magnitude = Math.hypot(originalReal, originalImaginary);
        const phase = Math.atan2(originalImaginary, originalReal);
        if (frame === 0) {
          previousPhase[channel][bin] = phase;
          synthesisPhase[channel][bin] = phase;
        } else {
          const expected = frequencyBins[bin] * analysisHop;
          const deviation = principalPhase(phase - previousPhase[channel][bin] - expected);
          const trueFrequency = frequencyBins[bin] + deviation / analysisHop;
          previousPhase[channel][bin] = phase;
          synthesisPhase[channel][bin] += trueFrequency * synthesisHop;
        }
        const outputPhase = synthesisPhase[channel][bin];
        real[bin] = Math.cos(outputPhase) * magnitude;
        imaginary[bin] = Math.sin(outputPhase) * magnitude;
        real[frameSize - bin] = real[bin];
        imaginary[frameSize - bin] = -imaginary[bin];
      }
      fft(real, imaginary, true, tables);
      const output = outputChannels[channel];
      const limit = Math.min(frameSize, outputLength - outputStart, normalization.length - outputStart);
      for (let index = 0; index < limit; index += 1) {
        output[outputStart + index] += real[index] * window[index];
      }
    }
  }

  for (let channel = 0; channel < outputChannels.length; channel += 1) {
    const output = outputChannels[channel];
    for (let index = 0; index < outputLength; index += 1) {
      const weight = normalization[index];
      if (weight > 0.01) output[index] /= weight;
    }
  }

  const fade = Math.min(64, Math.round(sampleRate * 0.003), outputLength);
  for (const output of outputChannels) {
    for (let index = 0; index < fade; index += 1) {
      const gain = index / Math.max(1, fade - 1);
      output[index] *= gain;
      output[outputLength - 1 - index] *= gain;
    }
  }
  return outputChannels;
}

export function renderProject(source: AudioSource, options: RenderOptions): RenderResult {
  const safeSpeed = clamp(options.speed, 0.5, 2);
  const spliced = splicePauses(source, { ...options, speed: safeSpeed });
  const channels = timeStretch(spliced.channels, source.sampleRate, safeSpeed);
  const duration = channels[0].length / source.sampleRate;
  let removedSeconds = 0;
  for (const item of spliced.timeline) {
    if (item.segment.state !== "active") continue;
    const target = Math.min(item.segment.duration, item.segment.targetMs / 1000);
    removedSeconds += Math.max(0, item.segment.duration - target);
  }

  return {
    channels,
    sampleRate: source.sampleRate,
    duration,
    timeline: spliced.timeline.map((item) => ({
      ...item,
      outputStart: item.outputStart / safeSpeed,
      outputEnd: item.outputEnd / safeSpeed,
    })),
    removedSeconds,
  };
}
