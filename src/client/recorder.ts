// Records the parametric animation to WebM entirely offline:
// Canvas -> VideoFrame (WebCodecs) -> VideoEncoder (VP9/VP8)
// -> hand-rolled EBML mux -> MediaSource -> <video> preview.

import { drawScene } from './animator.ts';
import { WebmMuxer } from './webmMux.ts';
import { SCENE_DURATION } from '../shared/scene.ts';
import type { FrameRate } from '../shared/timebase.ts';

export interface RecordResult {
  ok: boolean;
  message: string;
}

async function pickCodec(): Promise<{ codec: string; mux: 'V_VP9' | 'V_VP8' } | null> {
  const candidates = [
    { codec: 'vp09.00.10.08', mux: 'V_VP9' as const },
    { codec: 'vp8', mux: 'V_VP8' as const },
  ];
  for (const c of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width: 640,
        height: 360,
      });
      if (support.supported && MediaSource.isTypeSupported(`video/webm; codecs="${c.codec}"`)) {
        return c;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function recordScenePreview(
  video: HTMLVideoElement,
  rate: FrameRate,
  onProgress?: (done: number, total: number) => void,
): Promise<RecordResult> {
  if (typeof VideoEncoder === 'undefined' || typeof MediaSource === 'undefined') {
    return { ok: false, message: '此浏览器不支持 WebCodecs / MediaSource' };
  }
  const picked = await pickCodec();
  if (!picked) return { ok: false, message: '没有可用的 VP9/VP8 编码器' };

  const fps = rate.num / rate.den;
  const totalFrames = Math.ceil(SCENE_DURATION * fps);
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;

  const muxer = new WebmMuxer(canvas.width, canvas.height, picked.mux);
  const chunks: Uint8Array[] = [muxer.initialSegment()];

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const timestampMs = Math.round((chunk.timestamp ?? 0) / 1000);
      chunks.push(muxer.addFrame(data, timestampMs, chunk.type === 'key'));
    },
    error: () => {},
  });
  encoder.configure({
    codec: picked.codec,
    width: canvas.width,
    height: canvas.height,
    framerate: fps,
    bitrate: 2_000_000,
  });

  const gop = Math.max(1, Math.round(fps * 2));
  for (let frame = 0; frame < totalFrames; frame++) {
    drawScene(canvas, frame / fps);
    const timestampUs = Math.round((frame * 1_000_000 * rate.den) / rate.num);
    const durationUs = Math.round((1_000_000 * rate.den) / rate.num);
    const vf = new VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs });
    encoder.encode(vf, { keyFrame: frame % gop === 0 });
    vf.close();
    if (frame % 30 === 0) {
      onProgress?.(frame, totalFrames);
      await new Promise((r) => setTimeout(r, 0)); // keep the tab responsive
    }
  }
  await encoder.flush();
  encoder.close();

  // Feed the muxed WebM into MediaSource.
  const ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  await new Promise<void>((resolve, reject) => {
    ms.addEventListener('sourceopen', resolve, { once: true });
    ms.addEventListener('error', reject, { once: true });
  });
  const sb = ms.addSourceBuffer(`video/webm; codecs="${picked.codec}"`);
  for (const chunk of chunks) {
    if (sb.updating) await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    sb.appendBuffer(chunk);
  }
  await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
  ms.duration = totalFrames / fps;
  ms.endOfStream();
  onProgress?.(totalFrames, totalFrames);
  return { ok: true, message: `已录制 ${totalFrames} 帧 (${picked.codec})` };
}
