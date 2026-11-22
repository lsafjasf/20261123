export const SAMPLE_RATE = 48_000;
export const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;
export const DEFAULT_FPS = 30;
export const MIN_DECEL_SEC = 0.2;

export interface TapeConfig {
  fps: number;
  impactSec: number;
  startSec: number;
  bpm: number;
  holdSec: number;
}

export interface SampleTiming {
  sampleRate: number;
  startSample: number;
  impactSample: number;
  totalSamples: number;
  holdSamples: number;
  startSec: number;
  impactSec: number;
  totalSec: number;
  decelSec: number;
}

export interface BeatCrossing {
  beatIndex: number;
  sourceSec: number;
  timeSec: number;
  sample: number;
  rate: number;
}

export interface FpsAnchor {
  fps: number;
  startFrame: number;
  impactFrame: number;
  startSec: number;
  impactSec: number;
}

export const DEFAULT_CONFIG: TapeConfig = {
  fps: DEFAULT_FPS,
  impactSec: 138 / DEFAULT_FPS,
  startSec: 138 / DEFAULT_FPS - 2,
  bpm: 120,
  holdSec: 0.5,
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function nearestFrame(timeSec: number, fps: number): number {
  return Math.max(0, Math.round(timeSec * fps));
}

export function frameToTime(frame: number, fps: number): number {
  return Math.max(0, frame) / fps;
}

export function quantizeToFrame(timeSec: number, fps: number): number {
  return frameToTime(nearestFrame(timeSec, fps), fps);
}

export function normalizeConfig(config: TapeConfig): TapeConfig {
  const fps = clamp(config.fps, 1, 240);
  const holdSec = clamp(config.holdSec, 0.1, 3);
  const impactSec = Math.max(MIN_DECEL_SEC + 0.1, config.impactSec);
  const startSec = clamp(
    config.startSec,
    0,
    impactSec - MIN_DECEL_SEC,
  );
  const bpm = clamp(config.bpm, 40, 240);
  return { fps, impactSec, startSec, bpm, holdSec };
}

export function computeTiming(
  config: TapeConfig,
  sampleRate = SAMPLE_RATE,
): SampleTiming {
  const impactSample = Math.round(config.impactSec * sampleRate);
  const startSample = Math.round(config.startSec * sampleRate);
  const holdSamples = Math.max(1, Math.round(config.holdSec * sampleRate));
  return {
    sampleRate,
    startSample,
    impactSample,
    totalSamples: impactSample + holdSamples,
    holdSamples,
    startSec: config.startSec,
    impactSec: config.impactSec,
    totalSec: config.impactSec + config.holdSec,
    decelSec: config.impactSec - config.startSec,
  };
}

export function rateAt(timeSec: number, config: TapeConfig): number {
  const duration = config.impactSec - config.startSec;
  if (timeSec <= config.startSec) return 1;
  if (timeSec >= config.impactSec) return 0;
  return clamp(1 - (timeSec - config.startSec) / duration, 0, 1);
}

export function sourcePositionAt(timeSec: number, config: TapeConfig): number {
  if (timeSec <= config.startSec) return timeSec;
  if (timeSec >= config.impactSec) {
    return config.startSec + (config.impactSec - config.startSec) * 0.5;
  }
  const tau = timeSec - config.startSec;
  const duration = config.impactSec - config.startSec;
  return config.startSec + tau - (tau * tau) / (2 * duration);
}

export function outputTimeAtSource(sec: number, config: TapeConfig): number | null {
  const duration = config.impactSec - config.startSec;
  const distance = sec - config.startSec;
  if (distance <= 0 || distance > duration * 0.5) return null;
  return config.startSec + duration - Math.sqrt(duration * duration - 2 * duration * distance);
}

export function beatCrossings(config: TapeConfig, sampleRate = SAMPLE_RATE): BeatCrossing[] {
  const beatSec = 60 / config.bpm;
  const sourceStart = config.startSec;
  const sourceEnd = sourcePositionAt(config.impactSec, config);
  const first = Math.ceil(sourceStart / beatSec);
  const last = Math.floor(sourceEnd / beatSec);
  const crossings: BeatCrossing[] = [];

  for (let index = first; index <= last; index += 1) {
    const sourceSec = index * beatSec;
    const timeSec = outputTimeAtSource(sourceSec, config);
    if (timeSec === null) continue;
    const sample = Math.round(timeSec * sampleRate);
    if (sample >= computeTiming(config, sampleRate).impactSample) continue;
    crossings.push({
      beatIndex: index,
      sourceSec,
      timeSec,
      sample,
      rate: rateAt(timeSec, config),
    });
  }
  return crossings;
}

export function fpsAnchors(config: TapeConfig, fpsList: readonly number[] = FPS_OPTIONS): FpsAnchor[] {
  return fpsList.map((fps) => ({
    fps,
    startFrame: nearestFrame(config.startSec, fps),
    impactFrame: nearestFrame(config.impactSec, fps),
    startSec: config.startSec,
    impactSec: config.impactSec,
  }));
}

export function snapStartToBeats(config: TapeConfig, beats: number): TapeConfig {
  const duration = (60 / config.bpm) * beats;
  const target = config.impactSec - duration;
  return normalizeConfig({
    ...config,
    startSec: Math.round(target * config.fps) / config.fps,
  });
}

export function durationInBeats(config: TapeConfig): number {
  return (config.impactSec - config.startSec) / (60 / config.bpm);
}

export function shiftImpact(config: TapeConfig, impactSec: number): TapeConfig {
  const duration = config.impactSec - config.startSec;
  const nextImpact = Math.max(duration + MIN_DECEL_SEC, impactSec);
  return normalizeConfig({
    ...config,
    impactSec: nextImpact,
    startSec: Math.max(0, nextImpact - duration),
  });
}

export function timecode(timeSec: number, fps: number): string {
  const safe = Math.max(0, timeSec);
  const whole = Math.floor(safe);
  const frame = Math.min(Math.round((safe - whole) * fps), Math.ceil(fps) - 1);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frame).padStart(2, "0")}`;
}
