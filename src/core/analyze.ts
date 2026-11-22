import { identifyTrack } from './identify.ts';
import { measureLoudness } from './loudness.ts';
import { scanSilence } from './silence.ts';
import {
  DEFAULT_THRESHOLDS,
  TRACK_LABELS,
  type AnalysisReport,
  type Anomaly,
  type DecodedTrack,
  type QcThresholds,
  type TrackMatrixRow,
} from './types.ts';

export interface PreparedTrack extends DecodedTrack {
  confidence: number;
  identifyReasons: string[];
}

/** Identify every decoded track and attach confidence metadata. */
export function prepareTracks(tracks: DecodedTrack[]): PreparedTrack[] {
  return tracks.map((track) => {
    const hasContent = track.pcm.channels[0].some((sample) => Math.abs(sample) > 0.0001);
    const result = identifyTrack(track.fileName, track.channelCount, hasContent);
    return { ...track, kind: result.kind, confidence: result.confidence, identifyReasons: result.reasons };
  });
}

function pushAnomaly(
  list: Anomaly[],
  code: string,
  severity: Anomaly['severity'],
  track: string,
  message: string,
  detail?: Anomaly['detail'],
  atSec?: number,
): void {
  list.push({ code, severity, track, message, ...(atSec !== undefined ? { atSec } : {}), ...(detail ? { detail } : {}) });
}

