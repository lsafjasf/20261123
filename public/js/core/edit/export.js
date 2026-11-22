// 把确认后的剪辑计划组装成新 MP4（无损段直接拷贝样本，转码段由调用方提供样本）。
import { demux, sampleData,                        } from "../mp4/demux.js";
import { mux,                                              } from "../mp4/mux.js";
                                         

                                    
                                        
                                              
 

// 浏览器端为每个 transcode 段提供重编码结果
                                                                                 

                               
                   
                         
                        
                        
 

function trackSamples(track       , from        , to        , movie       , desc        )              {
  const out              = [];
  for (let i = from; i < to; i++) {
    const s = track.samples[i];
    out.push({
      data: sampleData(movie, s),
      duration: s.duration,
      ctsOffset: s.cts - s.dts,
      keyframe: s.keyframe,
      desc,
    });
  }
  return out;
}

export async function buildOutput(
  movie       ,
  plan         ,
  transcode                    ,
)                        {
  if (plan.pendingCount > 0) throw new Error("存在未确认的切点决策，不能生成文件");
  const vt = movie.tracks.find((t) => t.kind === "video");
  const at = movie.tracks.find((t) => t.kind === "audio");
  if (!vt) throw new Error("未找到视频轨");

  const videoSamples              = [];
  const stsdEntries               = [vt.stsdEntry];
  for (const seg of plan.segments) {
    if (seg.dropped || seg.mode === "pending") continue;
    if (seg.mode === "transcode") {
      if (!transcode) throw new Error(`第 ${seg.index + 1} 段需要转码，但未提供转码器`);
      const r = await transcode(seg.index);
      let desc = stsdEntries.findIndex((e) => e.length === r.stsdEntry.length && e.every((b, i) => b === r.stsdEntry[i]));
      if (desc < 0) {
        stsdEntries.push(r.stsdEntry);
        desc = stsdEntries.length - 1;
      }
      for (const s of r.samples) videoSamples.push({ ...s, desc });
    } else {
      videoSamples.push(...trackSamples(vt, seg.videoFrom, seg.videoTo, movie, 0));
    }
  }

  const tracks             = [];
  if (videoSamples.length > 0) {
    tracks.push({
      kind: "video",
      timescale: vt.timescale,
      stsdEntries,
      width: vt.width,
      height: vt.height,
      samples: videoSamples,
      mediaTimeOffset: videoSamples[0].ctsOffset, // 展示起点归零
    });
  }
  if (at) {
    const audioSamples              = [];
    let firstCts = 0;
    let firstSet = false;
    for (const seg of plan.segments) {
      if (seg.dropped || seg.mode === "pending") continue;
      if (!firstSet && seg.audioTo > seg.audioFrom) {
        firstCts = at.samples[seg.audioFrom].cts;
        firstSet = true;
      }
      audioSamples.push(...trackSamples(at, seg.audioFrom, seg.audioTo, movie, 0));
    }
    if (audioSamples.length > 0) {
      // 源文件若以负 CTS 表示 AAC priming（常见），用 elst 跳过，避免音画整体偏移
      const priming = firstCts < 0 ? -firstCts : audioSamples[0].ctsOffset;
      tracks.push({
        kind: "audio",
        timescale: at.timescale,
        stsdEntries: [at.stsdEntry],
        width: 0,
        height: 0,
        samples: audioSamples,
        mediaTimeOffset: priming,
      });
    }
  }

  const input           = {
    majorBrand: movie.brands.major || "isom",
    minorVersion: movie.brands.minor,
    compatBrands: movie.brands.compat,
    movieTimescale: movie.timescale || 1000,
    tracks,
  };
  return {
    data: mux(input),
    fullyLossless: plan.fullyLossless,
    finalDuration: plan.finalDuration,
    avDriftMaxSec: plan.avDriftMaxSec,
  };
}

// 供 Node 端测试：从字节直接得到 Movie
export function parseMovie(buf            )        {
  return demux(buf);
}
