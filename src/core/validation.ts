import {
  getMainlineDurationMs,
  getPlacementAt,
  getSegment,
} from "./manifest.ts";
import type {
  BranchManifest,
  ValidationIssue,
  ValidationResult,
} from "./types.ts";

export function validateManifest(manifest: BranchManifest): ValidationResult {
  const issues: ValidationIssue[] = [];
  const segmentIds = new Set<string>();
  const mainlineDuration = getMainlineDurationMs(manifest);
  const decisionIds = new Set<string>();

  if (!manifest.title.trim()) {
    addIssue(issues, "title", "项目标题不能为空");
  }
  if (manifest.mainline.length === 0) {
    addIssue(issues, "mainline", "主时间线至少需要一个片段");
  }

  manifest.segments.forEach((segment, index) => {
    const path = `segments[${index}]`;
    if (segmentIds.has(segment.id)) {
      addIssue(issues, `${path}.id`, `片段 ID 重复：${segment.id}`);
    }
    segmentIds.add(segment.id);
    if (!segment.src.trim()) {
      addIssue(issues, `${path}.src`, "片段缺少媒体地址");
    }
    if (segment.durationMs <= 0) {
      addIssue(issues, `${path}.durationMs`, "片段时长必须大于 0");
    }
  });

  manifest.mainline.forEach((clip, index) => {
    if (!segmentIds.has(clip.segmentId)) {
      addIssue(
        issues,
        `mainline[${index}].segmentId`,
        `主线引用了不存在的片段：${clip.segmentId}`,
      );
    }
  });

  manifest.decisions.forEach((decision, index) => {
    const path = `decisions[${index}]`;
    if (decisionIds.has(decision.id)) {
      addIssue(issues, `${path}.id`, `决策 ID 重复：${decision.id}`);
    }
    decisionIds.add(decision.id);

    if (!decision.title.trim()) {
      addIssue(issues, `${path}.title`, "决策标题不能为空");
    }
    if (decision.timelineEndMs <= decision.timelineStartMs) {
      addIssue(issues, `${path}.timelineEndMs`, "选项区间结束时间必须晚于开始时间");
    }
    if (decision.timelineStartMs < 0 || decision.timelineEndMs > mainlineDuration) {
      addIssue(
        issues,
        `${path}.timelineStartMs`,
        `选项区间必须位于主线 0–${mainlineDuration}ms 内`,
      );
    }
    if (
      decision.pauseAtMs < decision.timelineStartMs ||
      decision.pauseAtMs > decision.timelineEndMs
    ) {
      addIssue(issues, `${path}.pauseAtMs`, "暂停点必须位于选项出现区间内");
    }
    if (decision.options.length < 2) {
      addIssue(issues, `${path}.options`, "每个决策至少需要两个选项");
    }
    if (!decision.options.some((option) => option.correct)) {
      addIssue(issues, `${path}.options`, "决策还没有标记正确选项", "warning");
    }

    const optionIds = new Set<string>();
    decision.options.forEach((option, optionIndex) => {
      const optionPath = `${path}.options[${optionIndex}]`;
      if (optionIds.has(option.id)) {
        addIssue(issues, `${optionPath}.id`, `选项 ID 重复：${option.id}`);
      }
      optionIds.add(option.id);
      if (!option.label.trim()) {
        addIssue(issues, `${optionPath}.label`, "选项文案不能为空");
      }
      const target = getSegment(manifest, option.targetSegmentId);
      if (!target) {
        addIssue(
          issues,
          `${optionPath}.targetSegmentId`,
          "目标片段不存在，播放会被阻止",
        );
      } else if (
        option.targetEndMs <= 0 ||
        option.targetEndMs > target.durationMs
      ) {
        addIssue(
          issues,
          `${optionPath}.targetEndMs`,
          `分支结束点必须位于 1–${target.durationMs}ms 内`,
        );
      }
      if (
        option.returnToMs < 0 ||
        option.returnToMs > mainlineDuration ||
        !getPlacementAt(manifest, option.returnToMs)
      ) {
        addIssue(
          issues,
          `${optionPath}.returnToMs`,
          `回主线位置必须位于 0–${mainlineDuration}ms 内`,
        );
      }
    });
  });

  const sorted = [...manifest.decisions].sort(
    (a, b) => a.timelineStartMs - b.timelineStartMs,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current && current.timelineStartMs < previous.timelineEndMs) {
      addIssue(
        issues,
        `decisions[${index}].timelineStartMs`,
        `决策区间与「${previous.title}」重叠`,
        "warning",
      );
    }
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

export function assertValidManifest(manifest: BranchManifest): void {
  const result = validateManifest(manifest);
  if (!result.valid) {
    const message = result.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("；");
    throw new Error(message);
  }
}

function addIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
  severity: ValidationIssue["severity"] = "error",
): void {
  issues.push({ path, message, severity });
}
