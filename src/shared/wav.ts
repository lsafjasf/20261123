// Minimal WAV (PCM 16-bit / float32) encode + decode. No dependencies.

export function encodeWavPcm16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = channels.length;
  const n = channels[0]?.length ?? 0;
  const dataBytes = n * numCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * 2, true);
  v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < numCh; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(off, Math.round(x * 32767), true);
      off += 2;
    }
  }
  return buf;
}

export interface DecodedWav {
  channels: Float32Array[];
  sampleRate: number;
}

export function decodeWav(buf: ArrayBuffer): DecodedWav {
  const v = new DataView(buf);
  if (readAscii(v, 0, 4) !== "RIFF" || readAscii(v, 8, 4) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= v.byteLength) {
    const id = readAscii(v, off, 4);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        format: v.getUint16(off + 8, true),
        channels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        bits: v.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(size, v.byteLength - dataOff);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error("malformed WAV");
  const { format, channels: numCh, sampleRate, bits } = fmt;
  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * numCh));
  const out = Array.from({ length: numCh }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const p = dataOff + (i * numCh + c) * bytesPerSample;
      let x: number;
      if (format === 1 && bits === 16) x = v.getInt16(p, true) / 32768;
      else if (format === 1 && bits === 8) x = (v.getUint8(p) - 128) / 128;
      else if (format === 3 && bits === 32) x = v.getFloat32(p, true);
      else if (format === 1 && bits === 24) {
        const b0 = v.getUint8(p);
        const b1 = v.getUint8(p + 1);
        const b2 = v.getUint8(p + 2);
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val -= 0x1000000;
        x = val / 8388608;
      } else {
        throw new Error(`unsupported WAV format ${format}/${bits}`);
      }
      out[c][i] = x;
    }
  }
  return { channels: out, sampleRate };
}

function writeAscii(v: DataView, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
}

function readAscii(v: DataView, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(off + i));
  return s;
}
