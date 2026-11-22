import type { AudioSource } from "./types.ts";

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function clampSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function decodeWav(buffer: ArrayBuffer, fileName: string, isDemo = false): AudioSource {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44 || readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE") {
    throw new Error("这不是有效的 RIFF/WAVE 文件。");
  }

  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let cursor = 12;

  while (cursor + 8 <= buffer.byteLength) {
    const id = readTag(view, cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (id === "fmt ") {
      fmtOffset = body;
      fmtSize = size;
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, buffer.byteLength - body);
    }
    cursor = body + size + (size % 2);
  }

  if (fmtOffset < 0 || dataOffset < 0 || fmtSize < 16) {
    throw new Error("WAV 缺少 fmt 或 data 区块。");
  }

  let formatTag = view.getUint16(fmtOffset, true);
  const channelCount = view.getUint16(fmtOffset + 2, true);
  const sampleRate = view.getUint32(fmtOffset + 4, true);
  const blockAlign = view.getUint16(fmtOffset + 12, true);
  const bitsPerSample = view.getUint16(fmtOffset + 14, true);

  if (formatTag === FORMAT_EXTENSIBLE && fmtSize >= 40) {
    formatTag = view.getUint16(fmtOffset + 24, true);
  }
  if (formatTag !== FORMAT_PCM && formatTag !== FORMAT_FLOAT) {
    throw new Error(`暂不支持此 WAV 编码（format ${formatTag}）。`);
  }
  if (channelCount < 1 || channelCount > 2) {
    throw new Error(`只支持单声道或两轨 WAV，当前为 ${channelCount} 轨。`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new Error("WAV 采样率无效。");
  }
  if (blockAlign <= 0) {
    throw new Error("WAV 数据块对齐参数无效。");
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / blockAlign);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  const littleEndian = true;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = dataOffset + frame * blockAlign;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const offset = frameOffset + channel * bytesPerSample;
      let sample = 0;
      if (formatTag === FORMAT_FLOAT) {
        if (bitsPerSample === 32) sample = view.getFloat32(offset, littleEndian);
        else if (bitsPerSample === 64) sample = view.getFloat64(offset, littleEndian);
        else throw new Error(`不支持 ${bitsPerSample}-bit 浮点 WAV。`);
      } else if (bitsPerSample === 8) {
        sample = (view.getUint8(offset) - 128) / 128;
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(offset, littleEndian) / 32768;
      } else if (bitsPerSample === 24) {
        const lo = view.getUint8(offset);
        const mid = view.getUint8(offset + 1);
        const hi = view.getUint8(offset + 2);
        let value = lo | (mid << 8) | (hi << 16);
        if (value & 0x800000) value |= ~0xffffff;
        sample = value / 8388608;
      } else if (bitsPerSample === 32) {
        sample = view.getInt32(offset, littleEndian) / 2147483648;
      } else {
        throw new Error(`不支持 ${bitsPerSample}-bit PCM WAV。`);
      }
      channels[channel][frame] = clampSample(sample);
    }
  }

  return {
    name: fileName,
    sampleRate,
    channels,
    bitDepth: bitsPerSample,
    format: formatTag === FORMAT_FLOAT ? "float" : isDemo ? "demo" : "pcm",
    originalBytes: buffer.byteLength,
    isDemo,
  };
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function encodeWav24(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (channels.length < 1 || channels.length > 2) {
    throw new Error("导出仅支持单声道或双声道。");
  }
  const frameCount = channels.reduce((shortest, channel) => Math.min(shortest, channel.length), Infinity);
  const channelCount = channels.length;
  const bytesPerSample = 3;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = clampSample(channels[channel][frame]);
      const scaled = Math.round(sample < 0 ? sample * 8388608 : sample * 8388607);
      view.setUint8(offset, scaled & 0xff);
      view.setUint8(offset + 1, (scaled >> 8) & 0xff);
      view.setUint8(offset + 2, (scaled >> 16) & 0xff);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const outputLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

export function pairTracks(sources: AudioSource[], name: string): AudioSource {
  if (sources.length === 1) {
    return { ...sources[0], name, isDemo: false };
  }
  if (sources.length !== 2) {
    throw new Error("请拖入一个两轨 WAV，或恰好两个单轨 WAV。");
  }
  if (sources[0].channels.length !== 1 || sources[1].channels.length !== 1) {
    throw new Error("配对两个文件时，两份都必须是单声道 WAV。");
  }

  const sampleRate = sources[0].sampleRate;
  const left = sources[0].channels[0];
  const right = resampleLinear(sources[1].channels[0], sources[1].sampleRate, sampleRate);
  const frameCount = Math.max(left.length, right.length);
  const channelA = new Float32Array(frameCount);
  const channelB = new Float32Array(frameCount);
  channelA.set(left);
  channelB.set(right);

  return {
    name,
    sampleRate,
    channels: [channelA, channelB],
    bitDepth: Math.min(sources[0].bitDepth, sources[1].bitDepth),
    format: "pcm",
    originalBytes: sources.reduce((sum, source) => sum + source.originalBytes, 0),
    isDemo: false,
  };
}
