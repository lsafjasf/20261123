import { rgbaToLuma } from "../core/color.js";
import {
  DEFAULT_SETTINGS,
  interpolateFrame
} from "../core/interpolation.js";
import { estimatePairMotion } from "../core/motion.js";
import type {
  FrameScheduleEntry,
  InterpolationResult,
  InterpolationSettings,
  LumaFrame,
  PairMotion,
  RgbaFrame
} from "../core/types.js";
import type { FrameProvider } from "./sources.js";

export interface PreparedPreview {
  entry: FrameScheduleEntry;
  before: RgbaFrame;
  after: RgbaFrame;
  displayBefore: RgbaFrame;
  result: InterpolationResult;
  motion: PairMotion | null;
  computeMs: number;
}

function settingsKey(settings: InterpolationSettings): string {
  return [
    settings.blockSize,
    settings.maxDisplacement,
    settings.occlusionThreshold,
    settings.photoThreshold,
    settings.costThreshold
  ].join(":");
}

function regionKey(settings: InterpolationSettings): string {
  const region = settings.region;
  return [
    region.enabled ? 1 : 0,
    region.x.toFixed(4),
    region.y.toFixed(4),
    region.width.toFixed(4),
    region.height.toFixed(4),
    region.feather.toFixed(4),
    region.strength.toFixed(3)
  ].join(":");
}

export class PreviewInterpolator {
  private provider: FrameProvider;
  private settings: InterpolationSettings;
  private lumaCache = new WeakMap<RgbaFrame, LumaFrame>();
  private motionCache = new Map<string, PairMotion>();
  private motionOrder: string[] = [];
  private outputCache = new Map<string, PreparedPreview>();
  private outputOrder: string[] = [];
  private generation = 0;

  constructor(provider: FrameProvider, settings: InterpolationSettings = DEFAULT_SETTINGS) {
    this.provider = provider;
    this.settings = settings;
  }

  updateProvider(provider: FrameProvider): void {
    this.provider = provider;
    this.lumaCache = new WeakMap();
    this.clear();
  }

  updateSettings(settings: InterpolationSettings): void {
    const motionChanged = settingsKey(settings) !== settingsKey(this.settings);
    const regionChanged = regionKey(settings) !== regionKey(this.settings);
    this.settings = settings;
    this.generation += 1;
    if (motionChanged) {
      this.motionCache.clear();
      this.motionOrder = [];
    }
    if (motionChanged || regionChanged) {
      this.outputCache.clear();
      this.outputOrder = [];
    }
  }

  clear(): void {
    this.generation += 1;
    this.motionCache.clear();
    this.motionOrder = [];
    this.outputCache.clear();
    this.outputOrder = [];
  }

  async prepare(entry: FrameScheduleEntry): Promise<PreparedPreview> {
    const generation = this.generation;
    const before = await this.provider.getFrame(entry.sourceIndex);
    const after = await this.provider.getFrame(entry.nextSourceIndex);
    if (generation !== this.generation) {
      throw new Error("stale-preview");
    }
    const beforeLuma = this.getLuma(before);
    const afterLuma = this.getLuma(after);
    const motionKey = `${entry.sourceIndex}:${entry.nextSourceIndex}:${settingsKey(this.settings)}`;
    const outputKey = `${entry.index}:${motionKey}:${regionKey(this.settings)}`;
    const cached = this.outputCache.get(outputKey);
    if (cached) {
      this.touchOutput(outputKey);
      return cached;
    }

    let motion = this.motionCache.get(motionKey) ?? null;
    if (!motion) {
      if (entry.sourceIndex === entry.nextSourceIndex) {
        motion = null;
      } else {
        motion = estimatePairMotion(beforeLuma, afterLuma, this.settings);
        this.motionCache.set(motionKey, motion);
        this.motionOrder.push(motionKey);
        while (this.motionOrder.length > 10) {
          const expired = this.motionOrder.shift();
          if (expired) this.motionCache.delete(expired);
        }
      }
    }

    const start = performance.now();
    const result = interpolateFrame(
      before,
      after,
      entry.sourcePhase,
      this.settings,
      motion ?? undefined,
      beforeLuma,
      afterLuma
    );
    const prepared: PreparedPreview = {
      entry,
      before,
      after,
      displayBefore: before,
      result,
      motion,
      computeMs: performance.now() - start + (motion?.estimateMs ?? 0)
    };
    this.outputCache.set(outputKey, prepared);
    this.outputOrder.push(outputKey);
    while (this.outputOrder.length > 18) {
      const expired = this.outputOrder.shift();
      if (expired) this.outputCache.delete(expired);
    }
    return prepared;
  }

  private getLuma(frame: RgbaFrame): LumaFrame {
    let luma = this.lumaCache.get(frame);
    if (!luma) {
      luma = rgbaToLuma(frame);
      this.lumaCache.set(frame, luma);
    }
    return luma;
  }

  private touchOutput(key: string): void {
    const index = this.outputOrder.indexOf(key);
    if (index >= 0) this.outputOrder.splice(index, 1);
    this.outputOrder.push(key);
  }
}
