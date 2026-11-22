import { analyzeFrames, clamp, dbFromAmplitude, median, percentile } from "./dsp.js";
             
                 
                 
              
                
            
               
           
             
           
                    

                 
                
              
                         
 

const DEFAULT_CONFIG                 = {
  frameSize: 1024,
  hopSize: 256,
  policy: 0.55,
  minEventMs: 70,
  mergeGapMs: 85,
};

function medianFilter(frames                , radius        )                 {
  return frames.map((frame, index) => {
    const from = Math.max(0, index - radius);
    const to = Math.min(frames.length, index + radius + 1);
    const values = frames.slice(from, to).map((item) => item.rmsDb);
    return { ...frame, rmsDb: median(values) };
  });
}

function groupFrames(
  frames                ,
  predicate                                  ,
  hopSize        ,
  sampleRate        ,
  mergeGapMs        ,
)          {
  const groups          = [];
  const gapSamples = Math.max(hopSize * 2, Math.round((mergeGapMs / 1000) * sampleRate));
  let current                 = [];
  const flush = () => {
    if (current.length) groups.push({ start: current[0].start, end: current.at(-1) .end, frames: current });
    current = [];
  };
  for (const frame of frames) {
    if (predicate(frame)) {
      if (current.length && frame.start - current.at(-1) .end > gapSamples) flush();
      current.push(frame);
    } else if (current.length && frame.end - current.at(-1) .end > gapSamples) {
      flush();
    }
  }
  flush();
  return groups;
}

function mergeSpans(spans            , gapSamples        )             {
  const merged             = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start - last.end <= gapSamples) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function distanceToSpan(start        , end        , spans            )         {
  let distance = Infinity;
  for (const span of spans) {
    if (end >= span.start && start <= span.end) return 0;
    distance = Math.min(distance, span.start > end ? span.start - end : start - span.end);
  }
  return distance;
}

function average(frames                , key                    )         {
  if (frames.length === 0) return 0;
  return frames.reduce((sum, frame) => sum + Number(frame[key]), 0) / frames.length;
}

function deriveSpeech(frames                , floorDb        , sampleRate        )             {
  const raw             = [];
  for (const frame of frames) {
    const strong = frame.rmsDb > floorDb + 7.5;
    const harmonic = frame.flatness < 0.27 && frame.voiceRatio > 0.42;
    const loudVoice = frame.rmsDb > floorDb + 15 && frame.flatness < 0.36 && frame.lowRatio < 0.82;
    if (strong && (harmonic || loudVoice) && !(frame.lowRatio > 0.88 && frame.crest > 2.2)) {
      frame.voiced = true;
      raw.push({ start: frame.start, end: frame.end });
    }
  }
  return mergeSpans(raw, Math.round(sampleRate * 0.12)).filter(
    (span) => span.end - span.start > sampleRate * 0.05,
  );
}

function buildRoomWindows(
  frames                ,
  floorDb        ,
  speechSpans            ,
  eventSpans            ,
  sampleRate        ,
)               {
  const excluded = [...speechSpans, ...eventSpans];
  const quiet = frames.filter((frame) => {
    if (frame.rmsDb > floorDb + 2.5) return false;
    return !excluded.some((span) => frame.end > span.start && frame.start < span.end);
  });
  const groups = groupFrames(quiet, () => true, Math.max(1, Math.round(sampleRate * 0.0058)), sampleRate, 70);
  const windows               = [];
  for (const group of groups) {
    if (group.end - group.start < sampleRate * 0.08) continue;
    const sampleGap = Math.max(128, Math.round((group.end - group.start) * 0.25));
    windows.push({
      start: group.start + sampleGap,
      end: group.end - sampleGap,
      rmsDb: group.frames.reduce((sum, frame) => sum + frame.rmsDb, 0) / group.frames.length,
      score: 0,
    });
  }
  windows.sort((a, b) => b.end - b.start - (a.end - a.start));
  return windows.slice(0, 24).map((window, index) => ({
    ...window,
    score: 1 - (window.rmsDb - floorDb) - index / 200,
  }));
}

