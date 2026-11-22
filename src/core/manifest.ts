import type {
  BranchManifest,
  Decision,
  MainlinePlacement,
  MediaSegment,
} from "./types.ts";
import { MANIFEST_VERSION } from "./types.ts";

const SEGMENTS_FALLBACK: MediaSegment[] = [];

export function cloneManifest(manifest: BranchManifest): BranchManifest {
  return JSON.parse(JSON.stringify(manifest)) as BranchManifest;
}

export function getMainlinePlacements(
  manifest: BranchManifest,
): MainlinePlacement[] {
  const segmentMap = new Map(
    manifest.segments.map((segment) => [segment.id, segment]),
  );
  let cursor = 0;
  const placements: MainlinePlacement[] = [];

  manifest.mainline.forEach((clip, index) => {
    const segment = segmentMap.get(clip.segmentId);
    if (!segment) return;
    const duration = Math.max(0, segment.durationMs);
    placements.push({
      clip,
      segment,
      index,
      startMs: cursor,
      endMs: cursor + duration,
    });
    cursor += duration;
  });

  return placements;
}

export function getMainlineDurationMs(manifest: BranchManifest): number {
  const placements = getMainlinePlacements(manifest);
  return placements.at(-1)?.endMs ?? 0;
}

export function getPlacementAt(
  manifest: BranchManifest,
  timeMs: number,
): MainlinePlacement | undefined {
  const time = clamp(timeMs, 0, getMainlineDurationMs(manifest));
  const placements = getMainlinePlacements(manifest);
  return (
    placements.find(
      (placement) => time >= placement.startMs && time < placement.endMs,
    ) ?? placements.at(-1)
  );
}

export function getDecisionAt(
  manifest: BranchManifest,
  timeMs: number,
): Decision | undefined {
  return manifest.decisions.find(
    (decision) =>
      timeMs >= decision.timelineStartMs && timeMs <= decision.timelineEndMs,
  );
}

export function getDecision(manifest: BranchManifest, id: string): Decision | undefined {
  return manifest.decisions.find((decision) => decision.id === id);
}

export function getSegment(
  manifest: BranchManifest,
  id: string,
): MediaSegment | undefined {
  return manifest.segments.find((segment) => segment.id === id);
}

export function formatTimecode(ms: number, withMillis = true): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return withMillis ? `${base}.${String(millis).padStart(3, "0")}` : base;
}

export function createId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeManifest(input: unknown): BranchManifest {
  if (!input || typeof input !== "object") {
    throw new Error("清单内容不是对象");
  }
  const source = input as Partial<BranchManifest>;
  const segments = Array.isArray(source.segments)
    ? source.segments.map((segment, index) => normalizeSegment(segment, index))
    : SEGMENTS_FALLBACK;
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const mainline = Array.isArray(source.mainline)
    ? source.mainline
        .filter(
          (clip) =>
            clip &&
            typeof clip.id === "string" &&
            segmentIds.has(clip.segmentId),
        )
        .map((clip) => ({
          id: clip.id,
          segmentId: clip.segmentId,
        }))
    : [];
  const decisions = Array.isArray(source.decisions)
    ? source.decisions.map((decision, index) =>
        normalizeDecision(decision, index, segmentIds),
      )
    : [];

  return {
    version: MANIFEST_VERSION,
    id: textOr(source.id, createId("manifest")),
    title: textOr(source.title, "未命名急救分支"),
    description: textOr(source.description, ""),
    updatedAt: textOr(source.updatedAt, new Date().toISOString()),
    canvasWidth: positiveInt(source.canvasWidth, 960),
    canvasHeight: positiveInt(source.canvasHeight, 540),
    segments,
    mainline,
    decisions,
  };
}

function normalizeSegment(value: unknown, index: number): MediaSegment {
  const source = (value ?? {}) as Partial<MediaSegment>;
  const kind =
    source.kind === "branch" || source.kind === "ending"
      ? source.kind
      : "scene";
  return {
    id: textOr(source.id, `segment_${index + 1}`),
    name: textOr(source.name, `片段 ${index + 1}`),
    src: textOr(source.src, ""),
    durationMs: positiveInt(source.durationMs, 4_000),
    kind,
    accent: textOr(source.accent, "#ff6b52"),
    summary: textOr(source.summary, ""),
  };
}

function normalizeDecision(
  value: unknown,
  index: number,
  segmentIds: Set<string>,
): Decision {
  const source = (value ?? {}) as Partial<Decision>;
  const start = nonNegativeInt(source.timelineStartMs, 0);
  const end = Math.max(start + 1, nonNegativeInt(source.timelineEndMs, start + 3_000));
  return {
    id: textOr(source.id, `decision_${index + 1}`),
    title: textOr(source.title, `决策 ${index + 1}`),
    prompt: textOr(source.prompt, "请选择下一步"),
    timelineStartMs: start,
    timelineEndMs: end,
    pauseAtMs: clamp(nonNegativeInt(source.pauseAtMs, start), start, end),
    options: Array.isArray(source.options)
      ? source.options.map((option, optionIndex) =>
          normalizeOption(option, optionIndex, segmentIds, start, end),
        )
      : [],
  };
}

function normalizeOption(
  value: unknown,
  index: number,
  segmentIds: Set<string>,
  decisionStart: number,
  decisionEnd: number,
) {
  const source = (value ?? {}) as Partial<Decision["options"][number]>;
  const fallbackTarget = [...segmentIds][0] ?? "";
  return {
    id: textOr(source.id, `option_${index + 1}`),
    label: textOr(source.label, `选项 ${index + 1}`),
    hint: textOr(source.hint, ""),
    targetSegmentId:
      typeof source.targetSegmentId === "string" &&
      segmentIds.has(source.targetSegmentId)
        ? source.targetSegmentId
        : fallbackTarget,
    targetEndMs: positiveInt(source.targetEndMs, 4_000),
    returnToMs: clamp(
      nonNegativeInt(source.returnToMs, decisionStart),
      0,
      Math.max(decisionEnd, nonNegativeInt(source.returnToMs, 0)),
    ),
    correct: source.correct === true,
  };
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : fallback;
}
