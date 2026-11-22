import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MotionMode, Project, Rect } from "../src/shared/types.ts";

const motions: MotionMode[] = ["push-in", "pan", "pull-out", "auto"];
const paragraphs = [
  "这是一段较长的纪录片旁白，用来验证系统会依据文本长度自动延长该照片的停留时间，同时保持图片顺序不变。",
  "短促的一句。",
  "镜头在重点区域之间缓慢移动，交叉溶解过程中两张照片始终铺满画布，任何时刻都不会露出黑边或画面边界。",
  "",
];

const images = Array.from({ length: 18 }, (_, index) => {
  const column = index % 4;
  const row = index % 3;
  const focusBox: Rect = {
    x: 0.18 + column * 0.16,
    y: 0.22 + row * 0.14,
    width: 0.16,
    height: 0.22,
  };
  return {
    id: `img-${index + 1}`,
    src: `/fixtures/images/img-${index + 1}.png`,
    pixelWidth: 3840,
    pixelHeight: 2160,
    focusBox,
    usableFrame: { x: 0.04, y: 0.05, width: 0.92, height: 0.9 } satisfies Rect,
    motion: motions[index % motions.length],
    narrationText: paragraphs[index % paragraphs.length],
    narrationSrc: `/fixtures/audio/seg-${index + 1}.wav`,
  };
});

const project: Project = {
  title: "十八张照片的纪录片",
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 8_000_000,
    codec: "vp9",
  },
  narration: {
    baseHoldSeconds: 4.5,
    minHoldSeconds: 2.5,
    maxHoldSeconds: 16,
    charsPerSecond: 4.2,
    audioSlackSeconds: 0.45,
    transitionSeconds: 0.9,
    fullNarrationSrc: "/fixtures/audio/narration.wav",
  },
  images,
};

writeFileSync(
  join(process.cwd(), "fixtures", "project.json"),
  `${JSON.stringify(project, null, 2)}\n`,
);
console.log("wrote fixtures/project.json");
