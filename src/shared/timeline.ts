import type {
  CropSample,
  ImageSpec,
  NarrationConfig,
  Project,
  SegmentExportRecord,
  SegmentTiming,
  Timeline,
} from "./types.ts";
import { buildCameraPlan, sampleCrops, type CameraPlan } from "./camera.ts";
import { clamp } from "./geometry.ts";

export function estimateTextSeconds(text: string | undefined, charsPerSecond: number): number {
  if (!text) {
    return 0;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.length / Math.max(0.1, charsPerSecond);
}

export function holdForSegment(image: ImageSpec, narration: NarrationConfig): {
  holdSeconds: number;
  narrationSeconds: number;
} {
  const textSeconds = estimateTextSeconds(image.narrationText, narration.charsPerSecond);
  const narrationSeconds = textSeconds + (image.narrationSrc ? narration.audioSlackSeconds : 0);
  const holdSeconds = clamp(
    Math.max(narration.baseHoldSeconds, narrationSeconds),
    narration.minHoldSeconds,
    narration.maxHoldSeconds,
  );
  return { holdSeconds, narrationSeconds };
}

export function buildTimeline(project: Project, audioDurationSeconds?: number): Timeline {
  const transition = project.narration.transitionSeconds;
  const timings: SegmentTiming[] = [];
  let cursor = 0;

  project.images.forEach((image, index) => {
    const { holdSeconds, narrationSeconds } = holdForSegment(image, project.narration);
    const start = cursor;
    const hasNext = index < project.images.length - 1;
    const duration = holdSeconds + (hasNext ? transition : 0);
    const end = cursor + duration;
    timings.push({
      index,
      imageId: image.id,
      start,
      end,
      duration,
      enterAt: start,
      leaveAt: start + holdSeconds,
      holdSeconds,
      narrationSeconds,
    });
    cursor = end - (hasNext ? transition : 0);
  });

  let duration = timings.length === 0 ? 0 : timings[timings.length - 1].end;
  if (typeof audioDurationSeconds === "number" && Number.isFinite(audioDurationSeconds)) {
    duration = Math.max(duration, audioDurationSeconds + project.narration.audioSlackSeconds);
  }
  duration = Math.max(0, duration);

  return {
    duration,
    frameCount: Math.round(duration * project.video.fps),
    transitionSeconds: transition,
    segments: timings,
  };
}

export interface PlanBundle {
  timeline: Timeline;
  plans: Map<string, CameraPlan>;
}

export function buildPlans(project: Project, audioDurationSeconds?: number): PlanBundle {
  const timeline = buildTimeline(project, audioDurationSeconds);
  const aspect = project.video.width / project.video.height;
  const plans = new Map<string, CameraPlan>();
  for (const image of project.images) {
    plans.set(image.id, buildCameraPlan({
      imageId: image.id,
      pixelWidth: image.pixelWidth,
      pixelHeight: image.pixelHeight,
      focusBox: image.focusBox,
      usableFrame: image.usableFrame,
      mode: image.motion ?? "auto",
      outputAspect: aspect,
      index: plans.size,
    }));
  }
  return { timeline, plans };
}

export function buildExportManifest(
  project: Project,
  bundle: PlanBundle,
  exportedAt: string,
): { segments: SegmentExportRecord[] } {
  const segments = bundle.timeline.segments.map((segment): SegmentExportRecord => {
    const image = project.images[segment.index];
    const plan = bundle.plans.get(image.id);
    if (!plan) {
      throw new Error(`missing camera plan for ${image.id}`);
    }
    const motionSpan = Math.max(0.1, segment.leaveAt - segment.enterAt);
    const sampleCount = Math.max(2, Math.ceil(motionSpan * 2));
    const crops: CropSample[] = sampleCrops(plan, sampleCount).map((sample) => ({
      time: segment.enterAt + sample.time * motionSpan,
      progress: sample.progress,
      crop: sample.crop,
    }));
    return {
      imageId: image.id,
      inPoint: segment.enterAt,
      outPoint: segment.leaveAt,
      transitionIn: segment.index === 0 ? 0 : bundle.timeline.transitionSeconds,
      transitionOut: segment.index === bundle.timeline.segments.length - 1
        ? 0
        : bundle.timeline.transitionSeconds,
      startCrop: plan.startCrop,
      endCrop: plan.endCrop,
      cropSamples: crops,
    };
  });
  return { segments };
}
