import type { LayoutStyle, VideoPreset } from "./types.js";

export const PRESETS: Record<"16:9" | "9:16", VideoPreset> = {
  "16:9": {
    aspect: "16:9",
    width: 1920,
    height: 1080,
    safe: { x: 122.88, y: 75.6, width: 1674.24, height: 926.64 },
    fontSize: 56,
    minFontSize: 40,
    lineHeight: 1.45,
    maxLines: 2,
    marginX: 0.064,
    marginY: 0.07,
    bottomInset: 78,
    horizontalPadding: 30,
    verticalPadding: 20,
    foregroundFit: "contain"
  },
  "9:16": {
    aspect: "9:16",
    width: 1080,
    height: 1920,
    safe: { x: 79.92, y: 153.6, width: 920.16, height: 1555.2 },
    fontSize: 50,
    minFontSize: 36,
    lineHeight: 1.5,
    maxLines: 3,
    marginX: 0.074,
    marginY: 0.08,
    bottomInset: 211,
    horizontalPadding: 24,
    verticalPadding: 18,
    foregroundFit: "contain"
  }
};

export const DEFAULT_STYLE: LayoutStyle = {
  background: "box",
  accent: "#f4bd54",
  foreground: "#f7f4eb",
  muted: "#c9c5ba",
  backgroundRGBA: "rgba(7, 13, 19, 0.88)",
  borderRGBA: "rgba(244, 189, 84, 0.52)",
  fontFamily:
    '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "Droid Sans Fallback", sans-serif',
  fontWeight: 700,
  fontScale: 1,
  radius: 16,
  shadowBlur: 18,
  showSpeaker: false
};

export const DEMO_SUBJECTS: Record<"16:9" | "9:16", { x: number; y: number; width: number; height: number }> = {
  "16:9": { x: 0.09, y: 0.13, width: 0.38, height: 0.64 },
  "9:16": { x: 0.12, y: 0.12, width: 0.62, height: 0.34 }
};
