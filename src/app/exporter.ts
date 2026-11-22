// Export: WAV (manual PCM encode), AAC via WebCodecs AudioEncoder → ADTS,
// plus MediaSource-based audition of the encoded result. Fully offline.

import { encodeWavPcm16 } from "../shared/wav.ts";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportWav(pcm: Float32Array, sampleRate: number): void {
  const buf = encodeWavPcm16([pcm], sampleRate);
  download(new Blob([buf], { type: "audio/wav" }), "comp.wav");
}

// 7-byte ADTS header for one AAC raw frame.
function adtsHeader(frameLen: number, sampleRate: number, channels: number): Uint8Array {
  const srIndexTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  let srIndex = srIndexTable.indexOf(sampleRate);
  if (srIndex < 0) srIndex = 4; // fall back to 44.1k signalling
  const profile = 2; // AAC LC
  const len = frameLen + 7;
  const h = new Uint8Array(7);
  h[0] = 0xff;
  h[1] = 0xf1;
  h[2] = ((profile - 1) << 6) | (srIndex << 2) | (channels >> 2);
  h[3] = ((channels & 3) << 6) | (len >> 11);
  h[4] = (len >> 3) & 0xff;
  h[5] = ((len & 7) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

export async function exportAac(pcm: Float32Array, sampleRate: number): Promise<Blob> {
  if (typeof AudioEncoder === "undefined") {
    throw new Error("此浏览器不支持 WebCodecs AudioEncoder，请用 WAV 导出。");
  }
  const config: AudioEncoderConfig = {
    codec: "mp4a.40.2",
    sampleRate,
    numberOfChannels: 1,
    bitrate: 128_000,
  };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error("当前环境不支持 AAC 编码配置。");

  const parts: Uint8Array[] = [];
  let encError: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const raw = new Uint8Array(chunk.byteLength);
      chunk.copyTo(raw);
      parts.push(adtsHeader(raw.length, sampleRate, 1), raw);
    },
    error: (e) => {
      encError = e;
    },
  });
  encoder.configure(config);

  // Feed in 1024-sample frames (AAC frame size).
  const frameSize = 1024;
  for (let off = 0; off < pcm.length; off += frameSize) {
    const n = Math.min(frameSize, pcm.length - off);
    const data = new Float32Array(n);
    data.set(pcm.subarray(off, off + n));
    const frame = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: n,
      numberOfChannels: 1,
      timestamp: Math.round((off / sampleRate) * 1e6),
      data,
    });
    encoder.encode(frame);
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  if (encError) throw encError;
  return new Blob(parts as BlobPart[], { type: "audio/aac" });
}

export function exportAacDownload(blob: Blob): void {
  download(blob, "comp.aac");
}

// Audition an encoded blob through MediaSource when supported (streaming
// playback path), falling back to a plain object URL.
export function auditionEncoded(blob: Blob, mime: string): HTMLAudioElement {
  const audio = new Audio();
  if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime)) {
    const ms = new MediaSource();
    audio.src = URL.createObjectURL(ms);
    ms.addEventListener("sourceopen", async () => {
      const sb = ms.addSourceBuffer(mime);
      sb.addEventListener("updateend", () => {
        if (ms.readyState === "open") ms.endOfStream();
      });
      sb.appendBuffer(await blob.arrayBuffer());
    });
  } else {
    audio.src = URL.createObjectURL(blob);
  }
  void audio.play();
  return audio;
}
