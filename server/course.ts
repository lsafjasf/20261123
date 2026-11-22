export type RotationKind = "initial" | "steady" | "rotated";

export interface CourseSegment {
  id: string;
  ordinal: number;
  chapter: string;
  title: string;
  summary: string;
  durationMs: number;
  keyId: string;
  keyEpoch: number;
  rotation: RotationKind;
  accent: string;
  visual: {
    kicker: string;
    metric: string;
    metricLabel: string;
    bullets: string[];
  };
}

export interface LicensePolicy {
  licenseTtlMs: number;
  sessionTtlMs: number;
  offlineRule: "cached-verified-license-only";
  pauseRule: "wall-clock-expiry-includes-pause";
  rotationRule: "per-segment-key-epoch";
}

export const COURSE_ID = "offline-safety-2026";
export const COURSE_VERSION = "1.0.0";

export const LICENSE_POLICY: LicensePolicy = {
  licenseTtlMs: 30_000,
  sessionTtlMs: 15 * 60_000,
  offlineRule: "cached-verified-license-only",
  pauseRule: "wall-clock-expiry-includes-pause",
  rotationRule: "per-segment-key-epoch",
};

export const COURSE_SEGMENTS: CourseSegment[] = [
  {
    id: "seg-01",
    ordinal: 1,
    chapter: "01 / 威胁模型",
    title: "离线并不等于无界",
    summary: "先定义可播放边界：合法缓存、有效许可、未过期材料。",
    durationMs: 4_000,
    keyId: "epoch-01-a",
    keyEpoch: 1,
    rotation: "initial",
    accent: "#63e6be",
    visual: {
      kicker: "OFFLINE THREAT MODEL",
      metric: "03",
      metricLabel: "必须同时满足的条件",
      bullets: ["片段完整且哈希一致", "许可仍在墙上时钟内", "密钥与片段代次匹配"],
    },
  },
  {
    id: "seg-02",
    ordinal: 2,
    chapter: "02 / 密钥代次",
    title: "每个片段都声明密钥",
    summary: "清单只暴露 keyId，播放前才通过许可响应取得对应材料。",
    durationMs: 4_000,
    keyId: "epoch-01-a",
    keyEpoch: 1,
    rotation: "steady",
    accent: "#74c0fc",
    visual: {
      kicker: "SEGMENT KEY BINDING",
      metric: "AES-GCM",
      metricLabel: "片段级认证加密",
      bullets: ["keyId 与片段强绑定", "随机 96-bit IV", "解密失败立即停止"],
    },
  },
  {
    id: "seg-03",
    ordinal: 3,
    chapter: "03 / 中途轮换",
    title: "跨越代次时重新取钥",
    summary: "片段切换会命中新的密钥代次；旧材料不能为新片段续命。",
    durationMs: 4_000,
    keyId: "epoch-02-b",
    keyEpoch: 2,
    rotation: "rotated",
    accent: "#ffd43b",
    visual: {
      kicker: "KEY ROTATION BOUNDARY",
      metric: "epoch 2",
      metricLabel: "播放中途切换密钥",
      bullets: ["旧代次缓存标记失效", "切换必须通过许可闸门", "失败进入错误页，不保留空画面"],
    },
  },
  {
    id: "seg-04",
    ordinal: 4,
    chapter: "04 / 到期收敛",
    title: "暂停不会冻结许可时钟",
    summary: "暂停期间许可继续倒计时；恢复前重新校验，过期就停在错误页。",
    durationMs: 4_000,
    keyId: "epoch-02-b",
    keyEpoch: 2,
    rotation: "steady",
    accent: "#ff8787",
    visual: {
      kicker: "EXPIRY FAIL-CLOSED",
      metric: "30s",
      metricLabel: "含暂停的许可窗口",
      bullets: ["到期后不再解封密钥", "离线只读已缓存内容", "任何片段异常显式收敛"],
    },
  },
];

export function courseDurationMs(): number {
  return COURSE_SEGMENTS.reduce((total, segment) => total + segment.durationMs, 0);
}

export function buildManifest() {
  return {
    courseId: COURSE_ID,
    version: COURSE_VERSION,
    title: "离线培训：密钥轮换与许可边界",
    subtitle: "受控播放原型 · 本机生成媒体与密钥",
    durationMs: courseDurationMs(),
    generatedAt: new Date().toISOString(),
    policy: LICENSE_POLICY,
    segments: COURSE_SEGMENTS,
  };
}
