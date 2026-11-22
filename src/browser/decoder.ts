import type { AudioTrack } from "../shared/types.ts";
import { decodeWav } from "../shared/wav.ts";

type AudioDecoderCtor = typeof AudioDecoder;

export async function decodeFile(file: File): Promise<AudioTrack> {
  const buffer = await file.arrayBuffer();
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".wav")) return decodeWav(buffer, file.name);
  if ("AudioDecoder" in globalThis && lower.endsWith(".mp3")) {
    try {
      return await decodeMp3(buffer, file.name);
    } catch (error) {
      console.warn("WebCodecs MP3 failed, falling back to decodeAudioData", error);
    }
  }
  if ("AudioDecoder" in globalThis && /\.(m4a|aac|mp4)$/.test(lower)) {
    try {
      return await decodeMp4(buffer, file.name);
    } catch (error) {
      console.warn("WebCodecs MP4 failed, falling back to decodeAudioData", error);
    }
  }
  return decodeWithWebAudio(buffer, file.name);
}

async function decodeWithWebAudio(buffer: ArrayBuffer, name: string): Promise<AudioTrack> {
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctx();
  try {
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, ch) => audioBuffer.getChannelData(ch).slice());
    return { name, sampleRate: audioBuffer.sampleRate, channels, duration: audioBuffer.duration };
  } finally {
    void context.close();
  }
}

const MP3_RATES: Record<string, number[]> = {
  "3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  "2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  "1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
};
const MP3_SAMPLE_RATES = [44100, 48000, 32000, 0];

async function decodeMp3(buffer: ArrayBuffer, name: string): Promise<AudioTrack> {
  const bytes = new Uint8Array(buffer);
  let offset = findSync(bytes);
  const chunks: EncodedAudioChunk[] = [];
  let sampleRate = 0;
  let samplesPerFrame = 1152;
  while (offset + 4 < bytes.length) {
    const header = (bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const id = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3;
    const bitIndex = (header >>> 12) & 15;
    const rateIndex = (header >>> 10) & 3;
    const padding = (header >>> 9) & 1;
    if (id === 1 || layer !== 1 || rateIndex === 3) break;
    const versionKey = id === 3 ? "3" : id === 2 ? "2" : "1";
    const bitrate = MP3_RATES[versionKey]![bitIndex]! * 1000;
    sampleRate = MP3_SAMPLE_RATES[rateIndex]! / (id === 2 ? 2 : 1);
    if (!bitrate || !sampleRate) break;
    samplesPerFrame = id === 3 ? 1152 : 576;
    const frameLength = Math.floor(
      id === 3
        ? (144 * bitrate) / sampleRate + padding
        : (72 * bitrate) / sampleRate + padding,
    );
    if (frameLength <= 4 || offset + frameLength > bytes.length) break;
    chunks.push(new EncodedAudioChunk({
      type: "key",
      timestamp: Math.round((chunks.length * samplesPerFrame * 1000000) / sampleRate),
      data: bytes.slice(offset, offset + frameLength),
    }));
    offset += frameLength;
  }
  if (!chunks.length) throw new Error("no MP3 frames found");
  const output = await runAudioDecoder({ codec: "mp3", sampleRate, numberOfChannels: 2 }, chunks);
  return toTrack(name, output, sampleRate);
}

function findSync(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0) return i;
  }
  throw new Error("MP3 sync word not found");
}

interface DecoderSupport {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: BufferSource;
}

function runAudioDecoder(config: DecoderSupport, chunks: EncodedAudioChunk[]): Promise<AudioData[]> {
  const Ctor = (globalThis as unknown as { AudioDecoder: AudioDecoderCtor }).AudioDecoder;
  return new Promise((resolve, reject) => {
    const outputs: AudioData[] = [];
    const decoder = new Ctor({
      output: (data) => outputs.push(data),
      error: (err) => reject(err),
    });
    decoder.configure(config as AudioDecoderConfig);
    for (const chunk of chunks) decoder.decode(chunk);
    void decoder.flush().then(() => {
      decoder.close();
      resolve(outputs);
    }).catch(reject);
  });
}

