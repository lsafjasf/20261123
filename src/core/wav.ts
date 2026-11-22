import type { PcmBuffer } from './types.ts';

/** Minimal RIFF/WAVE reader limited to uncompressed PCM and IEEE float. */
export interface WavInfo {
  sampleRate: number;
  channelCount: number;
  bitsPerSample: number;
  audioFormat: number; // 1 = PCM, 3 = IEEE float
  pcm: PcmBuffer;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

function decodePcm(
  view: DataView,
  dataOffset: number,
  frameCount: number,
  channelCount: number,
  bitsPerSample: number,
  audioFormat: number,
  sampleRate: number,
): WavInfo {
  const channels: Float32Array[] = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  const bytesPerSample = bitsPerSample / 8;

  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const byteIndex = dataOffset + (frame * channelCount + ch) * bytesPerSample;
      let value: number;
      if (audioFormat === 3) {
        if (bitsPerSample === 32) value = view.getFloat32(byteIndex, true);
        else if (bitsPerSample === 64) value = view.getFloat64(byteIndex, true);
        else throw new Error(`Unsupported float bit depth: ${bitsPerSample}`);
      } else if (audioFormat === 1) {
        if (bitsPerSample === 16) value = view.getInt16(byteIndex, true) / 32768;
        else if (bitsPerSample === 8) value = (view.getUint8(byteIndex) - 128) / 128;
        else if (bitsPerSample === 32) value = view.getInt32(byteIndex, true) / 2147483648;
        else if (bitsPerSample === 24) {
          const b0 = view.getUint8(byteIndex);
          const b1 = view.getUint8(byteIndex + 1);
          const b2 = view.getUint8(byteIndex + 2);
          let int24 = b0 | (b1 << 8) | (b2 << 16);
          if (int24 & 0x800000) int24 |= -16777216; // sign extend
          value = int24 / 8388608;
        } else {
          throw new Error(`Unsupported PCM bit depth: ${bitsPerSample}`);
        }
      } else {
        throw new Error(`Unsupported WAVE audio format tag: ${audioFormat}`);
      }
      channels[ch][frame] = value;
    }
  }

  return {
    sampleRate,
    channelCount,
    bitsPerSample,
    audioFormat,
    pcm: { sampleRate, channels },
  };
}

/** Parse a WAV file from an ArrayBuffer. Throws on unsupported containers. */
export function parseWav(buffer: ArrayBuffer): WavInfo {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }

  let offset = 12;
  let sampleRate = 0;
  let channelCount = 0;
  let bitsPerSample = 0;
  let audioFormat = 1;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= bytes.length) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2); // RIFF pads odd chunks
    if (dataOffset >= 0 && sampleRate > 0 && id !== 'data') break;
  }

  if (dataOffset < 0) throw new Error('WAVE file has no data chunk');
  if (!sampleRate || !channelCount) throw new Error('WAVE file has incomplete fmt chunk');

  const frameCount = Math.floor(dataLength / (channelCount * (bitsPerSample / 8)));
  return decodePcm(view, dataOffset, frameCount, channelCount, bitsPerSample, audioFormat, sampleRate);
}

/** Serialize a PCM buffer to a 16-bit PCM WAV ArrayBuffer. */
export function encodeWav16(pcm: PcmBuffer): ArrayBuffer {
  const { sampleRate, channels } = pcm;
  const channelCount = channels.length;
  const frameCount = channels[0].length;
  const dataLength = frameCount * channelCount * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (off: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(off + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  let p = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const clamped = Math.max(-1, Math.min(1, channels[ch][frame]));
      view.setInt16(p, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
      p += 2;
    }
  }
  return buffer;
}
