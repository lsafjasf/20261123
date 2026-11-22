// 解码编排：本地文件 -> 16kHz 单声道 PCM 流。
// WAV 直接解析 PCM；MP3/M4A 走 WebCodecs AudioDecoder；
// 其他格式（且体积可控）回退 WebAudio decodeAudioData。
import { StreamingResampler } from './dsp.js';
import { ANALYSIS_RATE } from './features.js';
import { parseWav, mp3Frames, parseMp4 } from './demux.js';

export interface DecodeSink {
  onPcm(chunk: Float32Array): void;
  onProgress(doneSec: number, totalSec: number): void;
}

export interface DecodeResult { durationSec: number }

// AudioData -> 单声道 Float32（处理 planar/interleaved 与常见位深）
function audioDataToMono(data: AudioData): Float32Array {
  const frames = data.numberOfFrames;
  const ch = data.numberOfChannels;
  const planar = data.format.includes('planar');
  const out = new Float32Array(frames);
  const readPlane = (idx: number): Float32Array => {
    const size = data.allocationSize({ planeIndex: idx });
    const buf = new ArrayBuffer(size);
    data.copyTo(buf, { planeIndex: idx });
    const f = data.format;
    if (f.startsWith('f32')) return new Float32Array(buf);
    if (f.startsWith('s16')) {
      const s = new Int16Array(buf);
      const o = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) o[i] = s[i] / 32768;
      return o;
    }
    if (f.startsWith('u8')) {
      const s = new Uint8Array(buf);
      const o = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) o[i] = (s[i] - 128) / 128;
      return o;
    }
    const s = new Int32Array(buf);
    const o = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) o[i] = s[i] / 2147483648;
    return o;
  };
  if (planar) {
    for (let c = 0; c < ch; c++) {
      const p = readPlane(c);
      for (let i = 0; i < frames; i++) out[i] += p[i] / ch;
    }
  } else {
    const p = readPlane(0);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += p[i * ch + c];
      out[i] = s / ch;
    }
  }
  return out;
}

async function decodeWithWebCodecs(
  chunks: AsyncIterable<{ data: Uint8Array; timestampUs: number }>,
  config: AudioDecoderConfig,
  sink: DecodeSink,
  totalSec: number,
): Promise<void> {
  const resampler = new StreamingResampler(config.sampleRate, ANALYSIS_RATE);
  const decoder = new AudioDecoder({
    output: (data) => {
      const mono = audioDataToMono(data);
      data.close();
      sink.onPcm(resampler.push(mono));
    },
    error: (e) => { throw e; },
  });
  decoder.configure(config);
  for await (const c of chunks) {
    decoder.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: c.timestampUs,
      data: c.data,
    }));
    sink.onProgress(c.timestampUs / 1e6, totalSec);
    // 避免队列无限堆积
    while (decoder.decodeQueueSize > 32) {
      await new Promise(r => setTimeout(r, 5));
    }
  }
  await decoder.flush();
  decoder.close();
}

async function decodeWav(file: File, sink: DecodeSink): Promise<DecodeResult> {
  const info = await parseWav(file);
  const bytesPerSample = info.bitsPerSample / 8;
  const frameBytes = bytesPerSample * info.channels;
  const totalSec = info.dataSize / frameBytes / info.sampleRate;
  const resampler = new StreamingResampler(info.sampleRate, ANALYSIS_RATE);
  const STEP = 4 * 1024 * 1024;
  let offset = info.dataOffset;
  const end = info.dataOffset + info.dataSize;
  while (offset < end) {
    const size = Math.min(STEP, end - offset);
    const buf = await file.slice(offset, offset + size).arrayBuffer();
    const frames = Math.floor(size / frameBytes);
    const mono = new Float32Array(frames);
    const dv = new DataView(buf);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < info.channels; c++) {
        const p = (i * info.channels + c) * bytesPerSample;
        if (info.floatFormat) s += dv.getFloat32(p, true);
        else if (info.bitsPerSample === 16) s += dv.getInt16(p, true) / 32768;
        else if (info.bitsPerSample === 24) {
          const v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
          s += ((v << 8) >> 8) / 8388608;
        } else if (info.bitsPerSample === 32) s += dv.getInt32(p, true) / 2147483648;
      }
      mono[i] = s / info.channels;
    }
    sink.onPcm(resampler.push(mono));
    offset += frames * frameBytes;
    sink.onProgress(offset / frameBytes / info.sampleRate, totalSec);
    await new Promise(r => setTimeout(r, 0)); // 让出主线程
  }
  return { durationSec: totalSec };
}

