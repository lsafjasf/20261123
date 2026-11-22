import type { ReplaySnapshot } from "./ring-buffer.ts";
import { muxReplaySnapshot } from "./webm-muxer.ts";

interface MuxRequest {
  type: "mux";
  requestId: number;
  snapshot: ReplaySnapshot;
  width: number;
  height: number;
  audioChannels: number;
}

interface MuxSuccess {
  type: "result";
  requestId: number;
  buffer: ArrayBuffer;
  mimeType: string;
  durationMs: number;
  clusterCount: number;
  videoFrameCount: number;
  audioFrameCount: number;
}

interface MuxFailure {
  type: "error";
  requestId: number;
  message: string;
}

self.addEventListener("message", (event: MessageEvent<MuxRequest>) => {
  const request = event.data;
  if (request.type !== "mux") {
    return;
  }
  try {
    const result = muxReplaySnapshot(request.snapshot, {
      width: request.width,
      height: request.height,
      audioChannels: request.audioChannels,
    });
    const message: MuxSuccess = {
      type: "result",
      requestId: request.requestId,
      buffer: result.bytes.buffer as ArrayBuffer,
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      clusterCount: result.clusterCount,
      videoFrameCount: result.videoFrameCount,
      audioFrameCount: result.audioFrameCount,
    };
    self.postMessage(message, [message.buffer]);
  } catch (error) {
    const message: MuxFailure = {
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(message);
  }
});
