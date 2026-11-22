import type { AudioTrack } from "./types.ts";

interface RiffChunk {
  id: string;
  offset: number;
  size: number;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

function findChunks(view: DataView): { fmt: RiffChunk; data: RiffChunk } {
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  let fmt: RiffChunk | null = null;
  let data: RiffChunk | null = null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") fmt = { id, offset: body, size };
    if (id === "data") data = { id, offset: body, size };
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAVE file missing fmt/data chunks");
  return { fmt, data };
}

export function decodeWav(buffer: ArrayBuffer, name = "track.wav"): AudioTrack {
  const view = new DataView(buffer);
  const { fmt, data } = findChunks(view);
  const audioFormat = view.getUint16(fmt.offset, true);
  const channelCount = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const bitsPerSample = view.getUint16(fmt.offset + 14, true);
  const extFormat = fmt.size >= 18 ? view.getUint16(fmt.offset + 16, true) : audioFormat;
  const isFloat = audioFormat === 3 || (audioFormat === 65534 && extFormat === 3);
  const isPcm = audioFormat === 1 || (audioFormat === 65534 && extFormat === 1);
  if (!isFloat && !isPcm) throw new Error(`Unsupported WAVE format tag: ${audioFormat}`);
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(data.size / (bytesPerSample * channelCount));
  const channels: Float32Array[] = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const pos = data.offset + (frame * channelCount + ch) * bytesPerSample;
      let sample = 0;
      if (isFloat && bitsPerSample === 32) sample = view.getFloat32(pos, true);
      else if (isFloat && bitsPerSample === 64) sample = view.getFloat64(pos, true);
      else if (bitsPerSample === 16) sample = view.getInt16(pos, true) / 32768;
      else if (bitsPerSample === 24) {
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getInt8(pos + 2);
        sample = (b2 * 65536 + b1 * 256 + b0) / 8388608;
      } else if (bitsPerSample === 8) sample = (view.getUint8(pos) - 128) / 128;
      else if (bitsPerSample === 32) sample = view.getInt32(pos, true) / 2147483648;
      else throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
      channels[ch]![frame] = sample;
    }
  }
  return { name, sampleRate, channels, duration: frameCount / sampleRate };
}

export function encodeWavPcm16(track: AudioTrack): ArrayBuffer {
  const frameCount = track.channels[0]!.length;
  const channelCount = track.channels.length;
  const dataSize = frameCount * channelCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, track.sampleRate, true);
  view.setUint32(28, track.sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  let pos = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const v = Math.max(-1, Math.min(1, track.channels[ch]![frame]!));
      view.setInt16(pos, v < 0 ? v * 32768 : v * 32767, true);
      pos += 2;
    }
  }
  return buffer;
}

export function mixToMono(track: AudioTrack): Float32Array {
  if (track.channels.length === 1) return track.channels[0]!;
  const first = track.channels[0]!;
  const mono = new Float32Array(first.length);
  const gain = 1 / track.channels.length;
  for (const channel of track.channels) {
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i]! * gain;
  }
  return mono;
}
