// 数据模型：机位清单（manifest）与全局时间线约定。

export const GLOBAL_TIMESCALE = 90000; // 全局对齐线刻度：25fps 与 29.97fps 均整除
export const VIDEO_TIMESCALE = 90000;
export const AUDIO_TIMESCALE = 44100;

export interface ClipFaults {
  gapBeforeMs?: number; // 换卡：本段开机前的墙钟空洞
  overlapBeforeMs?: number; // 与上一段墙钟重叠（尾段重复录制）
  truncateLastFragment?: boolean; // 断电：末尾碎片丢失
  dupFragmentTfdt?: number[]; // 固件故障：这些碎片的 tfdt 重复上一碎片
  jitterDurations?: boolean; // 采样间隔抖动（3600/3601 交替）
  fpsAssumed?: [number, number]; // 写时间戳时误用的帧率（漂移源）
}

export interface ClipSpec {
  file: string; // 相对 manifest 的路径
  wallStartMs: number; // 真实开机时刻（全局线，整数毫秒）
  durationMs: number; // 内容时长
  faults?: ClipFaults;
}

export interface CameraSpec {
  id: string;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  audioSampleRate: number;
  clips: ClipSpec[];
}

export interface Manifest {
  kind: "wedding-multicam-manifest";
  version: 1;
  generatedAt: string;
  globalTimescale: number;
  cameras: CameraSpec[];
}

export function loadManifest(json: string): Manifest {
  const m = JSON.parse(json) as Manifest;
  if (m.kind !== "wedding-multicam-manifest") {
    throw new Error("不是有效的机位清单文件");
  }
  return m;
}
