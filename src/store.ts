// 分析状态编排：特征只算一次；改阈值时按检测器粒度增量重算。
// - 帧级阈值（如 silenceDb、popJump）：只重算判定可能翻转的候选窗口
// - 时长阈值（如 silenceMinSec）：帧掩码不变，只重跑分段合并
// - 白名单变化：只影响静音族的细分，同样只重跑分段合并
import { detectorThresholdKeys, evalMask } from './detectors.js';
import type { DetectorId } from './detectors.js';
import { buildSegments } from './segments.js';
import type { Masks } from './segments.js';
import {
  DEFAULT_THRESHOLDS,
} from './types.js';
import type {
  FrameFeatures, Segment, Thresholds, WhitelistRule,
} from './types.js';

const DETECTOR_IDS: DetectorId[] = ['silence', 'pop', 'clip', 'noise', 'music'];

// 时长类阈值键：只影响分段合并，不影响帧掩码
const DURATION_KEYS: (keyof Thresholds)[] = [
  'silenceMinSec', 'dropoutMinSec', 'dropoutMaxSec',
  'popMaxSec', 'clipMinSec', 'noiseMinSec', 'musicMinSec',
];

export interface RecomputeStats {
  reevaluatedWindows: number; // 实际重算的帧数
  totalWindows: number;
  affectedDetectors: DetectorId[];
  segmentOnly: boolean;       // 是否只重跑了分段合并
  elapsedMs: number;
}

export class Analyzer {
  feats: FrameFeatures | null = null;
  thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  whitelist: WhitelistRule[] = [];
  masks: Masks | null = null;
  segments: Segment[] = [];

  setFeatures(feats: FrameFeatures): void {
    this.feats = feats;
    this.masks = null;
    this.recomputeAll();
  }

  private recomputeAll(): RecomputeStats {
    const t0 = performance.now();
    const masks = {} as Masks;
    let evaluated = 0;
    for (const id of DETECTOR_IDS) {
      const r = evalMask(id, this.feats as FrameFeatures, this.thresholds);
      masks[id] = r.mask;
      evaluated += r.evaluated;
    }
    this.masks = masks;
    this.segments = buildSegments(
      this.feats as FrameFeatures, masks, this.thresholds, this.whitelist);
    return {
      reevaluatedWindows: evaluated,
      totalWindows: (this.feats as FrameFeatures).count,
      affectedDetectors: [...DETECTOR_IDS],
      segmentOnly: false,
      elapsedMs: performance.now() - t0,
    };
  }

  // 改阈值：只重算受影响的检测器、且只重算可能翻转的窗口。
  updateThresholds(patch: Partial<Thresholds>): RecomputeStats {
    if (!this.feats || !this.masks) return this.recomputeAllNoState();
    const t0 = performance.now();
    const prevTh = { ...this.thresholds };
    const changed = new Set<keyof Thresholds>();
    for (const k of Object.keys(patch) as (keyof Thresholds)[]) {
      if (patch[k] !== undefined && patch[k] !== prevTh[k]) changed.add(k);
    }
    Object.assign(this.thresholds, patch);
    if (changed.size === 0) {
      return { reevaluatedWindows: 0, totalWindows: this.feats.count,
        affectedDetectors: [], segmentOnly: false, elapsedMs: 0 };
    }

    // 纯时长阈值变化：帧掩码不变，只重跑分段合并
    const frameKeys = [...changed].filter(k => !DURATION_KEYS.includes(k));
    let evaluated = 0;
    const affected: DetectorId[] = [];
    if (frameKeys.length > 0) {
      for (const id of DETECTOR_IDS) {
        const keys = detectorThresholdKeys(id);
        if (!keys.some(k => changed.has(k))) continue;
        const r = evalMask(id, this.feats, this.thresholds,
          this.masks[id], prevTh, changed);
        this.masks[id] = r.mask;
        evaluated += r.evaluated;
        affected.push(id);
      }
    }
    this.segments = buildSegments(this.feats, this.masks, this.thresholds,
      this.whitelist);
    return {
      reevaluatedWindows: evaluated,
      totalWindows: this.feats.count,
      affectedDetectors: affected,
      segmentOnly: frameKeys.length === 0,
      elapsedMs: performance.now() - t0,
    };
  }

  // 白名单变化只影响静音族细分：重跑分段合并即可。
  setWhitelist(rules: WhitelistRule[]): RecomputeStats {
    this.whitelist = rules;
    if (!this.feats || !this.masks) return this.recomputeAllNoState();
    const t0 = performance.now();
    this.segments = buildSegments(this.feats, this.masks, this.thresholds,
      this.whitelist);
    return {
      reevaluatedWindows: 0,
      totalWindows: this.feats.count,
      affectedDetectors: [],
      segmentOnly: true,
      elapsedMs: performance.now() - t0,
    };
  }

  private recomputeAllNoState(): RecomputeStats {
    return { reevaluatedWindows: 0, totalWindows: 0, affectedDetectors: [],
      segmentOnly: false, elapsedMs: 0 };
  }
}
