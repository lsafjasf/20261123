// Minimal WAV (PCM16 / float32) codec using typed arrays only.

export interface WavData {
  samples: Float32Array; // mono (first channel if stereo)
  sampleRate: number;
  channels: number;
}

export function decodeWav(buf: ArrayBuffer): WavData {
  const dv = new DataView(buf);
  const tag = (o: number): string =>
    String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let pos = 12;
  let fmt = { audioFormat: 0, channels: 1, sampleRate: 0, bits: 16 };
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") {
      fmt = {
        audioFormat: dv.getUint16(pos + 8, true),
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        bits: dv.getUint16(pos + 22, true),
      };
    } else if (id === "data") {
      dataOff = pos + 8;
      dataLen = size;
    }
    pos += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error("WAV: no data chunk");
  const frames = Math.floor(dataLen / (fmt.channels * (fmt.bits / 8)));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = dataOff + i * fmt.channels * (fmt.bits / 8);
    if (fmt.audioFormat === 3 && fmt.bits === 32) {
      out[i] = dv.getFloat32(o, true);
    } else if (fmt.audioFormat === 1 && fmt.bits === 16) {
      out[i] = dv.getInt16(o, true) / 32768;
    } else if (fmt.audioFormat === 1 && fmt.bits === 24) {
      const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v |= ~0xffffff;
      out[i] = v / 8388608;
    } else {
      throw new Error(`WAV: unsupported format ${fmt.audioFormat}/${fmt.bits}`);
    }
  }
  return { samples: out, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const wstr = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return buf;
}
