/**
 * 浏览器编码/播放流水线（全部使用浏览器内置 API，无第三方包）：
 * PCM(Float32 立体声) -> AudioEncoder(Opus via WebCodecs)
 *   -> WebmOpusMuxer -> MediaSource/SourceBuffer -> <audio>/<video> 元素播放。
 * 编码输入由离线确定性渲染给出，因此同 seed 的最终媒体字节同样确定。
 */

import { SAMPLE_RATE } from '../core/types.ts';
import { WebmOpusMuxer, type OpusChunk } from './webm-muxer.ts';

const OPUS_FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * OPUS_FRAME_MS) / 1000;

export interface PipelineHandle {
  mimeType: string;
  /** 编码完成的完整 WebM 字节，可下载或二次校验 */
  bytes: Uint8Array;
  objectUrl: string;
  close: () => void;
}

export function isPipelineSupported(): boolean {
  return (
    typeof globalThis.AudioEncoder !== 'undefined' &&
    typeof globalThis.MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported('audio/webm;codecs=opus')
  );
}

/** 交错立体声 PCM -> 平面 Float32 帧（AudioData 要求 planar） */
function deinterleave(pcm: Float32Array): [Float32Array, Float32Array] {
  const frames = Math.floor(pcm.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = pcm[i * 2];
    right[i] = i * 2 + 1 < pcm.length ? pcm[i * 2 + 1] : 0;
  }
  return [left, right];
}

export async function encodeAndStream(
  pcm: Float32Array,
  mediaElement: HTMLMediaElement,
  onProgress?: (ratio: number) => void,
): Promise<PipelineHandle> {
  if (!isPipelineSupported()) {
    throw new Error('当前浏览器不支持 WebCodecs Opus 或 MediaSource webm');
  }
  const mimeType = 'audio/webm;codecs=opus';
  const durationSeconds = pcm.length / 2 / SAMPLE_RATE;
  const muxer = new WebmOpusMuxer(SAMPLE_RATE, 2);
  const collected: Uint8Array[] = [muxer.header(durationSeconds)];

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  mediaElement.src = objectUrl;
  const sourceOpen = waitFor(mediaSource, 'sourceopen');

  const chunks: OpusChunk[] = [];
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? OPUS_FRAME_MS * 1000,
      });
    },
    error: (err) => {
      throw err;
    },
  });
  encoder.configure({
    codec: 'opus',
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 2,
    bitrate: 128_000,
  });

  const [left, right] = deinterleave(pcm);
  const frameCount = Math.floor(left.length / FRAME_SAMPLES);
  let timestamp = 0;
  for (let i = 0; i < frameCount; i++) {
    const offset = i * FRAME_SAMPLES;
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: FRAME_SAMPLES,
      numberOfChannels: 2,
      timestamp,
      data: concatPlanar(
        left.subarray(offset, offset + FRAME_SAMPLES),
        right.subarray(offset, offset + FRAME_SAMPLES),
      ),
    });
    encoder.encode(audioData);
    audioData.close();
    timestamp += FRAME_SAMPLES / SAMPLE_RATE;
    onProgress?.((i + 1) / (frameCount + 2));
  }
  await encoder.flush();
  encoder.close();

  await sourceOpen;
  const buffer = mediaSource.addSourceBuffer(mimeType);
  buffer.mode = 'sequence';
  await append(buffer, collected[0]);
  for (let i = 0; i < chunks.length; i++) {
    const bytes = muxer.addChunk(chunks[i]);
    collected.push(bytes);
    await append(buffer, bytes);
    onProgress?.((frameCount + i + 1) / (frameCount + chunks.length + 2));
  }
  mediaSource.endOfStream();

  const flat = flatten(collected);
  return {
    mimeType,
    bytes: flat,
    objectUrl,
    close: () => {
      URL.revokeObjectURL(objectUrl);
      mediaElement.removeAttribute('src');
      mediaElement.load();
    },
  };
}

function concatPlanar(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function flatten(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function waitFor(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true });
  });
}

function append(buffer: SourceBuffer, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      buffer.removeEventListener('updateend', done);
      buffer.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => reject(new Error('SourceBuffer append 失败'));
    buffer.addEventListener('updateend', done);
    buffer.addEventListener('error', fail);
    buffer.appendBuffer(data);
  });
}
