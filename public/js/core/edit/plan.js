// 粗剪计划：删除区间 -> 保留段；非关键帧切点决策；音画时间基准对齐；片尾取整。
                                                    

                        
                     
              
 

                                                               

                              
                
                   
                 
                                
              
                    
                                                                   
                                          
                  
                    
                  
                      
                      
                   
                  
 

                          
                          
                                    
                         
                       
                        
                  
 

const EPS = 1e-6;

export function mergeRanges(ranges         , duration        )          {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(duration, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start);
  const out          = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function keepRanges(deletions         , duration        )          {
  const del = mergeRanges(deletions, duration);
  const out          = [];
  let cur = 0;
  for (const d of del) {
    if (d.start - cur > EPS) out.push({ start: cur, end: d.start });
    cur = Math.max(cur, d.end);
  }
  if (duration - cur > EPS) out.push({ start: cur, end: duration });
  return out;
}

// 视频段：返回解码序 [from, to)，起点必须落在关键帧上才允许无损
function videoRange(
  track       ,
  startSec        ,
  endSec        ,
)                                                                                                             {
  const ts = track.timescale;
  const startTs = startSec * ts;
  const endTs = endSec * ts;
  // 起点：展示时间不早于 start 的第一帧
  let start = -1;
  for (const s of track.samples) {
    if (s.cts + s.duration > startTs + 0.5 && (start < 0 || s.cts < track.samples[start].cts)) start = s.index;
  }
  if (start < 0) return { from: 0, to: 0, startExact: startSec, aligned: false, keyframe: false, tailDropped: 0 };
  const s0 = track.samples[start];
  const aligned = Math.abs(s0.cts - startTs) <= 0.5;
  // 终点：解码序向后走，遇到第一帧“片尾不足一帧”（cts+dur 超出 end）即停
  let to = start;
  let tailDropped = 0;
  for (let i = start; i < track.samples.length; i++) {
    const s = track.samples[i];
    if (s.cts + s.duration <= endTs + 0.5) to = i + 1;
    else {
      if (s.cts < endTs - 0.5) tailDropped = (endTs - s.cts) / ts; // 被丢弃的不足一帧尾部
      break;
    }
  }
  return { from: start, to, startExact: s0.cts / ts, aligned, keyframe: s0.keyframe, tailDropped };
}

function keyframeSnaps(
  track       ,
  startSec        ,
  lowerBoundSec        ,
)                                               {
  const ts = track.timescale;
  const t = startSec * ts;
  const lo = lowerBoundSec * ts;
  let prev                = null;
  let next                = null;
  for (const s of track.samples) {
    if (!s.keyframe) continue;
    // prev 不得早于上一保留段的结尾，否则输出内容会重叠
    if (s.cts <= t - 0.5 && s.cts >= lo - 0.5) prev = s.cts / ts;
    if (s.cts >= t + 0.5 && next === null) next = s.cts / ts;
  }
  return { prev, next };
}

// 音频段：起点对齐到帧，数量由累计漂移反馈决定（在 finalizeAudio 中统一重算）
function audioWindow(track       , startSec        , endSec        )                                  {
  const ts = track.timescale;
  const startTs = startSec * ts;
  const endTs = endSec * ts;
  let from = -1;
  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i];
    if (s.cts + s.duration > startTs + 0.5) { from = i; break; }
  }
  if (from < 0) return { from: 0, avail: 0 };
  let avail = 0;
  for (let i = from; i < track.samples.length; i++) {
    const s = track.samples[i];
    if (s.cts + s.duration <= endTs + 0.5) avail++;
    else break;
  }
  return { from, avail };
}

function videoTrackOf(movie       )        {
  const t = movie.tracks.find((t) => t.kind === "video");
  if (!t) throw new Error("未找到视频轨");
  return t;
}

function audioTrackOf(movie       )               {
  return movie.tracks.find((t) => t.kind === "audio") ?? null;
}