/** Run the complete QC pipeline over prepared tracks. */
export function analyzeTracks(
  tracks: PreparedTrack[],
  thresholds: QcThresholds = DEFAULT_THRESHOLDS,
): AnalysisReport {
  const anomalies: Anomaly[] = [];
  const rows: TrackMatrixRow[] = [];

  if (tracks.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      referenceDurationSec: null,
      targetIntegratedLufs: thresholds.targetIntegratedLufs,
      matrix: [],
      anomalies: [
        { code: 'NO_TRACKS', severity: 'error', track: '-', message: '未提供任何音频轨道' },
      ],
      loudnessDeltas: [],
    };
  }

  const referenceDuration = Math.max(...tracks.map((t) => t.durationSec));

  // 1. Role coverage checks: exactly one zh, one en, one music expected.
  const kinds = new Map<string, PreparedTrack[]>();
  for (const track of tracks) {
    const bucket = kinds.get(track.kind) ?? [];
    bucket.push(track);
    kinds.set(track.kind, bucket);
  }
  for (const expected of ['dialogue-zh', 'dialogue-en', 'music'] as const) {
    const bucket = kinds.get(expected) ?? [];
    if (bucket.length === 0) {
      pushAnomaly(anomalies, 'MISSING_TRACK', 'error', '-', `缺少必备轨道：${TRACK_LABELS[expected]}`);
    } else if (bucket.length > 1) {
      pushAnomaly(
        anomalies,
        'DUPLICATE_KIND',
        'warning',
        bucket.map((t) => t.fileName).join(', '),
        `${TRACK_LABELS[expected]} 存在 ${bucket.length} 条候选，请人工确认`,
      );
    }
  }
  for (const track of kinds.get('unknown') ?? []) {
    pushAnomaly(anomalies, 'UNKNOWN_KIND', 'warning', track.fileName, '轨道角色无法自动识别');
  }
  for (const track of tracks) {
    if (track.confidence < 0.6) {
      pushAnomaly(anomalies, 'LOW_CONFIDENCE', 'info', track.fileName,
        `识别为「${TRACK_LABELS[track.kind]}」可信度仅 ${track.confidence}：${track.identifyReasons.join('；')}`);
    }
  }

  // 2. Per-track loudness + silence analysis.
  const loudnessByFile = new Map<string, number>();
  for (const track of tracks) {
    const loudness = measureLoudness(track.pcm);
    loudnessByFile.set(track.fileName, loudness.integratedLufs);
    const silence = scanSilence(track.pcm, thresholds.silenceThresholdDbfs, thresholds.silenceWindowMs);

    if (!Number.isFinite(loudness.integratedLufs)) {
      pushAnomaly(anomalies, 'FULL_SILENCE', 'error', track.fileName, '整条轨道为静音或响度低于绝对门限');
    } else {
      const targetDelta = Math.abs(loudness.integratedLufs - thresholds.targetIntegratedLufs);
      if (targetDelta > thresholds.loudnessToleranceLu) {
        pushAnomaly(anomalies, 'LOUDNESS_TARGET', 'warning', track.fileName,
          `积分响度 ${loudness.integratedLufs.toFixed(1)} LUFS 偏离目标 ${thresholds.targetIntegratedLufs} LUFS 达 ${targetDelta.toFixed(1)} LU`,
          { integratedLufs: loudness.integratedLufs, targetLufs: thresholds.targetIntegratedLufs });
      }
    }
    if (loudness.truePeakDbfs > thresholds.truePeakCeilingDbfs) {
      pushAnomaly(anomalies, 'TRUE_PEAK', 'warning', track.fileName,
        `真实峰值 ${loudness.truePeakDbfs.toFixed(2)} dBTP 超过天花板 ${thresholds.truePeakCeilingDbfs} dBTP`,
        { truePeakDbfs: loudness.truePeakDbfs });
    }

    // Duration check against reference.
    const durationDelta = referenceDuration - track.durationSec;
    if (durationDelta > thresholds.durationToleranceSec) {
      pushAnomaly(anomalies, 'DURATION_SHORT', 'error', track.fileName,
        `时长 ${track.durationSec.toFixed(3)}s 比参考时长短 ${durationDelta.toFixed(3)}s`,
        { durationSec: track.durationSec, referenceDurationSec: referenceDuration });
    } else if (Math.abs(durationDelta) > thresholds.durationToleranceSec) {
      pushAnomaly(anomalies, 'DURATION_LONG', 'warning', track.fileName,
        `时长 ${track.durationSec.toFixed(3)}s 比参考时长长 ${Math.abs(durationDelta).toFixed(3)}s`);
    }

    // Sample rate consistency.
    if (track.sampleRate !== tracks[0].sampleRate) {
      pushAnomaly(anomalies, 'SAMPLE_RATE_MISMATCH', 'warning', track.fileName,
        `采样率 ${track.sampleRate} Hz 与首轨 ${tracks[0].sampleRate} Hz 不一致`);
    }

    // Tail silence: too long (dead tail) or too short (clipped short tail).
    if (silence.tailSilenceSec > thresholds.maxTailSilenceSec) {
      pushAnomaly(anomalies, 'TAIL_SILENCE_LONG', 'warning', track.fileName,
        `尾部静音 ${silence.tailSilenceSec.toFixed(3)}s 超过上限 ${thresholds.maxTailSilenceSec}s`,
        { tailSilenceSec: silence.tailSilenceSec },
        track.durationSec - silence.tailSilenceSec);
    } else if (silence.tailSilenceSec < thresholds.minTailSilenceSec && track.durationSec > 1) {
      pushAnomaly(anomalies, 'TAIL_SILENCE_SHORT', 'warning', track.fileName,
        `尾部静音仅 ${silence.tailSilenceSec.toFixed(3)}s，疑似短尾/被裁切（下限 ${thresholds.minTailSilenceSec}s）`,
        { tailSilenceSec: silence.tailSilenceSec },
        track.durationSec);
    }
    if (silence.headSilenceSec > thresholds.maxTailSilenceSec) {
      pushAnomaly(anomalies, 'HEAD_SILENCE_LONG', 'info', track.fileName,
        `开头静音 ${silence.headSilenceSec.toFixed(3)}s 过长`, { headSilenceSec: silence.headSilenceSec });
    }
    for (const range of silence.silentRanges) {
      const gap = range.endSec - range.startSec;
      if (gap > thresholds.maxTailSilenceSec) {
        pushAnomaly(anomalies, 'INTERIOR_SILENCE', 'info', track.fileName,
          `内部静音段 ${gap.toFixed(3)}s`, { startSec: range.startSec, endSec: range.endSec }, range.startSec);
      }
    }

    rows.push({
      fileName: track.fileName,
      kind: track.kind,
      label: TRACK_LABELS[track.kind],
      channelCount: track.channelCount,
      sampleRate: track.sampleRate,
      durationSec: track.durationSec,
      integratedLufs: Number.isFinite(loudness.integratedLufs) ? loudness.integratedLufs : -99,
      loudnessRange: loudness.loudnessRange,
      truePeakDbfs: Number.isFinite(loudness.truePeakDbfs) ? loudness.truePeakDbfs : -99,
      tailSilenceSec: silence.tailSilenceSec,
      headSilenceSec: silence.headSilenceSec,
      status: 'ok',
    });
  }

  // 3. Inter-track loudness differences against the loudest valid track.
  const validLoudness = [...loudnessByFile.entries()].filter(([, v]) => Number.isFinite(v));
  const loudnessDeltas: AnalysisReport['loudnessDeltas'] = [];
  if (validLoudness.length > 1) {
    const loudest = Math.max(...validLoudness.map(([, v]) => v));
    for (const track of tracks) {
      const value = loudnessByFile.get(track.fileName)!;
      if (!Number.isFinite(value)) continue;
      const delta = loudest - value; // positive = quieter than loudest
      loudnessDeltas.push({ track: track.fileName, kind: track.kind, deltaLu: delta });
      if (delta > thresholds.maxInterTrackDeltaLu) {
        pushAnomaly(anomalies, 'LOUDNESS_DELTA', 'warning', track.fileName,
          `与最响轨道响度差 ${delta.toFixed(1)} LU 超过上限 ${thresholds.maxInterTrackDeltaLu} LU`,
          { deltaLu: delta });
      }
    }
  }

  const flaggedFiles = new Set(anomalies.filter((a) => a.severity !== 'info').map((a) => a.track));
  for (const row of rows) {
    if (flaggedFiles.has(row.fileName)) row.status = 'flagged';
  }

  return {
    generatedAt: new Date().toISOString(),
    referenceDurationSec: referenceDuration,
    targetIntegratedLufs: thresholds.targetIntegratedLufs,
    matrix: rows,
    anomalies,
    loudnessDeltas,
  };
}