function toTrack(name: string, frames: AudioData[], fallbackRate: number): AudioTrack {
  if (!frames.length) throw new Error("decoder produced no audio frames");
  const sampleRate = frames[0]!.sampleRate || fallbackRate;
  const channelCount = frames[0]!.numberOfChannels;
  const totalFrames = frames.reduce((sum, frame) => sum + frame.numberOfFrames, 0);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(totalFrames));
  let position = 0;
  for (const frame of frames) {
    const count = frame.numberOfFrames;
    const planar = Array.from({ length: channelCount }, () => new Float32Array(count));
    frame.convertToFloat32Planar(planar);
    for (let ch = 0; ch < channelCount; ch++) {
      channels[ch]!.set(planar[ch]!, position);
    }
    position += count;
    frame.close();
  }
  return { name, sampleRate, channels, duration: totalFrames / sampleRate };
}

async function decodeMp4(buffer: ArrayBuffer, name: string): Promise<AudioTrack> {
  const view = new DataView(buffer);
  const { sampleRate, channels, chunks, description } = parseMp4(new Uint8Array(buffer), view);
  const output = await runAudioDecoder({
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels: channels,
    description,
  }, chunks);
  return toTrack(name, output, sampleRate);
}

function parseMp4(bytes: Uint8Array, view: DataView): { sampleRate: number; channels: number; chunks: EncodedAudioChunk[]; description: Uint8Array } {
  const root = findBoxes(view, 0, view.byteLength);
  const moov = root.find((b) => b.type === "moov");
  if (!moov) throw new Error("moov box missing");
  const stbl = findDeep(view, moov, ["trak", "mdia", "minf", "stbl"]);
  if (!stbl) throw new Error("stbl box missing");
  const stsd = findBoxes(view, stbl.start, stbl.end).find((b) => b.type === "stsd");
  if (!stsd) throw new Error("stsd box missing");
  const entryStart = stsd.start + 8;
  const sampleRate = view.getUint16(entryStart + 16 + 8, false);
  const channels = view.getUint16(entryStart + 16 + 16, false);
  const esds = findBoxes(view, entryStart, stsd.end).find((b) => b.type === "esds");
  if (!esds) throw new Error("esds box missing");
  const description = extractAudioSpecificConfig(bytes, esds);
  const mdat = findBoxes(view, 0, view.byteLength).find((b) => b.type === "mdat");
  if (!mdat) throw new Error("mdat box missing");
  const stsz = findBoxes(view, stbl.start, stbl.end).find((b) => b.type === "stsz")!;
  const entryCount = view.getUint32(stsz.start + 8, false);
  const chunks: EncodedAudioChunk[] = [];
  const stts = findBoxes(view, stbl.start, stbl.end).find((b) => b.type === "stts");
  const frameDuration = stts ? view.getUint32(stts.start + 12, false) : 1024;
  let offset = mdat.start;
  let timestamp = 0;
  for (let i = 0; i < entryCount; i++) {
    const size = view.getUint32(stsz.start + 12 + i * 4, false);
    chunks.push(new EncodedAudioChunk({
      type: "key",
      timestamp,
      data: new Uint8Array(view.buffer, view.byteOffset + offset, size),
    }));
    timestamp += Math.round((frameDuration * 1000000) / sampleRate);
    offset += size;
  }
  return { sampleRate, channels, chunks, description };
}

function extractAudioSpecificConfig(bytes: Uint8Array, esds: Box): Uint8Array {
  let index = esds.start;
  const end = esds.end;
  while (index + 8 <= end) {
    const tag = bytes[index]! & 0x7f;
    let size = 0;
    let cursor = index + 1;
    let next = bytes[cursor]!;
    while (next & 0x80) {
      size = (size << 7) | (next & 0x7f);
      next = bytes[++cursor]!;
    }
    size = (size << 7) | (next & 0x7f);
    cursor++;
    if (tag === 5) return bytes.slice(cursor + 3, cursor + 5);
    index = cursor + size;
  }
  throw new Error("AudioSpecificConfig not found in esds");
}

interface Box {
  type: string;
  start: number;
  end: number;
}

function findBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false);
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
    const boxEnd = size === 1 ? Number(view.getBigUint64(offset + 8, false)) : offset + size;
    if (!size || boxEnd > end) break;
    boxes.push({ type, start: offset + 8, end: boxEnd });
    offset = boxEnd;
  }
  return boxes;
}

function findDeep(view: DataView, root: Box, path: string[]): Box | null {
  let current: Box = root;
  for (const type of path) {
    const next = findBoxes(view, current.start, current.end).find((b) => b.type === type);
    if (!next) return null;
    current = next;
  }
  return current;
}