export function buildPlan(movie       , deletions         )          {
  const vt = videoTrackOf(movie);
  const durationSec = movie.duration / movie.timescale;
  const keeps = keepRanges(deletions, durationSec);
  const plan          = {
    segments: [],
    finalDuration: 0,
    fullyLossless: false,
    pendingCount: 0,
    avDriftMaxSec: 0,
    notes: [],
  };
  keeps.forEach((k, i) => {
    const vr = videoRange(vt, k.start, k.end);
    const seg              = {
      index: i,
      reqStart: k.start,
      reqEnd: k.end,
      start: vr.startExact,
      end: k.end,
      mode: "lossless",
      snapOptions: null,
      videoFrom: vr.from,
      videoTo: vr.to,
      audioFrom: 0,
      audioTo: 0,
      videoDurSec: 0,
      audioDurSec: 0,
      dropped: false,
      notes: [],
    };
    if (vr.to <= vr.from) {
      seg.dropped = true;
      seg.notes.push("保留区间不足一帧，整段丢弃");
    } else {
      if (!vr.aligned) seg.notes.push(`起点不在帧边界，已对齐到 ${seg.start.toFixed(3)}s`);
      if (!vr.keyframe) {
        seg.mode = "pending";
        const lowerBound = i > 0 ? keeps[i - 1].end : 0;
        seg.snapOptions = keyframeSnaps(vt, k.start, lowerBound);
        seg.notes.push("起点不是关键帧：需选择吸附到关键帧（无损）或转码该段");
      }
      if (vr.tailDropped > EPS) {
        seg.notes.push(`片尾不足一帧（${(vr.tailDropped * 1000).toFixed(1)}ms），已丢弃残帧`);
      }
    }
    plan.segments.push(seg);
  });
  finalize(movie, plan);
  return plan;
}

// 用户确认某个待定段的处理方式
export function resolveSegment(
  movie       ,
  plan         ,
  segIndex        ,
  choice                                         ,
)       {
  const vt = videoTrackOf(movie);
  const seg = plan.segments[segIndex];
  if (!seg || seg.mode !== "pending") return;
  if (choice === "transcode") {
    seg.mode = "transcode";
    seg.notes.push("该段视频将用 WebCodecs 重新编码（仅该段有损）");
  } else {
    const target = choice === "snap-prev" ? seg.snapOptions?.prev : seg.snapOptions?.next;
    if (target == null) return;
    const vr = videoRange(vt, target, seg.reqEnd);
    seg.start = vr.startExact;
    seg.videoFrom = vr.from;
    seg.videoTo = vr.to;
    seg.mode = "lossless";
    seg.notes.push(`起点已吸附到关键帧 ${target.toFixed(3)}s（无损）`);
    if (vr.to <= vr.from) {
      seg.dropped = true;
      seg.notes.push("吸附后区间不足一帧，整段丢弃");
    }
  }
  finalize(movie, plan);
}

// 重算每段时长、音频帧数（累计漂移反馈）、总时长与无损标记
function finalize(movie       , plan         )       {
  const vt = videoTrackOf(movie);
  const at = audioTrackOf(movie);
  let drift = 0; // 音频相对视频的累计超前量（秒）
  let driftMax = 0;
  let total = 0;
  let pending = 0;
  let lossless = true;
  for (const seg of plan.segments) {
    if (seg.dropped) continue;
    if (seg.mode === "pending") { pending++; lossless = false; }
    if (seg.mode === "transcode") lossless = false;
    let vDur = 0;
    for (let i = seg.videoFrom; i < seg.videoTo; i++) vDur += vt.samples[i].duration;
    seg.videoDurSec = vDur / vt.timescale;
    total += seg.videoDurSec;
    if (at) {
      const win = audioWindow(at, seg.start, seg.end);
      const frameDur = at.samples.length ? at.samples[0].duration / at.timescale : 0;
      let n = frameDur > 0 ? Math.round((seg.videoDurSec - drift) / frameDur) : 0;
      n = Math.max(0, Math.min(n, win.avail));
      seg.audioFrom = win.from;
      seg.audioTo = win.from + n;
      seg.audioDurSec = n * frameDur;
      drift += seg.audioDurSec - seg.videoDurSec;
      driftMax = Math.max(driftMax, Math.abs(drift));
    }
  }
  plan.finalDuration = total;
  plan.pendingCount = pending;
  plan.fullyLossless = lossless && pending === 0;
  plan.avDriftMaxSec = driftMax;
  if (driftMax > EPS) {
    plan.notes = [`音画时间基不同，拼接后最大累计偏差 ${(driftMax * 1000).toFixed(2)}ms（已逐段补偿）`];
  } else {
    plan.notes = [];
  }
}
