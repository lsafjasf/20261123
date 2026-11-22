import type { FrameClass } from "../src/core/types.ts";
import type { EvidenceTag } from "../src/core/types.ts";

export const CLASS_DETAILS: Record<
  FrameClass,
  { short: string; title: string; sub: string; color: string; tag: string }
> = {
  tear: {
    short: "采集撕裂",
    title: "检测到采集水平撕裂",
    sub: "上下画面来自不同采集时序，存在整幅水平错位。",
    color: "#ff7965",
    tag: "CAPTURE TEAR",
  },
  "encode-block": {
    short: "编码块错误",
    title: "疑似编码块损坏",
    sub: "局部块边界与均值突变突出，未形成连续整幅位移。",
    color: "#e6b85c",
    tag: "ENCODE BLOCK",
  },
  "vfx-glitch": {
    short: "游戏特效",
    title: "游戏故障特效",
    sub: "横线密度突增并跨帧复现，但缺少稳定整幅水平位移。",
    color: "#a78bfa",
    tag: "VFX GLITCH",
  },
  uncertain: {
    short: "证据不足",
    title: "横线异常 · 证据不足",
    sub: "存在可疑横纹，但位移支持或跨帧证据不足以下结论。",
    color: "#87a6b4",
    tag: "LOW EVIDENCE",
  },
  normal: {
    short: "正常",
    title: "未发现整幅断层",
    sub: "横线结构与片段基线一致，未检出采集不同步。",
    color: "#62d99a",
    tag: "CLEAN",
  },
};

export const TAG_LABELS: Record<EvidenceTag, string> = {
  "seam-shift": "整幅位移",
  "cross-time-skew": "跨帧时差",
  "block-grid": "网格周期",
  "localized-block": "局部块异常",
  "line-burst": "横线爆发",
  "recurring-pattern": "跨帧复现",
  "scanline-baseline": "扫描线基线",
  "low-shift-support": "位移支持不足",
  "no-horizontal-shift": "无整幅位移",
};

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

export function formatTimecode(ms: number): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = Math.floor(safe % 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

export function percent(value: number, digits = 0): string {
  return `${(Math.max(0, Math.min(1, value)) * 100).toFixed(digits)}%`;
}

export function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

let toastTimer = 0;
export function showToast(message: string, isError = false): void {
  const toast = byId<HTMLDivElement>("toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

export function getEngineStatus(): string {
  const parts = [
    "VideoFrame" in globalThis ? "WebCodecs" : null,
    "MediaSource" in globalThis ? "MediaSource" : null,
    "AudioContext" in globalThis ? "WebAudio" : null,
    "Canvas",
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join(" · ")} 就绪` : "Canvas 回退模式";
}
