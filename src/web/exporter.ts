// 导出管线：Canvas 帧 → WebCodecs VideoEncoder → 自研 EBML 封装 → WebM Blob
// 并用 MediaSource 回放校验导出文件。全程离线。
import { muxWebM, type EncodedChunkLike } from '../shared/webm.ts';

export interface CodecPick {
  encoder: string;   // WebCodecs codec 字符串
  mux: 'V_VP8' | 'V_VP9';
  mime: string;      // MSE 用
}

export async function pickCodec(): Promise<CodecPick> {
  const candidates: CodecPick[] = [
    { encoder: 'vp09.00.10.08', mux: 'V_VP9', mime: 'video/webm; codecs="vp09.00.10.08"' },
    { encoder: 'vp8', mux: 'V_VP8', mime: 'video/webm; codecs="vp8"' },
  ];
  for (const c of candidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec: c.encoder, width: 640, height: 360, bitrate: 4_000_000,
    });
    if (support.supported && MediaSource.isTypeSupported(c.mime)) return c;
  }
  throw new Error('当前浏览器不支持 VP8/VP9 编码或 MSE 回放');
}

export interface EncodeOptions {
  canvas: HTMLCanvasElement;
  framePts: number[]; // 毫秒
  draw: (frameIdx: number) => void | Promise<void>;
  bitrate?: number;
  keyInterval?: number;
  onProgress?: (frac: number) => void;
}

/** 逐帧回调绘制 → 编码 → 封装为 WebM Blob */
export async function encodeFrames(opts: EncodeOptions): Promise<Blob> {
  const pick = await pickCodec();
  const { canvas, framePts } = opts;
  const chunks: EncodedChunkLike[] = [];
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration, data });
    },
    error: (e) => { encodeError = e; },
  });
  encoder.configure({
    codec: pick.encoder,
    width: canvas.width,
    height: canvas.height,
    bitrate: opts.bitrate ?? 6_000_000,
    framerate: 60,
  });
  const keyInterval = opts.keyInterval ?? 120;
  for (let i = 0; i < framePts.length; i++) {
    if (encodeError) throw encodeError;
    await opts.draw(i);
    const ptsUs = Math.round(framePts[i] * 1000);
    const durUs = i < framePts.length - 1
      ? Math.round((framePts[i + 1] - framePts[i]) * 1000)
      : 16667;
    const frame = new VideoFrame(canvas, { timestamp: ptsUs, duration: durUs });
    encoder.encode(frame, { keyFrame: i % keyInterval === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 8) {
      await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
    }
    opts.onProgress?.((i + 1) / framePts.length);
  }
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  const bytes = muxWebM(chunks, { codec: pick.mux, width: canvas.width, height: canvas.height });
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'video/webm' });
}

/** 用 MediaSource 回放校验导出的 WebM，返回可播放时长（秒） */
export async function verifyWithMse(blob: Blob, video: HTMLVideoElement): Promise<number> {
  const pick = await pickCodec();
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      ms.addEventListener('sourceopen', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('MSE 视频元素错误')), { once: true });
    });
    const sb = ms.addSourceBuffer(pick.mime);
    sb.appendBuffer(await blob.arrayBuffer());
    await new Promise<void>((resolve, reject) => {
      sb.addEventListener('updateend', () => resolve(), { once: true });
      sb.addEventListener('error', () => reject(new Error('MSE appendBuffer 失败')), { once: true });
    });
    ms.endOfStream();
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) resolve();
      else video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });
    return video.duration;
  } finally {
    // 保留 src 供用户回放验证，仅在下一次调用时替换
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