async function decodeMp3(file: File, sink: DecodeSink): Promise<DecodeResult> {
  const gen = mp3Frames(file);
  const first = await gen.next();
  if (first.done) throw new Error('MP3 中未找到有效帧');
  const info = first.value.info;
  const totalSec = (file.size / (info.sampleRate * 1000)) * 8; // 粗略估计
  const iter = (async function* () {
    let ts = 0;
    yield { data: first.value.data, timestampUs: 0 };
    for await (const b of gen) {
      ts += (b.data.length * 8 * 1e6) / 128000; // 近似时间戳
      yield { data: b.data, timestampUs: ts };
    }
  })();
  await decodeWithWebCodecs(iter,
    { codec: 'mp3', sampleRate: info.sampleRate, numberOfChannels: info.channels },
    sink, totalSec);
  return { durationSec: totalSec };
}

async function decodeMp4(file: File, sink: DecodeSink): Promise<DecodeResult> {
  const track = await parseMp4(file);
  const totalSec = track.offsets.length / track.sampleRate * 1024; // 每样本约1024帧
  const BATCH = 256;
  const iter = (async function* () {
    for (let i = 0; i < track.offsets.length; i += BATCH) {
      const n = Math.min(BATCH, track.offsets.length - i);
      const start = track.offsets[i];
      const endOff = track.offsets[i + n - 1] + track.sizes[i + n - 1];
      const buf = new Uint8Array(await file.slice(start, endOff).arrayBuffer());
      // 逐样本切出（AAC 需要按 access unit 喂）
      for (let k = 0; k < n; k++) {
        const off = track.offsets[i + k] - start;
        yield {
          data: buf.subarray(off, off + track.sizes[i + k]),
          timestampUs: ((i + k) * 1024 * 1e6) / track.sampleRate,
        };
      }
    }
  })();
  await decodeWithWebCodecs(iter, {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    ...(track.description ? { description: track.description } : {}),
  }, sink, totalSec);
  return { durationSec: totalSec };
}

async function decodeFallback(file: File, sink: DecodeSink): Promise<DecodeResult> {
  if (file.size > 100 * 1024 * 1024) {
    throw new Error('该格式仅支持整体解码，文件过大；请转为 WAV/MP3/M4A');
  }
  const ac = new AudioContext();
  const buf = await ac.decodeAudioData(await file.arrayBuffer());
  await ac.close();
  const resampler = new StreamingResampler(buf.sampleRate, ANALYSIS_RATE);
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const STEP = 1 << 20;
  for (let i = 0; i < ch0.length; i += STEP) {
    const n = Math.min(STEP, ch0.length - i);
    const mono = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      mono[k] = ch1 ? (ch0[i + k] + ch1[i + k]) / 2 : ch0[i + k];
    }
    sink.onPcm(resampler.push(mono));
    sink.onProgress(i / buf.sampleRate, buf.duration);
    await new Promise(r => setTimeout(r, 0));
  }
  return { durationSec: buf.duration };
}

export async function decodeFile(file: File, sink: DecodeSink): Promise<DecodeResult> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'wav') return decodeWav(file, sink);
  if (ext === 'mp3') return decodeMp3(file, sink);
  if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') return decodeMp4(file, sink);
  return decodeFallback(file, sink);
}
