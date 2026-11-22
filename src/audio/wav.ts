/**
 * 零依赖 WAV(PCM16) 编码器，demo 生成器与测试夹具共用。
 */

export interface WavInput {
  channels: Float32Array[];
  sampleRate: number;
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav({ channels, sampleRate }: WavInput): Uint8Array {
  const channelCount = channels.length;
  const frames = Math.max(...channels.map((c) => c.length));
  const dataBytes = frames * channelCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const sample = channels[ch][i] ?? 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** 立体声 PCM 混音工具。 */
export function mixInto(
  target: Float32Array,
  source: Float32Array,
  startSample: number,
  gain: number,
): void {
  for (let i = 0; i < source.length && startSample + i < target.length; i++) {
    target[startSample + i] += source[i] * gain;
  }
}
