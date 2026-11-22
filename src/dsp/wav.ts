// 纯 TypeScript WAV(RIFF) 编解码：解码 8/16/24/32 位整型与 32 位浮点 PCM，
// 编码 16 位 PCM。浏览器与 Node 通用（Node 侧用于回归测试落盘/读回）。

export interface WavData {
  sampleRate: number;
  channels: Float32Array[];
}

export function decodeWav(buf: ArrayBuffer): WavData {
  const view = new DataView(buf);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error("不是有效的 RIFF/WAVE 文件");
  }
  let offset = 12;
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0 || numChannels === 0) throw new Error("WAV 缺少 fmt/data 块");
  if (format !== 1 && format !== 3) throw new Error(`不支持的 WAV 编码格式: ${format}`);

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * numChannels));
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  let pos = dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let v: number;
      if (format === 3 && bitsPerSample === 32) {
        v = view.getFloat32(pos, true);
      } else if (bitsPerSample === 16) {
        v = view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getUint8(pos + 2);
        let s = (b2 << 16) | (b1 << 8) | b0;
        if (s & 0x800000) s -= 0x1000000;
        v = s / 8388608;
      } else if (bitsPerSample === 32) {
        v = view.getInt32(pos, true) / 2147483648;
      } else if (bitsPerSample === 8) {
        v = (view.getUint8(pos) - 128) / 128;
      } else {
        throw new Error(`不支持的位深: ${bitsPerSample}`);
      }
      channels[c][i] = v;
      pos += bytesPerSample;
    }
  }
  return { sampleRate, channels };
}

export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = channels.length;
  const frames = channels[0].length;
  const dataSize = frames * numChannels * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let pos = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(pos, Math.round(v * 32767), true);
      pos += 2;
    }
  }
  return buf;
}
