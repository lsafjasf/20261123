// In-browser independent verifier using only Web platform APIs.
// This does not trust the Node toolchain: it re-parses the container, hashes
// sample ranges via SubtleCrypto, decodes keyframes with WebCodecs, draws them
// to Canvas for frame fingerprints, decodes audio with WebAudio, and probes
// MediaSource demuxing support.

import { parseFile, findBoxes } from '../src/mp4.ts';
import { classifyAll } from '../src/classify.ts';
import { hashBytesWebCrypto, resolveSampleRanges } from './web-sample-table.ts';
import type { Finding } from '../src/types.ts';

export interface BrowserReport {
  fileName: string;
  fileSize: number;
  containerParseable: boolean;
  findings: Finding[];
  sampleHashes: { codec: string; handler: string; sampleCount: number; hash: string }[];
  mdatHashes: { size: number; hash: string }[];
  decode: {
    webCodecsSupported: boolean;
    framesDecoded: number;
    frameFingerprints: string[];
    note: string;
  };
  audio: {
    webAudioSupported: boolean;
    durationMs: number;
    channels: number;
    fingerprint: string;
    note: string;
  };
  mediaSource: {
    supported: boolean;
    canDemux: boolean;
    note: string;
  };
}

async function hashRange(reader: { read(s: number, e: number): Promise<Uint8Array> }, start: number, end: number): Promise<string> {
  return hashBytesWebCrypto(await reader.read(start, end));
}

function codecMime(codec: string): string {
  const map: Record<string, string> = {
    avc1: 'video/mp4; codecs="avc1.42E01E"',
    hvc1: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
    hev1: 'video/mp4; codecs="hev1.1.6.L93.B0"',
    av01: 'video/mp4; codecs="av01.0.04M.08"',
    mp4a: 'audio/mp4; codecs="mp4a.40.2"',
    ac-3: 'audio/mp4; codecs="ac-3"',
  };
  return map[codec] ?? `video/mp4; codecs="${codec}"`;
}

async function decodeKeyframes(
  reader: Reader,
  root: Awaited<ReturnType<typeof parseFile>>,
): Promise<BrowserReport['decode']> {
  const supported = typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined';
  if (!supported) {
    return {
      webCodecsSupported: false, framesDecoded: 0, frameFingerprints: [],
      note: '当前浏览器不支持 WebCodecs，跳过帧级独立验证',
    };
  }
  const trak = findBoxes(root, (n) => n.type === 'trak')[0];
  if (!trak) {
    return {
      webCodecsSupported: true, framesDecoded: 0, frameFingerprints: [],
      note: '未发现视频轨',
    };
  }
  const stbl = findBoxes([trak], (n) => n.type === 'stbl')[0];
  if (!stbl) {
    return {
      webCodecsSupported: true, framesDecoded: 0, frameFingerprints: [],
      note: '视频轨缺少 stbl，无法解码',
    };
  }
  const ranges = await resolveSampleRanges(reader, stbl);
  const stsd = findBoxes([trak], (n) => n.type === 'stsd')[0];
  const codec = stsd
    ? new TextDecoder('latin1').decode(
        await reader.read(stsd.contentStart + 12, stsd.contentStart + 16),
      )
    : 'avc1';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const fingerprints: string[] = [];
  let decoded = 0;

  await new Promise<void>((resolve) => {
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (ctx && decoded < 5) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          ctx.drawImage(frame, 0, 0);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          // Downsample fingerprint: every 97th pixel's red channel.
          const picked: number[] = [];
          for (let i = 0; i < image.data.length; i += 97 * 4) picked.push(image.data[i] ?? 0);
          fingerprints.push(`${canvas.width}x${canvas.height}:` + picked.join(','));
        }
        decoded++;
        frame.close();
      },
      error: () => resolve(),
    });
    try {
      decoder.configure({ codec: codecMime(codec).split('"')[1] ?? codec });
    } catch {
      resolve();
      return;
    }
    void (async () => {
      for (const range of ranges.slice(0, 8)) {
        const bytes = await reader.read(range.offset, range.offset + range.size);
        const chunk = new EncodedVideoChunk({
          type: 'key',
          timestamp: range.index * 33333,
          data: bytes,
        });
        try {
          decoder.decode(chunk);
        } catch {
          break;
        }
      }
      await decoder.flush().catch(() => {});
      decoder.close();
      resolve();
    })();
  });

  return {
    webCodecsSupported: true,
    framesDecoded: decoded,
    frameFingerprints: fingerprints,
    note: decoded > 0
      ? `WebCodecs 独立解码 ${decoded} 个采样，Canvas 指纹可与发布前对比`
      : '解码器未能处理该编码（手机厂商私有配置常见），码流哈希仍有效',
  };
}

