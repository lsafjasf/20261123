import { verifyLicenseToken } from "./crypto.js";
import { ControlledPlaybackError } from "./errors.js";
import type { CachedLicense, LicensePayload, SegmentDescriptor } from "./types.js";

export type LicenseState = "valid" | "expired" | "not-yet-valid" | "invalid";

export function trustedNow(clockOffsetMs: number): number {
  return Date.now() + clockOffsetMs;
}

export function licenseRemainingMs(license: CachedLicense, clockOffsetMs: number): number {
  return license.expiresAt - trustedNow(clockOffsetMs);
}

export function licenseState(license: CachedLicense, clockOffsetMs: number): LicenseState {
  const now = trustedNow(clockOffsetMs);
  if (license.payload.exp !== license.expiresAt) {
    return "invalid";
  }
  if (now < license.payload.nbf) {
    return "not-yet-valid";
  }
  if (now >= license.expiresAt) {
    return "expired";
  }
  return "valid";
}

export async function verifyCachedLicense(
  license: CachedLicense,
  publicKey: JsonWebKey,
): Promise<LicensePayload> {
  const { payload } = await verifyLicenseToken(license.token, publicKey);
  if (
    payload.segmentId !== license.segmentId ||
    payload.segmentId !== license.payload.segmentId ||
    payload.keyId !== license.keyId ||
    payload.keyEpoch !== license.keyEpoch ||
    payload.exp !== license.expiresAt
  ) {
    throw new Error("缓存许可证声明不一致");
  }
  return payload;
}

export function assertLicenseUsable(
  license: CachedLicense | undefined,
  segment: SegmentDescriptor,
  clockOffsetMs: number,
  now = trustedNow(clockOffsetMs),
): asserts license is CachedLicense {
  if (!license) {
    throw new ControlledPlaybackError({
      code: "LICENSE_MISSING",
      title: "片段没有可用许可",
      guidance: "该材料未获许可，播放器已拒绝继续。联机刷新许可后可重试。",
      segmentId: segment.id,
    });
  }
  if (license.keyId !== segment.keyId || license.keyEpoch !== segment.keyEpoch) {
    throw new ControlledPlaybackError({
      code: "LICENSE_INVALID",
      title: "许可与片段密钥代次不匹配",
      guidance: "播放器不会用旧代次材料解封新片段。",
      segmentId: segment.id,
      technical: `${license.keyId} != ${segment.keyId}`,
    });
  }
  if (now < license.payload.nbf) {
    throw new ControlledPlaybackError({
      code: "LICENSE_NOT_YET_VALID",
      title: "许可尚未生效",
      guidance: "请确认本机时间，或重新联机获取本地许可。",
      segmentId: segment.id,
      technical: `nbf=${license.payload.nbf}, now=${Math.round(now)}`,
    });
  }
  if (now >= license.expiresAt) {
    throw new ControlledPlaybackError({
      code: "LICENSE_EXPIRED",
      title: "许可已到期，材料停止解封",
      guidance: "暂停期间许可照常计时。缓存仍在本机，但必须重新联机申请新许可。",
      segmentId: segment.id,
      technical: `exp=${license.expiresAt}, now=${Math.round(now)}`,
    });
  }
}
