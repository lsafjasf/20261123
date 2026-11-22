import type {
  AudioFingerprint,
  Candidate,
  CandidateEvidence,
  MatchProposal,
  MediaRef,
  RankedCandidate,
  SignalScore
} from "./types.js";

const weights = {
  filename: 0.08,
  duration: 0.24,
  params: 0.2,
  hash: 0.28,
  audio: 0.12,
  visual: 0.08
};

const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);

function normalizeFilename(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function scoreSignal(weight: number, score: number | null, detail: string): SignalScore {
  return { available: score != null, score, weight, detail };
}

function durationEvidence(ref: MediaRef, candidate: Candidate): SignalScore {
  if (ref.duration == null || candidate.duration == null) {
    return scoreSignal(weights.duration, null, "参考时长或候选时长未知");
  }
  const delta = Math.abs(ref.duration - candidate.duration);
  const tolerance = Math.max(0.3, Math.min(4, ref.duration * 0.04));
  let score: number;
  if (delta <= 0.1) score = 1;
  else if (delta > tolerance * 2) score = 0;
  else score = Math.max(0, 1 - (delta - 0.1) / (tolerance * 2 - 0.1));
  return scoreSignal(
    weights.duration,
    Number(score.toFixed(4)),
    `${ref.duration.toFixed(2)}s vs ${candidate.duration.toFixed(2)}s · Δ${delta.toFixed(2)}s`
  );
}

function approximate(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function paramsEvidence(ref: MediaRef, candidate: Candidate): SignalScore {
  const checks: Array<{ label: string; score: number; weight: number; mismatch: boolean }> = [];
  if (ref.width != null && candidate.width != null && ref.height != null && candidate.height != null) {
    const direct = ref.width === candidate.width && ref.height === candidate.height;
    const rotated = ref.width === candidate.height && ref.height === candidate.width;
    checks.push({
      label: "尺寸",
      score: direct ? 1 : rotated ? 0.82 : 0,
      weight: 3,
      mismatch: !direct && !rotated
    });
  }
  if (ref.fps != null && candidate.fps != null) {
    checks.push({
      label: "帧率",
      score: approximate(ref.fps, candidate.fps, 0.06) ? 1 : 0,
      weight: 1.5,
      mismatch: !approximate(ref.fps, candidate.fps, 0.06)
    });
  }
  if (ref.audioChannels != null && candidate.audioChannels != null) {
    checks.push({
      label: "声道",
      score: ref.audioChannels === candidate.audioChannels ? 1 : 0,
      weight: 0.8,
      mismatch: ref.audioChannels !== candidate.audioChannels
    });
  }
  if (ref.sampleRate != null && candidate.sampleRate != null) {
    checks.push({
      label: "采样率",
      score: ref.sampleRate === candidate.sampleRate ? 1 : 0,
      weight: 0.8,
      mismatch: ref.sampleRate !== candidate.sampleRate
    });
  }
  if (ref.videoCodec && candidate.videoCodec) {
    checks.push({
      label: "视频编码",
      score: ref.videoCodec === candidate.videoCodec ? 1 : 0,
      weight: 1,
      mismatch: ref.videoCodec !== candidate.videoCodec
    });
  }
  if (ref.audioCodec && candidate.audioCodec) {
    checks.push({
      label: "音频编码",
      score: ref.audioCodec === candidate.audioCodec ? 1 : 0,
      weight: 0.7,
      mismatch: ref.audioCodec !== candidate.audioCodec
    });
  }
  if (checks.length === 0) return scoreSignal(weights.params, null, "工程未提供可比较的媒体参数");
  const availableWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const rawScore = checks.reduce((sum, check) => sum + check.score * check.weight, 0) / availableWeight;
  const mismatchCount = checks.filter((check) => check.mismatch).length;
  const summary = checks.map((check) => `${check.label}${check.mismatch ? "✕" : "✓"}`).join(" ");
  return scoreSignal(weights.params, Number(rawScore.toFixed(4)), summary);
}

function decodeAudioFingerprint(input: AudioFingerprint): number[] | null {
  try {
    const binary = atob(input.data);
    const values: number[] = [];
    for (const char of binary) {
      const value = char.charCodeAt(0);
      values.push(value >> 4, value & 0x0f);
    }
    return values;
  } catch {
    return null;
  }
}

export function audioSimilarity(left: AudioFingerprint | undefined, right: AudioFingerprint | undefined): number | null {
  if (!left || !right) return null;
  if (left.data === right.data) return 1;
  if (left.frames !== right.frames || left.bands !== right.bands) return 0;
  const a = decodeAudioFingerprint(left);
  const b = decodeAudioFingerprint(right);
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference += Math.abs(a[index] - b[index]);
  return Math.max(0, 1 - difference / (a.length * 15));
}

function countSetBits(value: number): number {
  let count = 0;
  let number = value;
  while (number) {
    number &= number - 1;
    count += 1;
  }
  return count;
}

export function visualSimilarity(left: string | undefined, right: string | undefined): number | null {
  if (!left || !right) return null;
  if (left === right) return 1;
  if (left.length !== right.length || left.length % 8 !== 0) return 0;
  let distance = 0;
  for (let index = 0; index < left.length; index += 8) {
    const a = Number.parseInt(left.slice(index, index + 8), 16);
    const b = Number.parseInt(right.slice(index, index + 8), 16);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    distance += countSetBits((a ^ b) >>> 0);
  }
  return Math.max(0, 1 - distance / (left.length * 4));
}

function audioEvidence(ref: MediaRef, candidate: Candidate): SignalScore {
  const similarity = audioSimilarity(ref.audioFingerprint, candidate.audioFingerprint);
  if (similarity == null) return scoreSignal(weights.audio, null, "没有参考短音频指纹");
  return scoreSignal(
    weights.audio,
    Number(similarity.toFixed(4)),
    similarity === 1 ? "短音频指纹一致" : `短音频相似度 ${(similarity * 100).toFixed(1)}%`
  );
}

function visualEvidence(ref: MediaRef, candidate: Candidate): SignalScore {
  const similarity = visualSimilarity(ref.visualHash, candidate.visualHash);
  if (similarity == null) return scoreSignal(weights.visual, null, "没有参考画面指纹");
  return scoreSignal(
    weights.visual,
    Number(similarity.toFixed(4)),
    similarity === 1 ? "画面指纹一致" : `画面相似度 ${(similarity * 100).toFixed(1)}%`
  );
}

export function scoreCandidate(ref: MediaRef, candidate: Candidate): RankedCandidate {
  const exactName = normalizeFilename(ref.filename) === normalizeFilename(candidate.name);
  const filename = scoreSignal(weights.filename, exactName ? 1 : 0, exactName ? "文件名完全一致" : "文件名不同");
  const duration = durationEvidence(ref, candidate);
  const params = paramsEvidence(ref, candidate);
  const hashAvailable = Boolean(ref.sha256 && candidate.sha256);
  const hashMatch = hashAvailable && ref.sha256?.toLowerCase() === candidate.sha256?.toLowerCase();
  const hash = scoreSignal(
    weights.hash,
    hashAvailable ? (hashMatch ? 1 : 0) : null,
    hashAvailable
      ? hashMatch
        ? `SHA-256 ${candidate.sha256?.slice(0, 12)}… 完全一致`
        : "SHA-256 不一致"
      : "没有参考内容哈希"
  );
  const audio = audioEvidence(ref, candidate);
  const visual = visualEvidence(ref, candidate);
  const signals = { filename, duration, params, hash, audio, visual };
  const availableWeight = Object.values(signals)
    .filter((signal) => signal.available)
    .reduce((sum, signal) => sum + signal.weight, 0);
  const weighted = Object.values(signals)
    .filter((signal) => signal.available && signal.score != null)
    .reduce((sum, signal) => sum + signal.weight * (signal.score ?? 0), 0);
  const coverage = availableWeight / totalWeight;
  const evidence: CandidateEvidence = { ...signals, coverage };
  let score = availableWeight > 0 ? weighted / availableWeight : 0;
  score *= 0.68 + 0.32 * coverage;
  const flags: string[] = [];
  if (duration.available && (duration.score ?? 0) < 0.4) flags.push("时长差异大");
  if (params.available && (params.score ?? 0) < 0.55) flags.push("媒体参数不符");
  if (hash.available && (hash.score ?? 0) < 1) flags.push("哈希冲突");
  if (hash.available && hash.score === 1) score = Math.max(score, 0.99);
  if (hash.available && hash.score === 0) score = Math.min(score, 0.42);
  if (!exactName) score = Math.min(score, 0.6);
  return { candidate, score: Number(score.toFixed(4)), evidence, flags };
}

export function rankCandidates(ref: MediaRef, candidates: Candidate[]): RankedCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(ref, candidate))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftDelta = Math.abs((left.candidate.duration ?? 0) - (ref.duration ?? 0));
      const rightDelta = Math.abs((right.candidate.duration ?? 0) - (ref.duration ?? 0));
      return leftDelta - rightDelta;
    });
}