function nearestRoomWindow(eventStart        , eventEnd        , windows              )         {
  let best = -1;
  let bestDistance = Infinity;
  windows.forEach((window, index) => {
    const distance = Math.abs((window.start + window.end) / 2 - (eventStart + eventEnd) / 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

function localFloorFor(
  frames                ,
  start        ,
  end        ,
  globalFloor        ,
  sampleRate        ,
)         {
  const before = frames.filter((frame) => frame.end < start && frame.end > start - sampleRate * 0.6);
  const after = frames.filter((frame) => frame.start > end && frame.start < end + sampleRate * 0.6);
  const pool = [...before, ...after].filter((frame) => !frame.voiced && frame.rmsDb < globalFloor + 9);
  if (pool.length < 4) return globalFloor;
  return percentile(Float64Array.from(pool.map((frame) => frame.rmsDb)), 0.35);
}

function classifyBreath(
  group       ,
  localFloorDb        ,
  distanceSamples        ,
  sampleRate        ,
  policy        ,
  harmonicity        ,
)                                                             {
  const durationMs = ((group.end - group.start) / sampleRate) * 1000;
  const rmsDb = average(group.frames, "rmsDb");
  const peakDb = average(group.frames, "peakDb");
  const strength = rmsDb - localFloorDb;
  const distanceMs = (distanceSamples / sampleRate) * 1000;
  let emotionalScore = 0;
  const reasons           = [];

  if (durationMs > 520) {
    emotionalScore += 0.28;
    reasons.push(`持续 ${Math.round(durationMs)} ms，超过普通气口长度`);
  } else if (durationMs < 280) {
    reasons.push(`短促 ${Math.round(durationMs)} ms，更接近换气余音`);
  }
  if (distanceMs < 160) {
    emotionalScore += 0.25;
    reasons.push(`起点距语句仅 ${Math.round(distanceMs)} ms`);
  } else {
    reasons.push(`位于语句间隙 ${Math.round(distanceMs)} ms`);
  }
  if (strength > 16) {
    emotionalScore += 0.18;
    reasons.push(`比局部底噪高 ${strength.toFixed(1)} dB`);
  }
  if (peakDb > -13) {
    emotionalScore += 0.12;
    reasons.push("峰值贴近朗读动态，可能承载语气");
  }
  if (harmonicity < 0.31) {
    emotionalScore += 0.1;
    reasons.push("含少量声带成分，并非纯气流噪声");
  }
  const threshold = 0.5 - (policy - 0.5) * 0.3;
  if (emotionalScore >= threshold) {
    reasons.unshift("判定为情绪呼吸，默认保留");
    return {
      kind: "emotional",
      confidence: clamp(0.6 + (emotionalScore - threshold) * 0.7, 0.6, 0.97),
      reasons,
    };
  }
  reasons.unshift("判定为可清理气口，默认缩短");
  return {
    kind: "clean",
    confidence: clamp(0.66 + (threshold - emotionalScore) * 0.8, 0.66, 0.98),
    reasons,
  };
}

function makeEvent(
  id        ,
  group       ,
  kind           ,
  confidence        ,
  reasons          ,
  speechSpans            ,
  sampleRate        ,
  globalFloor        ,
  windows              ,
  frames                ,
)              {
  const start = Math.round(group.start);
  const end = Math.round(group.end);
  const localFloorDb = localFloorFor(frames, start, end, globalFloor, sampleRate);
  const noiseLikeness = clamp(average(group.frames, "flatness") * 1.35, 0.05, 0.99);
  const evidence                = {
    rmsDb: average(group.frames, "rmsDb"),
    peakDb: average(group.frames, "peakDb"),
    noiseLikeness,
    lowBandRatio: average(group.frames, "lowRatio"),
    distanceToSpeechMs: (distanceToSpan(start, end, speechSpans) / sampleRate) * 1000,
    crest: average(group.frames, "crest"),
    durationMs: ((end - start) / sampleRate) * 1000,
    localFloorDb,
    seamRmsDb: localFloorDb,
  };
  const autoAction = kind === "clean" ? "shorten" : kind === "impulse" ? "attenuate" : "keep";
  return {
    id,
    start,
    end,
    kind,
    confidence,
    autoKind: kind,
    action: autoAction,
    autoAction,
    manualKind: null,
    note: "",
    evidence,
    reasons,
    roomWindowIndex: nearestRoomWindow(start, end, windows),
  };
}

export function analyzeAudio(pcm          , partialConfig                          = {})                 {
  const config                 = { ...DEFAULT_CONFIG, ...partialConfig };
  const rawFrames = analyzeFrames(pcm, config.frameSize, config.hopSize);
  const smoothFrames = medianFilter(rawFrames, 2);
  const floorDb = percentile(Float64Array.from(smoothFrames.map((frame) => frame.rmsDb)), 0.18);
  const speechSpans = deriveSpeech(smoothFrames, floorDb, pcm.sampleRate);
  const effectiveHop = config.hopSize;

  const lowCandidates = groupFrames(
    smoothFrames,
    (frame) => {
      const insideVoicedSpeech = speechSpans.some(
        (span) => frame.start < span.end && frame.end > span.start,
      );
      return (
        !insideVoicedSpeech &&
        frame.rmsDb > floorDb + 6 &&
        frame.lowRatio > 0.7 &&
        frame.crest > 1.85 &&
        frame.flatness < 0.34
      );
    },
    effectiveHop,
    pcm.sampleRate,
    config.mergeGapMs,
  ).filter((group) => {
    const durationMs = ((group.end - group.start) / pcm.sampleRate) * 1000;
    const lowDominance = average(group.frames, "lowRatio");
    return durationMs >= 35 && durationMs <= 260 && lowDominance > 0.78;
  });

  const lowSpans = lowCandidates.map((group) => ({ start: group.start, end: group.end }));
  const speechGuard = speechSpans.filter((span) => span.end - span.start > pcm.sampleRate * 0.22);
  const breathCandidates = groupFrames(
    smoothFrames,
    (frame) => {
      const active = frame.rmsDb > floorDb + 3.2;
      const noisy = frame.flatness > 0.2 || frame.highRatio > 0.34 || frame.voiceRatio < 0.58;
      const notLow = frame.lowRatio < 0.6 || frame.flatness > 0.42;
      return active && noisy && notLow;
    },
    effectiveHop,
    pcm.sampleRate,
    config.mergeGapMs,
  ).filter((group) => {
    const durationMs = ((group.end - group.start) / pcm.sampleRate) * 1000;
    if (durationMs < config.minEventMs || durationMs > 1900) return false;
    const hasBreathNoise =
      average(group.frames, "flatness") > 0.16 || average(group.frames, "highRatio") > 0.18;
    if (!hasBreathNoise) return false;
    const overlap = lowSpans.some((span) => group.start < span.end && group.end > span.start);
    if (overlap) return false;
    const speechOverlap = speechGuard.reduce(
      (sum, span) => sum + Math.max(0, Math.min(group.end, span.end) - Math.max(group.start, span.start)),
      0,
    );
    return speechOverlap / Math.max(1, group.end - group.start) < 0.42;
  });

  const eventSpans = [...lowSpans, ...breathCandidates.map((group) => ({ start: group.start, end: group.end }))];
  const roomWindows = buildRoomWindows(smoothFrames, floorDb, speechSpans, eventSpans, pcm.sampleRate);
  const events                = [];

  for (const group of lowCandidates) {
    const reasons = [
      "判定为低频冲激，默认轻度降低",
      `低频能量占比 ${(average(group.frames, "lowRatio") * 100).toFixed(0)}%`,
      `瞬态峰值/均值 ${average(group.frames, "crest").toFixed(1)}×`,
      `持续 ${Math.round(((group.end - group.start) / pcm.sampleRate) * 1000)} ms，未整段删除`,
    ];
    events.push(
      makeEvent(
        `imp-${events.length + 1}`,
        group,
        "impulse",
        clamp(0.72 + average(group.frames, "lowRatio") * 0.22, 0.72, 0.96),
        reasons,
        speechSpans,
        pcm.sampleRate,
        floorDb,
        roomWindows,
        rawFrames,
      ),
    );
  }

  for (const group of breathCandidates) {
    const durationMs = ((group.end - group.start) / pcm.sampleRate) * 1000;
    const localFloor = localFloorFor(rawFrames, group.start, group.end, floorDb, pcm.sampleRate);
    const distance = distanceToSpan(group.start, group.end, speechSpans);
    const classification = classifyBreath(
      group,
      localFloor,
      distance,
      pcm.sampleRate,
      config.policy,
      average(group.frames, "flatness"),
    );
    events.push(
      makeEvent(
        `br-${events.length + 1}`,
        group,
        classification.kind,
        classification.confidence,
        classification.reasons,
        speechSpans,
        pcm.sampleRate,
        floorDb,
        roomWindows,
        rawFrames,
      ),
    );
    const event = events.at(-1) ;
    event.reasons.push(`底噪源窗口 ${event.roomWindowIndex + 1} · 局部底噪 ${localFloor.toFixed(1)} dBFS`);
  }

  events.sort((a, b) => a.start - b.start);
  events.forEach((event, index) => {
    const prefix = event.kind === "impulse" ? "IMP" : "BR";
    event.id = `${prefix}-${String(index + 1).padStart(2, "0")}`;
  });

  const peak = pcm.channels.reduce((max, channel) => {
    for (let index = 0; index < channel.length; index += 1) max = Math.max(max, Math.abs(channel[index]));
    return max;
  }, 0);

  return {
    sampleRate: pcm.sampleRate,
    length: pcm.length,
    duration: pcm.length / pcm.sampleRate,
    channelCount: pcm.channels.length,
    peakDb: dbFromAmplitude(peak),
    noiseFloorDb: floorDb,
    frames: smoothFrames,
    events,
    speechSpans,
    roomWindows,
    analyzedAt: Date.now(),
    config,
  };
}
