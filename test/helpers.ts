import type { Project } from "../src/shared/types.ts";

export function makeProject(overrides?: Partial<Project>): Project {
  const images = Array.from({ length: 18 }, (_, index) => ({
    id: `img-${index + 1}`,
    src: `/fixtures/images/img-${index + 1}.png`,
    pixelWidth: 3840,
    pixelHeight: 2160,
    focusBox: {
      x: 0.3 + (index % 3) * 0.08,
      y: 0.28 + (index % 2) * 0.12,
      width: 0.18,
      height: 0.24,
    },
    usableFrame: { x: 0.04, y: 0.05, width: 0.92, height: 0.9 },
    motion: index % 3 === 0 ? "push-in" : index % 3 === 1 ? "pan" : "pull-out",
    narrationText: `旁白段落编号 ${index + 1}，用于驱动停留时长。`.repeat(index % 4),
    narrationSrc: `/fixtures/audio/seg-${index + 1}.wav`,
  }));
  return {
    title: "测试纪录片",
    video: {
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: 8_000_000,
      codec: "vp9",
    },
    narration: {
      baseHoldSeconds: 4,
      minHoldSeconds: 2.5,
      maxHoldSeconds: 14,
      charsPerSecond: 4,
      audioSlackSeconds: 0.4,
      transitionSeconds: 0.8,
    },
    images,
    ...overrides,
  };
}
