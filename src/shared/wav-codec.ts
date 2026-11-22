import type { AudioBufferData } from './types.ts';

const readAscii = (view: DataView, offset: number, length: number): string => {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
};

const findChunk = (
  view: DataView,
  id: string,
  start: number,
  end: number,
): { offset: number; size: number } | null => {
  let offset = start;
  while (offset + 8 <= end) {
    const chunkId = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (chunkId === id) return { offset: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  return null;
};

// Parses PCM WAV (8/16/24/32-bit integer) plus 32-bit float WAV. Other
// compressed formats are rejected and the browser fallback handles them.
export const decodeWav = (bytes: Uint8Array, label: string): AudioBufferData => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  const fmt = findChunk(view, 'fmt ', 12, bytes.byteLength);
  const data = findChunk(view, 'data', 12, bytes.byteLength);
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  const formatTag = view.getUint16(fmt.offset, true);
  const channelCount = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const bitsPerSample = view.getUint16(fmt.offset + 14, true);
  const isFloat = formatTag === 3;
  if (!isFloat && formatTag !== 1) {
    throw new Error(`暂不支持的 WAV 格式标签 ${formatTag}（仅 PCM/float）`);
  }
  const validBitDepths = isFloat ? [32] : [8, 16, 24, 32];
  if (!validBitDepths.includes(bitsPerSample)) {
    throw new Error(`暂不支持 ${bitsPerSample} 位 WAV`);
  }
  const frameBytes = (bitsPerSample / 8) * channelCount;
  const frameCount = Math.floor(data.size / frameBytes);
  const channels: Float32Array[] = Array.from(
    { length: channelCount },
    () => new Float32Array(frameCount),
  );
  const base = data.offset;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sampleOffset = base + (frame * channelCount + channel) * (bitsPerSample / 8);
      let value = 0;
      if (isFloat) {
        value = view.getFloat32(sampleOffset, true);
      } else if (bitsPerSample === 8) {
        value = (view.getUint8(sampleOffset) - 128) / 128;
      } else if (bitsPerSample === 16) {
        value = view.getInt16(sampleOffset, true) / 32768;
      } else if (bitsPerSample === 24) {
        const int =
          view.getUint8(sampleOffset) |
          (view.getUint8(sampleOffset + 1) << 8) |
          (view.getUint8(sampleOffset + 2) << 16);
        value = (int > 0x7fffff ? int - 0x1000000 : int) / 8388608;
      } else {
        value = view.getInt32(sampleOffset, true) / 2147483648;
      }
      channels[channel][frame] = value;
    }
  }
  return { sampleRate, channels, label };
};

// Encodes a mono Float32 signal as 16-bit PCM WAV for offline report export.
export const encodeWav16 = (
  signal: Float32Array,
  sampleRate: number,
): Uint8Array => {
  const dataSize = signal.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < signal.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, signal[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
};
