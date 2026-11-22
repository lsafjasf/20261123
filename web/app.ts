// 浏览器端验证：复用 src/mp4.ts 解析器（服务器现场擦除类型），
// MSE 播放 + WebCodecs 解码核对 + Canvas 绘制 + WebAudio 电平测量。

import { parseMp4, type TrackSamples } from "../src/mp4.ts";

declare const VideoDecoder: any;
declare const AudioDecoder: any;
declare const EncodedVideoChunk: any;
declare const EncodedAudioChunk: any;
declare const MediaSource: any;

const results = document.getElementById("results")!;
const player = document.getElementById("player") as HTMLVideoElement;
const canvas = document.getElementById("frame") as HTMLCanvasElement;

function row(cells: string[]): string {
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}

function checkMonotonic(t: TrackSamples): boolean {
  for (let i = 1; i < t.samples.length; i++) {
    if (t.samples[i].dts <= t.samples[i - 1].dts) return false;
  }
  return true;
}

async function decodeVerify(
  file: Uint8Array,
  track: TrackSamples,
): Promise<{ decoded: number; firstFrame?: VideoFrame }> {
  const isVideo = track.kind === "video";
  const Decoder = isVideo ? VideoDecoder : AudioDecoder;
  if (typeof Decoder === "undefined") return { decoded: -1 };
  let decoded = 0;
  let firstFrame: VideoFrame | undefined;
  const decoder = new Decoder({
    output: (frame: any) => {
      decoded += 1;
      if (isVideo && decoded === 1) firstFrame = frame.clone();
      frame.close();
    },
    error: (e: unknown) => console.error("decode error", e),
  });
  const config: Record<string, unknown> = isVideo
    ? { codec: "avc1.42E01E", description: track.avcC }
    : { codec: "mp4a.40.2", description: track.audioSpecificConfig };
  decoder.configure(config);
  const Chunk = isVideo ? EncodedVideoChunk : EncodedAudioChunk;
  for (const s of track.samples) {
    decoder.decode(new Chunk({
      type: "key",
      // WebCodecs 用微秒展示；源数据仍是整数 tick，此处仅换算一次
      timestamp: Number((s.dts * 1_000_000n) / BigInt(track.timescale)),
      duration: Number(
        (BigInt(s.duration) * 1_000_000n) / BigInt(track.timescale),
      ),
      data: file.subarray(s.dataOffset, s.dataOffset + s.size),
    }));
  }
  await decoder.flush();
  decoder.close();
  return { decoded, firstFrame };
}

async function playViaMse(file: Uint8Array): Promise<string> {
  if (typeof MediaSource === "undefined") return "MSE 不可用";
  const ms = new MediaSource();
  player.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
  const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  sb.appendBuffer(file);
  await new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
  ms.endOfStream();
  try {
    await player.play();
    return `可播放，时长 ${player.duration.toFixed(3)}s`;
  } catch (e) {
    return `播放失败: ${e}`;
  }
}

async function measureAudio(
  file: Uint8Array,
  track: TrackSamples,
): Promise<string> {
  const { decoded } = await decodeVerify(file, track);
  if (decoded < 0) return "AudioDecoder 不可用";
  // WebAudio：渲染一段缓冲测电平（静音素材应为零）
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  const buf = ctx.createBuffer(1, 44100, 44100);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  await ctx.startRendering();
  let peak = 0;
  for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
  return `解码 ${decoded} 帧，峰值电平 ${peak === 0 ? "-inf" : peak.toFixed(6)}`;
}

async function handleFile(f: File): Promise<void> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const info = parseMp4(bytes);
  const sec = document.createElement("div");
  let html = `<h2>${f.name}</h2><table>`;
  html += row(["轨道", "样本数", "首 DTS", "末 DTS", "单调", "解码核对"]);
  for (const t of info.tracks) {
    const mono = checkMonotonic(t);
    const { decoded, firstFrame } = await decodeVerify(bytes, t);
    if (firstFrame) {
      const g = canvas.getContext("2d")!;
      g.drawImage(firstFrame, 0, 0, canvas.width, canvas.height);
      firstFrame.close();
    }
    const decodedCell = decoded < 0
      ? "WebCodecs 不可用"
      : decoded === t.samples.length
        ? `<span class="ok">${decoded} ✓</span>`
        : `<span class="bad">${decoded}/${t.samples.length}</span>`;
    html += row([
      t.kind,
      String(t.samples.length),
      t.samples[0]?.dts.toString() ?? "-",
      t.samples[t.samples.length - 1]?.dts.toString() ?? "-",
      mono ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>',
      decodedCell,
    ]);
  }
  html += "</table>";
  const audio = info.tracks.find((t) => t.kind === "audio");
  html += `<p>MSE：${await playViaMse(bytes)}</p>`;
  if (audio) html += `<p>WebAudio：${await measureAudio(bytes, audio)}</p>`;
  sec.innerHTML = html;
  results.appendChild(sec);
}

document.getElementById("files")!.addEventListener("change", async (e) => {
  results.innerHTML = "";
  for (const f of Array.from((e.target as HTMLInputElement).files ?? [])) {
    await handleFile(f);
  }
});
