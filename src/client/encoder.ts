// WebCodecs encoding pipeline: canvas frames in, muxed WebM out.
import { WebmMuxer } from './webm.ts';
import type { MuxerConfig } from './webm.ts';

export interface EncodeResult {
  file: Uint8Array;        // standalone .webm
  init: Uint8Array;        // MSE init segment
  media: Uint8Array;       // MSE media segment
  codecId: MuxerConfig['codecId'];
  frames: number;
}

async function pickConfig(width: number, height: number, fps: number): Promise<{
  config: VideoEncoderConfig;
  codecId: MuxerConfig['codecId'];
}> {
  const candidates: Array<{ codec: string; codecId: MuxerConfig['codecId'] }> = [
    { codec: 'vp09.00.10.08', codecId: 'V_VP9' },
    { codec: 'vp8', codecId: 'V_VP8' },
  ];
  for (const c of candidates) {
    const config: VideoEncoderConfig = {
      codec: c.codec,
      width,
      height,
      framerate: fps,
      bitrate: Math.max(1_000_000, Math.round(width * height * fps * 0.12)),
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return { config, codecId: c.codecId };
    } catch {
      // try next codec
    }
  }
  throw new Error('WebCodecs: no supported VP9/VP8 encoder configuration');
}

// Renders `frameCount` frames via `renderFrame(i, timestampUs)` and encodes them.
export async function encodeVideo(opts: {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  renderFrame: (outIndex: number, canvas: OffscreenCanvas) => void;
  onProgress?: (done: number, total: number) => void;
}): Promise<EncodeResult> {
  const { width, height, fps, frameCount } = opts;
  const { config, codecId } = await pickConfig(width, height, fps);
  const muxer = new WebmMuxer({ width, height, codecId });

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      muxer.addFrame(buf, chunk.timestamp / 1000, chunk.type === 'key');
    },
    error: (e) => { throw e; },
  });
  encoder.configure(config);

  const canvas = new OffscreenCanvas(width, height);
  for (let i = 0; i < frameCount; i++) {
    opts.renderFrame(i, canvas);
    const timestamp = Math.round((i * 1_000_000) / fps);
    const frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1_000_000 / fps) });
    encoder.encode(frame, { keyFrame: i % (fps * 4) === 0 });
    frame.close();
    if (i % 10 === 0) {
      opts.onProgress?.(i, frameCount);
      await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
    }
  }
  await encoder.flush();
  encoder.close();

  return {
    file: muxer.finalize(),
    init: muxer.initSegment(),
    media: muxer.mediaSegment(),
    codecId,
    frames: frameCount,
  };
}
