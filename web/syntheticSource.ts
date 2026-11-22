// 合成测试素材：Canvas 绘制细纹/边缘/径向图案（便于肉眼判断锐化与畸变），
// WebCodecs 编码为 VP9；WebAudio OfflineAudioContext 生成确定性音频。
// 输出供解封装/解码链路消费的内存缓冲与裸采样，全程无网络。

export interface SyntheticClip {
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  /** 每帧 RGBA 整帧数据（保持原始分辨率，绝不预缩放） */
  frames: Uint8ClampedArray[];
  audio: { sampleRate: number; channels: number; samples: Float32Array };
}

export function generateSyntheticClip(
  width: number,
  height: number,
  frameCount: number,
  fps: number,
): SyntheticClip {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const frames: Uint8ClampedArray[] = [];

  for (let f = 0; f < frameCount; f++) {
    drawPattern(ctx, width, height, f, frameCount);
    frames.push(ctx.getImageData(0, 0, width, height).data.slice());
  }

  const sampleRate = 48000;
  const durationSec = frameCount / fps;
  const sampleCount = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(sampleCount);
  // 双声道正弦扫频，验证 WebAudio 链路存在即可
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const freq = 220 + 660 * (t / durationSec);
    samples[i] = 0.18 * Math.sin(2 * Math.PI * freq * t);
  }
  return { width, height, frameCount, fps, frames, audio: { sampleRate, channels: 1, samples } };
}

function drawPattern(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: number,
  total: number,
): void {
  // 深色底
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, width, height);

  // 1px 竖细纹：检验锐化与拼接是否保留细节
  for (let x = 0; x < width; x += 2) {
    ctx.fillStyle = x % 4 === 0 ? '#d8dde3' : '#3a424c';
    ctx.fillRect(x, 0, 1, height);
  }

  // 横向细条纹（下半幅），制造各向异性细节
  for (let y = Math.floor(height / 2); y < height; y += 3) {
    ctx.fillStyle = 'rgba(120,200,255,0.55)';
    ctx.fillRect(0, y, width, 1);
  }

  // 高对比棋盘与同心圆：检验边缘与畸变
  const cx = width / 2;
  const cy = height / 2;
  const cell = Math.max(8, Math.floor(width / 96));
  for (let gy = 0; gy < height; gy += cell * 4) {
    for (let gx = 0; gx < width; gx += cell * 4) {
      ctx.fillStyle = ((gx / (cell * 4) + gy / (cell * 4)) % 2 === 0) ? '#f4f6f8' : '#1b2026';
      ctx.fillRect(gx, gy, cell * 2, cell * 2);
    }
  }
  const phase = (frame / total) * Math.PI * 2;
  for (let r = 20; r < Math.min(width, height) / 2; r += 28) {
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.sin(phase) * 6, 0, Math.PI * 2);
    ctx.strokeStyle = `hsl(${(r * 2 + frame * 12) % 360} 80% 62%)`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // 帧号标尺，肉眼检查块边界对齐
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.floor(height / 18)}px monospace`;
  ctx.fillText(`frame ${frame}  ${width}x${height}`, 24, Math.floor(height / 12));
}

/** 把一帧 RGBA 包装成 VideoFrame（Canvas 源，零拷贝路径由浏览器决定）。 */
export function frameToVideoFrame(data: Uint8ClampedArray, width: number, height: number, timestampMicros: number): VideoFrame {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return new VideoFrame(canvas, { timestamp: timestampMicros });
}

/** WebCodecs 硬/软编码整段合成帧为 VP9 块（用于验证 MSE 播放链路）。 */
export async function encodeVp9(
  clip: SyntheticClip,
  onProgress?: (ratio: number) => void,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const encoder = new VideoEncoder({
    output: (chunk: EncodedVideoChunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      parts.push(buf);
    },
    error: (err: Error) => {
      throw err;
    },
  });
  const config: VideoEncoderConfig = {
    codec: 'vp09.00.10.08',
    width: clip.width,
    height: clip.height,
    bitrate: 8_000_000,
    framerate: clip.fps,
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('当前浏览器不支持 VP9 编码');
  encoder.configure(config);

  const frameDuration = Math.floor(1_000_000 / clip.fps);
  for (let i = 0; i < clip.frameCount; i++) {
    const frame = frameToVideoFrame(clip.frames[i], clip.width, clip.height, i * frameDuration);
    encoder.encode(frame, { keyFrame: i === 0 });
    frame.close();
    onProgress?.(i / clip.frameCount);
    if (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
  }
  await encoder.flush();
  encoder.close();
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}
