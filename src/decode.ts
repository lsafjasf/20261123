// 解码：优先 WebAudio decodeAudioData；失败时 WAV 手工解析（PCM 16/24/32f），
// ADTS AAC 走 WebCodecs AudioDecoder。全部本地完成。

export interface DecodedAudio {
  pcm: Float32Array; // 单声道混合
  sampleRate: number;
  channels: number;
  duration: number;
}

function mixDown(buf: AudioBuffer): DecodedAudio {
  const n = buf.length;
  const pcm = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) pcm[i] += ch[i] / buf.numberOfChannels;
  }
  return { pcm, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, duration: buf.duration };
}

function parseWav(data: ArrayBuffer): DecodedAudio {
  const v = new DataView(data);
  const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(data, o, n));
  if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") throw new Error("not wav");
  let off = 12, fmt = { ch: 1, rate: 44100, bits: 16, tag: 1 }, pcmOff = -1, pcmLen = 0;
  while (off + 8 <= data.byteLength) {
    const id = str(off, 4);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        tag: v.getUint16(off + 8, true),
        ch: v.getUint16(off + 10, true),
        rate: v.getUint32(off + 12, true),
        bits: v.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      pcmOff = off + 8;
      pcmLen = Math.min(size, data.byteLength - pcmOff);
    }
    off += 8 + size + (size & 1);
  }
  if (pcmOff < 0) throw new Error("wav: no data chunk");
  const frames = Math.floor(pcmLen / (fmt.bits / 8) / fmt.ch);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = pcmOff + (i * fmt.ch + c) * (fmt.bits / 8);
      let s = 0;
      if (fmt.tag === 3 && fmt.bits === 32) s = v.getFloat32(o, true);
      else if (fmt.bits === 16) s = v.getInt16(o, true) / 32768;
      else if (fmt.bits === 24) {
        const b0 = v.getUint8(o), b1 = v.getUint8(o + 1), b2 = v.getUint8(o + 2);
        let x = (b2 << 16) | (b1 << 8) | b0;
        if (x & 0x800000) x -= 0x1000000;
        s = x / 8388608;
      } else if (fmt.bits === 32) s = v.getInt32(o, true) / 2147483648;
      else if (fmt.bits === 8) s = (v.getUint8(o) - 128) / 128;
      acc += s / fmt.ch;
    }
    pcm[i] = acc;
  }
  return { pcm, sampleRate: fmt.rate, channels: fmt.ch, duration: frames / fmt.rate };
}

// ADTS 分帧 → WebCodecs AAC 解码（浏览器支持时）。
async function decodeAdts(data: ArrayBuffer): Promise<DecodedAudio> {
  const u8 = new Uint8Array(data);
  const chunks: { data: Uint8Array; ts: number }[] = [];
  let off = 0, frames = 0;
  while (off + 7 <= u8.length) {
    if (u8[off] !== 0xff || (u8[off + 1] & 0xf0) !== 0xf0) break;
    const len = ((u8[off + 3] & 3) << 11) | (u8[off + 4] << 3) | ((u8[off + 5] & 0xe0) >> 5);
    if (len < 7 || off + len > u8.length) break;
    chunks.push({ data: u8.slice(off, off + len), ts: (frames * 1024 * 1e6) / 44100 });
    frames++;
    off += len;
  }
  if (chunks.length === 0 || typeof AudioDecoder === "undefined") throw new Error("no adts/webcodecs");
  const sr = 44100; // 从 ADTS 头解析采样率索引
  const idx = (u8[2] >> 2) & 0x0f;
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  const sampleRate = rates[idx] ?? sr;
  const ch = ((u8[2] & 1) << 2) | ((u8[3] >> 6) & 3);
  const outs: Float32Array[] = [];
  const decoder = new AudioDecoder({
    output: (frame) => {
      const size = frame.allocationSize({ format: "f32-planar" });
      const buf = new ArrayBuffer(size);
      frame.copyTo(buf, { format: "f32-planar" });
      outs.push(new Float32Array(buf));
      frame.close();
    },
    error: (e) => { throw e; },
  });
  decoder.configure({ codec: `mp4a.40.2`, sampleRate, numberOfChannels: ch });
  for (const c of chunks) decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: c.ts, data: c.data }));
  await decoder.flush();
  const total = outs.reduce((a, b) => a + b.length, 0);
  const pcm = new Float32Array(total);
  let w = 0;
  for (const o of outs) { pcm.set(o); w += o.length; }
  return { pcm, sampleRate, channels: ch, duration: total / sampleRate };
}

export async function decodeFile(file: File): Promise<DecodedAudio> {
  const data = await file.arrayBuffer();
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    return mixDown(await ctx.decodeAudioData(data.slice(0)));
  } catch { /* fall through */ }
  try {
    return parseWav(data);
  } catch { /* fall through */ }
  return decodeAdts(data);
}
