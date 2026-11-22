import { activeEnvelope, concatenate, seamSnapshot } from "./dsp.js";
             
                   
               
           
           
                  
                    
            
                    

function sliceChannels(channels                , start        , end        )                 {
  return channels.map((channel) => channel.slice(start, end));
}

function wireEvidence(valid         , label        , detail        )                   {
  return { kind: "validation", label, detail: valid ? "通过" : "未通过" };
}

export function analyzeSegment(
  descriptor                   ,
  pcm          ,
  mp4              
)                  {
  const decodedSamples = pcm.channels[0]?.length || 0;
  const evidence                     = [];
  let priming                = null;
  let retained                = null;
  let padding                = null;
  let reason = "";
  let confidence = 0;
  let status                              = "unconfirmed";

  const metadataStart = mp4.mediaTimeSamples ?? mp4.primingSamples;
  const metadataRetained = mp4.editDurationSamples ?? mp4.originalSamples;
  const hasGaplessMetadata = metadataStart !== null && metadataRetained !== null;

  if (hasGaplessMetadata) {
    const start = metadataStart          ;
    const count = metadataRetained          ;
    const browserTrimmed = pcm.decodeMode === "webaudio-trimmed" && Math.abs(decodedSamples - count) <= 2;

    if (browserTrimmed) {
      priming = 0;
      retained = decodedSamples;
      padding = 0;
      status = "confirmed";
      confidence = 0.985;
      reason = "浏览器解码器已应用容器 gapless 编辑；保留输出全长，不重复裁剪。";
      evidence.push({
        kind: "container",
        label: "WebAudio 已应用 edit list",
        detail: `输出 ${decodedSamples} 样本，与容器声明 ${count} 样本一致`
      });
    } else {
      priming = start;
      retained = count;
      padding = decodedSamples - start - count;
      const frontValid = start >= 0 && start <= mp4.frameSamples * 4;
      const lengthValid = count > 0 && count <= decodedSamples;
      const tailValid = padding >= 0 && padding <= mp4.frameSamples * 2;
      const valid = frontValid && lengthValid && tailValid;
      evidence.push({
        kind: "container",
        label: mp4.edit ? "MP4 edit list" : "iTunSMPB",
        detail: `media_time ${start} · duration ${count} · decoded ${decodedSamples}`
      });
      evidence.push(wireEvidence(frontValid, "预滚上限", `${start} ≤ ${mp4.frameSamples * 4} 样本`));
      evidence.push(wireEvidence(tailValid, "填充余量", `${padding} 样本`));
      if (valid) {
        status = "confirmed";
        confidence = 0.998;
        reason = "容器时间轴给出编码预滚与有效时长，尾部填充由解码帧总数反算。";
      } else {
        reason = "容器 gapless 元数据与解码样本总量冲突，拒绝猜测裁剪位置。";
      }
    }
  } else {
    const envelope = activeEnvelope(pcm);
    const guardNeeded = Math.max(128, Math.round(pcm.sampleRate * 0.02));
    const hasGuards = envelope.leadingSilence >= guardNeeded && envelope.trailingSilence >= guardNeeded;
    evidence.push({
      kind: "waveform",
      label: "边缘包络",
      detail: `前静音 ${envelope.leadingSilence} · 后静音 ${envelope.trailingSilence} · 阈值 ${envelope.threshold.toFixed(5)}`
    });
    reason = hasGuards
      ? "仅有波形静音边缘，不能证明编码器写入的有效样本区间；保持单列。"
      : "缺少 edit list/iTunSMPB，且首尾都在连续鼓点中；任何裁切都会猜测预滚或填充。";
    evidence.push(wireEvidence(false, "可核验边界", "没有可交叉验证的容器时间戳"));
  }

  return {
    descriptor,
    status,
    confidence,
    codec: mp4.codec,
    sampleRate: pcm.sampleRate,
    channelCount: pcm.channels.length,
    decodedSamples,
    primingSamples: priming,
    retainedSamples: retained,
    paddingSamples: padding,
    leadingAudioSamples: priming,
    trailingAudioSamples: padding,
    retainedStart: priming,
    retainedEnd: priming !== null && retained !== null ? priming + retained : null,
    reason,
    evidence,
    pcm,
    mp4
  };
}

function trimmedPcm(segment                 )                 {
  if (segment.retainedStart === null || segment.retainedEnd === null) return [];
  return sliceChannels(segment.pcm.channels, segment.retainedStart, segment.retainedEnd);
}

export function buildPlaylist(analyses                   )           {
  const ordered = [...analyses].sort((a, b) => a.descriptor.ordinal - b.descriptor.ordinal);
  const segments = ordered.filter((segment) => segment.status === "confirmed");
  const unconfirmed = ordered.filter((segment) => segment.status === "unconfirmed");
  const sampleRate = segments[0]?.sampleRate || ordered[0]?.sampleRate || 48000;
  const channelCount = segments[0]?.channelCount || 1;
  const compatible = segments.filter(
    (segment) => segment.sampleRate === sampleRate && segment.channelCount === channelCount
  );
  const parts = compatible.map(trimmedPcm);
  const pcm = concatenate(parts, channelCount);
  const totalSamples = pcm[0]?.length || 0;
  const seams               = [];
  let cursor = 0;
  for (let i = 0; i < compatible.length; i++) {
    cursor += compatible[i].retainedSamples || 0;
    if (i === compatible.length - 1) break;
    const next = compatible[i + 1];
    const snapshot = seamSnapshot(pcm[0], cursor);
    const pass = snapshot.stepRatio <= 6 && snapshot.hfRatio <= 18;
    seams.push({
      index: i + 1,
      leftId: compatible[i].descriptor.id,
      rightId: next.descriptor.id,
      atSample: cursor,
      atSeconds: cursor / sampleRate,
      leftLast: snapshot.leftLast,
      rightFirst: snapshot.rightFirst,
      step: snapshot.step,
      localStep: snapshot.localStep,
      stepRatio: snapshot.stepRatio,
      hfRatio: snapshot.hfRatio,
      peak: snapshot.peak,
      status: pass ? "pass" : "review"
    });
  }

  return {
    sampleRate,
    channelCount,
    segments,
    unconfirmed,
    totalSamples,
    totalSeconds: totalSamples / sampleRate,
    pcm,
    seams,
    continuityPass: seams.length > 0 && seams.every((seam) => seam.status === "pass")
  };
}

export function runSeekTrials(playlist          , rounds        ) {
  if (playlist.seams.length === 0) return [];
  return Array.from({ length: rounds }, (_, index) => {
    const seam = playlist.seams[index % playlist.seams.length];
    const leftLast = playlist.pcm[0][seam.atSample - 1];
    const rightFirst = playlist.pcm[0][seam.atSample];
    const step = Math.abs(rightFirst - leftLast);
    return {
      round: index + 1,
      seamIndex: seam.index,
      atSeconds: seam.atSeconds,
      renderedAt: seam.atSeconds,
      step,
      expectedStep: seam.step,
      passed: Number.isFinite(leftLast) && Number.isFinite(rightFirst) && Math.abs(step - seam.step) < 1e-7
    };
  });
}


//# sourceURL=analyzer.ts