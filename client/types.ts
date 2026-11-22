export type RotationKind = "initial" | "steady" | "rotated";

export interface VisualSpec {
  kicker: string;
  metric: string;
  metricLabel: string;
  bullets: string[];
}

export interface SegmentDescriptor {
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
  visual: VisualSpec;
}

export interface LicensePolicy {
  licenseTtlMs: number;
  sessionTtlMs: number;
  offlineRule: "cached-verified-license-only";
  pauseRule: "wall-clock-expiry-includes-pause";
  rotationRule: "per-segment-key-epoch";
}

export interface Manifest {
  courseId: string;
  version: string;
  title: string;
  subtitle: string;
  durationMs: number;
  generatedAt: string;
  policy: LicensePolicy;
  segments: SegmentDescriptor[];
}

export interface SessionPayload {
  sessionId: string;
  serverTime: number;
  expiresAt: number;
  publicKey: JsonWebKey;
  policy: LicensePolicy;
}

export interface LicenseGrant {
  segmentId: string;
  keyId: string;
  keyEpoch: number;
  key: string;
  keyFingerprint: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface LicensePayload {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  segmentId: string;
  keyId: string;
  keyEpoch: number;
  manifestId: string;
  iat: number;
  nbf: number;
  exp: number;
  offline: string;
  pause: string;
}

export interface WrappedKey {
  iv: string;
  data: string;
}

export interface CachedLicense {
  segmentId: string;
  keyId: string;
  keyEpoch: number;
  keyFingerprint: string;
  token: string;
  payload: LicensePayload;
  wrappedKey: WrappedKey;
  issuedAt: number;
  expiresAt: number;
  cachedAt: number;
}

export interface CachedSegment {
  segmentId: string;
  ordinal: number;
  keyId: string;
  keyEpoch: number;
  iv: string;
  ciphertext: ArrayBuffer;
  ciphertextSha256: string;
  plaintextSize: number;
  generatedAt: number;
}

export interface CacheMeta {
  manifest: Manifest;
  publicKey: JsonWebKey;
  serverTime: number;
  clockOffsetMs: number;
  generatedKeyFingerprint: string;
  initSegment: ArrayBuffer;
  initSha256: string;
  generatedAt: number;
}

export type ErrorCode =
  | "UNSUPPORTED_API"
  | "OFFLINE_CACHE_MISSING"
  | "LIMITED_CACHE_MISSING"
  | "LICENSE_MISSING"
  | "LICENSE_INVALID"
  | "LICENSE_EXPIRED"
  | "LICENSE_NOT_YET_VALID"
  | "SEGMENT_NOT_CACHED"
  | "SEGMENT_HASH_MISMATCH"
  | "DECRYPT_FAILED"
  | "SEGMENT_SWITCH_FAILED"
  | "MEDIA_APPEND_FAILED"
  | "MEDIA_GENERATION_FAILED"
  | "NETWORK_ERROR"
  | "UNEXPECTED";

export interface AppSnapshot {
  manifest: Manifest;
  licenses: Map<string, CachedLicense>;
  segments: Map<string, CachedSegment>;
  meta: CacheMeta;
  offline: boolean;
  sessionId: string | null;
}