function strongMetadata(ranked: RankedCandidate): boolean {
  const { duration, params, filename } = ranked.evidence;
  return (filename.score ?? 0) === 1
    && duration.available
    && (duration.score ?? 0) >= 0.97
    && params.available
    && (params.score ?? 0) >= 0.95
    && ranked.flags.length === 0;
}

export function proposeMatch(ref: MediaRef, candidates: Candidate[]): MatchProposal {
  const ranked = rankCandidates(ref, candidates);
  if (ranked.length === 0) {
    return {
      ref,
      decision: "missing",
      ranked,
      selectedPath: null,
      reason: "新盘中没有同名文件",
      confidence: 0
    };
  }
  const top = ranked[0];
  const second = ranked[1];
  const exactHash = top.evidence.hash.available && top.evidence.hash.score === 1;
  const exactAudioVisual = top.evidence.audio.available
    && (top.evidence.audio.score ?? 0) >= 0.995
    && top.evidence.visual.available
    && (top.evidence.visual.score ?? 0) >= 0.985;

  if (exactHash && (!second || second.evidence.hash.score !== 1)) {
    return {
      ref,
      decision: "auto",
      ranked,
      selectedPath: top.candidate.path,
      reason: "SHA-256 与参考素材完全一致",
      confidence: top.score
    };
  }

  if (ranked.length === 1 && strongMetadata(top)) {
    return {
      ref,
      decision: "auto",
      ranked,
      selectedPath: top.candidate.path,
      reason: "唯一同名候选；时长与媒体参数一致",
      confidence: top.score
    };
  }

  if (ranked.length > 1 && exactAudioVisual && top.score >= 0.9 && top.score - (second?.score ?? 0) >= 0.08) {
    return {
      ref,
      decision: "auto",
      ranked,
      selectedPath: top.candidate.path,
      reason: "短音频与画面指纹均一致，且排序领先",
      confidence: top.score
    };
  }

  let reason = "存在多个同名候选，需要人工确认";
  if (ranked.length === 1) reason = "候选证据不完整，需要人工确认";
  else if (!top.evidence.hash.available && !top.evidence.audio.available) {
    reason = "只有文件名与元数据，无法排除同名手机视频";
  } else if (top.score - (second?.score ?? 0) < 0.08) {
    reason = "候选得分接近，不能安全自动选择";
  }
  return {
    ref,
    decision: "review",
    ranked,
    selectedPath: top.candidate.path,
    reason,
    confidence: top.score
  };
}

export function candidatesForRef(ref: MediaRef, candidates: Candidate[]): Candidate[] {
  const wanted = normalizeFilename(ref.filename);
  return candidates.filter((candidate) => normalizeFilename(candidate.name) === wanted);
}