async function decodeAudioFingerprint(file: File): Promise<BrowserReport['audio']> {
  const supported = typeof (globalThis as { AudioContext?: unknown }).AudioContext !== 'undefined';
  if (!supported) {
    return {
      webAudioSupported: false, durationMs: 0, channels: 0, fingerprint: '',
      note: '当前浏览器不支持 WebAudio',
    };
  }
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const channel = buffer.getChannelData(0);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < channel.length; i += 997) {
      const value = channel[i] ?? 0;
      sum += value * value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const fingerprint = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${buffer.length}:${sum}:${min}:${max}`),
    );
    const hex = Array.from(new Uint8Array(fingerprint))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    return {
      webAudioSupported: true,
      durationMs: buffer.duration * 1000,
      channels: buffer.numberOfChannels,
      fingerprint: hex,
      note: 'WebAudio 解码成功；指纹统计 PCM 电平，重编码会改变它',
    };
  } catch {
    return {
      webAudioSupported: true, durationMs: 0, channels: 0, fingerprint: '',
      note: 'WebAudio 无法解码该音频容器（不影响码流哈希结论）',
    };
  } finally {
    await context.close();
  }
}

function probeMediaSource(codec: string): BrowserReport['mediaSource'] {
  const supported = typeof (globalThis as { MediaSource?: unknown }).MediaSource !== 'undefined';
  if (!supported) {
    return { supported: false, canDemux: false, note: '当前浏览器不支持 MediaSource' };
  }
  const mime = codecMime(codec);
  const canDemux = MediaSource.isTypeSupported(mime);
  return {
    supported: true,
    canDemux,
    note: canDemux
      ? `MediaSource 可解复用 ${mime}，容器结构对浏览器有效`
      : `MediaSource 不接受 ${mime}（可能是未分片 MP4，属常见情况）`,
  };
}

export async function verifyInBrowser(file: File): Promise<BrowserReport> {
  const reader = new (await import('./browser-reader.ts')).FileReader(file);
  let root: Awaited<ReturnType<typeof parseFile>> = [];
  let containerParseable = true;
  try {
    root = await parseFile(reader);
  } catch {
    containerParseable = false;
  }

  const { findings } = containerParseable
    ? await classifyAll(reader, root)
    : { findings: [] as Finding[] };

  const sampleHashes: BrowserReport['sampleHashes'] = [];
  const mdatHashes: BrowserReport['mdatHashes'] = [];
  let firstCodec = 'avc1';

  if (containerParseable) {
    for (const trak of findBoxes(root, (n) => n.type === 'trak')) {
      const stbl = findBoxes([trak], (n) => n.type === 'stbl')[0];
      if (!stbl) continue;
      const ranges = await resolveSampleRanges(reader, stbl);
      const total = ranges.reduce((sum, r) => sum + r.size, 0);
      const combined = new Uint8Array(total);
      let written = 0;
      for (const range of ranges) {
        combined.set(await reader.read(range.offset, range.offset + range.size), written);
        written += range.size;
      }
      const hash = await hashBytesWebCrypto(combined);
      const stsd = findBoxes([trak], (n) => n.type === 'stsd')[0];
      const codec = stsd
        ? new TextDecoder('latin1').decode(
            await reader.read(stsd.contentStart + 12, stsd.contentStart + 16),
          )
        : 'unknown';
      const hdlr = findBoxes([trak], (n) => n.type === 'hdlr')[0];
      const handler = hdlr
        ? new TextDecoder('latin1').decode(
            await reader.read(hdlr.contentStart + 8, hdlr.contentStart + 12),
          )
        : 'unknown';
      sampleHashes.push({ codec, handler, sampleCount: ranges.length, hash });
      if (handler === 'vide') firstCodec = codec;
    }
    for (const mdat of findBoxes(root, (n) => n.type === 'mdat')) {
      mdatHashes.push({
        size: mdat.end - mdat.contentStart,
        hash: await hashRange(reader, mdat.contentStart, mdat.end),
      });
    }
  }

  const [decode, audio, mediaSource] = await Promise.all([
    containerParseable ? decodeKeyframes(reader, root) : Promise.resolve({
      webCodecsSupported: false, framesDecoded: 0, frameFingerprints: [],
      note: '容器无法解析',
    }),
    decodeAudioFingerprint(file),
    Promise.resolve(probeMediaSource(firstCodec)),
  ]);

  return {
    fileName: file.name,
    fileSize: file.size,
    containerParseable,
    findings,
    sampleHashes,
    mdatHashes,
    decode,
    audio,
    mediaSource,
  };
}
