// 非关键帧切点的转码：仅重编码该段视频（WebCodecs），音频仍无损拷贝。
import { sampleData,                        } from "../core/mp4/demux.js";
import { buildAvc1Entry,                } from "../core/mp4/mux.js";
                                                        
                                                                

export async function transcodeSegment(
  movie       ,
  seg             ,
  onProgress                                        ,
)                             {
  const vt = movie.tracks.find((t) => t.kind === "video")         ;
  const ts = vt.timescale;
  const firstCts = vt.samples[seg.videoFrom].cts;
  const lastCts = vt.samples[seg.videoTo - 1].cts;

  // 码率估计：源段平均码率 ×1.5，夹在 [1, 20] Mbps
  let bits = 0;
  for (let i = seg.videoFrom; i < seg.videoTo; i++) bits += vt.samples[i].size * 8;
  const durSec = (lastCts - firstCts + vt.samples[seg.videoTo - 1].duration) / ts;
  const bitrate = Math.max(1_000_000, Math.min(20_000_000, Math.round((bits / durSec) * 1.5)));

  const chunks                      = [];
  let description                    = null;
  const encoder = new VideoEncoder({
    output: (c, meta) => {
      chunks.push(c);
      const desc = meta?.decoderConfig?.description;
      if (desc && !description) {
        const u8 = desc               ;
        description = new Uint8Array(u8.slice(0));
      }
    },
    error: (e) => console.error("encoder", e),
  });
  encoder.configure({
    codec: vt.codec,
    width: vt.width,
    height: vt.height,
    bitrate,
    framerate: Math.round(vt.timescale / (vt.samples[0].duration || 1)) || 30,
    latencyMode: "quality",
    avc: { format: "avc" },
  }                      );

  const decoder = new VideoDecoder({
    output: (f) => {
      if (f.timestamp >= Math.round((firstCts / ts) * 1e6) - 1) {
        encoder.encode(f, { keyFrame: !encodedAny });
        encodedAny = true;
      }
      f.close();
    },
    error: (e) => console.error("decoder", e),
  });
  decoder.configure({ codec: vt.codec, description: vt.description ?? undefined });
  let encodedAny = false;

  let from = seg.videoFrom;
  while (from > 0 && !vt.samples[from].keyframe) from--;
  const total = seg.videoTo - from;
  for (let k = from; k < seg.videoTo; k++) {
    const s = vt.samples[k];
    decoder.decode(
      new EncodedVideoChunk({
        type: s.keyframe ? "key" : "delta",
        timestamp: Math.round((s.cts / ts) * 1e6),
        duration: Math.round((s.duration / ts) * 1e6),
        data: sampleData(movie, s)                ,
      }),
    );
    onProgress?.(k - from + 1, total);
    if (decoder.decodeQueueSize > 8) await new Promise((r) => setTimeout(r, 10));
  }
  await decoder.flush();
  decoder.close();
  await encoder.flush();
  encoder.close();

  if (!description) throw new Error("编码器未返回 avcC 描述");
  if (chunks.length === 0) throw new Error("转码段无输出帧");

  // 组装样本：chunks 按解码序到达；cts 以首块为基准归零（拼接段各自从 0 起）
  const samples              = [];
  let dts = 0;
  let ctsBase                = null;
  for (const c of chunks) {
    const buf = new Uint8Array(c.byteLength);
    c.copyTo(buf);
    const dur = Math.round(((c.duration ?? 33333) / 1e6) * ts) || 1;
    const ctsRaw = Math.round((c.timestamp / 1e6) * ts);
    if (ctsBase === null) ctsBase = ctsRaw;
    samples.push({
      data: buf,
      duration: dur,
      ctsOffset: ctsRaw - ctsBase - dts,
      keyframe: c.type === "key",
      desc: 0,
    });
    dts += dur;
  }
  return { stsdEntry: buildAvc1Entry(vt.width, vt.height, description), samples };
}
