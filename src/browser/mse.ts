// MediaSource playback verification. Muxes the real encoded chunks into
// a fragmented MP4 (pure JS muxer) and plays it through a video element,
// checking that the browser actually renders frames.

import type { TestConfig } from '../shared/matrix.ts';
import { muxFmp4 } from '../shared/fmp4.ts';
import type { MuxInit, MuxSample } from '../shared/fmp4.ts';
import type { EncodedChunkRecord } from './pipeline.ts';

export interface MseResult {
  status: 'pass' | 'fail' | 'skipped';
  note: string;
  durationMs: number | null;
}

function codecIdOf(cfg: TestConfig): MuxInit['codecId'] | null {
  if (cfg.codecString.startsWith('avc1')) return 'avc1';
  if (cfg.codecString.startsWith('hev1') || cfg.codecString.startsWith('hvc1')) return 'hev1';
  if (cfg.codecString.startsWith('vp09')) return 'vp09';
  if (cfg.codecString.startsWith('av01')) return 'av01';
  return null;
}

function waitFor(target: EventTarget, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
    };
    target.addEventListener(event, onEvent, { once: true });
  });
}

export async function runMseCheck(
  cfg: TestConfig,
  chunks: EncodedChunkRecord[],
  description: Uint8Array | null,
  timeoutMs: number,
): Promise<MseResult> {
  const start = performance.now();
  if (!cfg.mp4Muxable) {
    return { status: 'skipped', note: 'codec not mp4-muxable in this bench', durationMs: null };
  }
  const codecId = codecIdOf(cfg);
  if (!codecId) return { status: 'skipped', note: 'no muxer for codec', durationMs: null };
  if (typeof MediaSource === 'undefined') {
    return { status: 'fail', note: 'MediaSource unavailable', durationMs: null };
  }
  const mime = `video/mp4; codecs="${cfg.codecString}"`;
  if (!MediaSource.isTypeSupported(mime)) {
    return { status: 'fail', note: `isTypeSupported false for ${mime}`, durationMs: null };
  }

  const timescale = 90000;
  const frameDuration = Math.round(timescale / cfg.fps);
  const samples: MuxSample[] = chunks.map((chunk, index) => ({
    data: chunk.data,
    duration: frameDuration,
    keyframe: chunk.keyframe,
    ctsOffset: Math.round((chunk.timestamp / 1_000_000) * timescale) - index * frameDuration,
  }));

  let mp4: Uint8Array;
  try {
    mp4 = muxFmp4(
      {
        codecId,
        codecString: cfg.codecString,
        width: cfg.width,
        height: cfg.height,
        timescale,
        description,
      },
      samples,
    );
  } catch (err) {
    return { status: 'fail', note: `mux failed: ${String(err)}`, durationMs: null };
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  try {
    await waitFor(mediaSource, 'sourceopen', timeoutMs);
    const sourceBuffer = mediaSource.addSourceBuffer(mime);
    const appended = waitFor(sourceBuffer, 'updateend', timeoutMs);
    sourceBuffer.appendBuffer(mp4 as unknown as BufferSource);
    await appended;
    mediaSource.endOfStream();

    await waitFor(video, 'canplay', timeoutMs);
    let framesRendered = 0;
    const videoWithRvfc = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (videoWithRvfc.requestVideoFrameCallback) {
      videoWithRvfc.requestVideoFrameCallback(function count(): void {
        framesRendered++;
        if (videoWithRvfc.requestVideoFrameCallback) {
          videoWithRvfc.requestVideoFrameCallback(count);
        }
      });
    }
    try {
      await video.play();
    } catch (err) {
      return {
        status: 'fail',
        note: `play() rejected: ${String(err)}`,
        durationMs: performance.now() - start,
      };
    }
    // Give playback a short window, then verify progress.
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, timeoutMs)));
    const progressed = video.currentTime > 0.05 || framesRendered > 0;
    if (video.error) {
      return {
        status: 'fail',
        note: `media error code ${video.error.code}`,
        durationMs: performance.now() - start,
      };
    }
    if (!progressed) {
      return {
        status: 'fail',
        note: `no playback progress (currentTime=${video.currentTime.toFixed(3)}, rvfc=${framesRendered})`,
        durationMs: performance.now() - start,
      };
    }
    return {
      status: 'pass',
      note: `played to ${video.currentTime.toFixed(2)}s, rvfc=${framesRendered}`,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    return { status: 'fail', note: String(err), durationMs: performance.now() - start };
  } finally {
    video.pause();
    video.removeAttribute('src');
    URL.revokeObjectURL(objectUrl);
    video.remove();
  }
}
