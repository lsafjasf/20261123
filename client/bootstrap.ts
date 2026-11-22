import { attestGrant, importContentKey, sha256Base64Url, wrapContentKey } from "./crypto.js";
import {
  ensureWrappingKey,
  getMeta,
  getAllLicenses,
  getAllSegments,
  putLicenses,
  putMeta,
  resetMediaCache,
} from "./db.js";
import { ControlledPlaybackError } from "./errors.js";
import { generateAndCacheMedia, type GenerationProgress, type SegmentKeyMaterial } from "./generate.js";
import { verifyCachedLicense } from "./licensing.js";
import type {
  AppSnapshot,
  CacheMeta,
  CachedLicense,
  CachedSegment,
  LicenseGrant,
  Manifest,
  SessionPayload,
} from "./types.js";

const OFFLINE_KEY = "nimbus.offline";
const CACHE_META_KEY = "cacheMeta";

export interface BootProgress {
  label: string;
  percent: number;
}

export interface BootOptions {
  offline: boolean;
  onProgress: (progress: BootProgress) => void;
}

interface ManifestResponse {
  manifest: Manifest;
  serverTime: number;
}

interface LicenseResponse {
  serverTime: number;
  licenses: LicenseGrant[];
}

export function offlineRequested(): boolean {
  try {
    return localStorage.getItem(OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOfflineRequested(offline: boolean): void {
  try {
    localStorage.setItem(OFFLINE_KEY, offline ? "1" : "0");
  } catch {
    // The in-memory mode still applies for this page.
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = (await response.json()) as T & { message?: string; error?: string };
    if (!response.ok) {
      throw new ControlledPlaybackError({
        code: "NETWORK_ERROR",
        title: "本地许可服务拒绝了请求",
        guidance: body.message ?? "请确认本地服务正在运行。",
        technical: `${response.status} ${body.error ?? "UNKNOWN"}`,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof ControlledPlaybackError) {
      throw error;
    }
    throw new ControlledPlaybackError({
      code: "NETWORK_ERROR",
      title: "无法连接本地许可服务",
      guidance: "如果是断网演示，请进入离线模式；否则确认 npm start 仍在运行。",
      technical: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

function validateManifest(manifest: Manifest): void {
  if (!manifest || !Array.isArray(manifest.segments) || manifest.segments.length === 0) {
    throw new ControlledPlaybackError({
      code: "NETWORK_ERROR",
      title: "清单格式无效",
      guidance: "播放器拒绝进入没有片段的清单。",
    });
  }
  for (const segment of manifest.segments) {
    if (!segment.id || !segment.keyId || !Number.isFinite(segment.durationMs)) {
      throw new ControlledPlaybackError({
        code: "NETWORK_ERROR",
        title: "片段声明不完整",
        guidance: "清单中的每个片段都必须声明 id、keyId 和时长。",
        segmentId: segment.id,
      });
    }
  }
}

function compositeFingerprint(grants: LicenseGrant[]): Promise<string> {
  const canonical = [...grants]
    .sort((left, right) => left.segmentId.localeCompare(right.segmentId))
    .map((grant) => `${grant.segmentId}:${grant.keyId}:${grant.keyEpoch}:${grant.keyFingerprint}`)
    .join("|");
  return sha256Base64Url(new TextEncoder().encode(canonical));
}

async function stageLicenses(
  grants: LicenseGrant[],
  publicKey: JsonWebKey,
  wrappingKey: CryptoKey,
): Promise<{ licenses: Map<string, CachedLicense>; materials: Map<string, SegmentKeyMaterial> }> {
  const licenses = new Map<string, CachedLicense>();
  const materials = new Map<string, SegmentKeyMaterial>();
  for (const grant of grants) {
    const payload = await attestGrant(grant, publicKey);
    const contentKey = await importContentKey(grant.key);
    const wrappedKey = await wrapContentKey(contentKey, wrappingKey);
    licenses.set(grant.segmentId, {
      segmentId: grant.segmentId,
      keyId: grant.keyId,
      keyEpoch: grant.keyEpoch,
      keyFingerprint: grant.keyFingerprint,
      token: grant.token,
      payload,
      wrappedKey,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      cachedAt: Date.now(),
    });
    materials.set(grant.segmentId, { contentKey, keyFingerprint: grant.keyFingerprint });
  }
  return { licenses, materials };
}

function allSegmentsCached(manifest: Manifest, segments: CachedSegment[]): boolean {
  const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
  return manifest.segments.every((segment) => {
    const cached = byId.get(segment.id);
    return cached && cached.keyId === segment.keyId && cached.keyEpoch === segment.keyEpoch;
  });
}

function generationPercent(progress: GenerationProgress): number {
  const ratio = progress.total > 0 ? progress.completed / progress.total : 0;
  return 28 + Math.round(ratio * 64);
}

async function requestAllLicenses(sessionId: string, manifest: Manifest): Promise<LicenseResponse> {
  return requestJson<LicenseResponse>("/api/licenses", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      segmentIds: manifest.segments.map((segment) => segment.id),
    }),
  });
}

async function bootstrapOnline(options: BootOptions): Promise<AppSnapshot> {
  options.onProgress({ label: "建立本地许可会话", percent: 6 });
  const [manifestResponse, session] = await Promise.all([
    requestJson<ManifestResponse>("/api/manifest"),
    requestJson<SessionPayload>("/api/session", { method: "POST", body: "{}" }),
  ]);
  validateManifest(manifestResponse.manifest);
  options.onProgress({ label: "向本地授权端申请片段许可", percent: 14 });

  const wrappingKey = await ensureWrappingKey();
  const initialResponse = await requestAllLicenses(session.sessionId, manifestResponse.manifest);
  if (initialResponse.licenses.length !== manifestResponse.manifest.segments.length) {
    throw new Error("License response is missing segments");
  }
  const initial = await stageLicenses(initialResponse.licenses, session.publicKey, wrappingKey);
  const fingerprint = await compositeFingerprint(initialResponse.licenses);
  const cachedMeta = await getMeta<CacheMeta>(CACHE_META_KEY);
  const cachedSegments = await getAllSegments();
  const canReuse =
    Boolean(cachedMeta?.initSegment) &&
    cachedMeta?.generatedKeyFingerprint === fingerprint &&
    allSegmentsCached(manifestResponse.manifest, cachedSegments);

  let finalSegments = cachedSegments;
  let finalMeta = cachedMeta;
  if (!canReuse) {
    options.onProgress({ label: "缓存缺失或密钥代次变化，重新生成媒体", percent: 20 });
    try {
      const generated = await generateAndCacheMedia(manifestResponse.manifest, initial.materials, (progress) => {
        options.onProgress({ label: progress.label, percent: generationPercent(progress) });
      });
      finalSegments = generated.segments;
      finalMeta = {
        manifest: manifestResponse.manifest,
        publicKey: session.publicKey,
        serverTime: manifestResponse.serverTime,
        clockOffsetMs: manifestResponse.serverTime - Date.now(),
        generatedKeyFingerprint: fingerprint,
        initSegment: generated.initSegment,
        initSha256: generated.initSha256,
        generatedAt: generated.generatedAt,
      };
    } catch (error) {
      await resetMediaCache();
      throw error;
    }
  }

  options.onProgress({ label: "生成完成，刷新播放许可窗口", percent: 94 });
  const freshResponse = await requestAllLicenses(session.sessionId, manifestResponse.manifest);
  const finalFingerprint = await compositeFingerprint(freshResponse.licenses);
  if (finalFingerprint !== fingerprint) {
    await resetMediaCache();
    throw new ControlledPlaybackError({
      code: "LICENSE_INVALID",
      title: "密钥在生成期间发生变化",
      guidance: "已丢弃不匹配缓存，请刷新页面重新生成。",
    });
  }
  const fresh = await stageLicenses(freshResponse.licenses, session.publicKey, wrappingKey);
  await putLicenses([...fresh.licenses.values()]);

  const serverTime = freshResponse.serverTime;
  const meta: CacheMeta = {
    manifest: manifestResponse.manifest,
    publicKey: session.publicKey,
    serverTime,
    clockOffsetMs: serverTime - Date.now(),
    generatedKeyFingerprint: fingerprint,
    initSegment: finalMeta?.initSegment ?? new ArrayBuffer(0),
    initSha256: finalMeta?.initSha256 ?? "",
    generatedAt: finalMeta?.generatedAt ?? Date.now(),
  };
  await putMeta(CACHE_META_KEY, meta);
  options.onProgress({ label: "受控播放器就绪", percent: 100 });
  return {
    manifest: manifestResponse.manifest,
    licenses: fresh.licenses,
    segments: new Map(finalSegments.map((segment) => [segment.segmentId, segment])),
    meta,
    offline: false,
    sessionId: session.sessionId,
  };
}

async function bootstrapOffline(options: BootOptions): Promise<AppSnapshot> {
  options.onProgress({ label: "读取离线缓存与许可证明", percent: 20 });
  const meta = await getMeta<CacheMeta>(CACHE_META_KEY);
  const segments = await getAllSegments();
  const licenseList = await getAllLicenses();
  if (!meta?.initSegment || !allSegmentsCached(meta.manifest, segments)) {
    throw new ControlledPlaybackError({
      code: "OFFLINE_CACHE_MISSING",
      title: "离线缓存不完整",
      guidance: "断网状态只允许播放完整、已缓存的合法内容。请联机完成预热后再试。",
      recoverable: true,
    });
  }

  const licenses = new Map<string, CachedLicense>();
  for (const license of licenseList) {
    await verifyCachedLicense(license, meta.publicKey);
    licenses.set(license.segmentId, license);
  }
  for (const segment of meta.manifest.segments) {
    if (!licenses.has(segment.id)) {
      throw new ControlledPlaybackError({
        code: "LICENSE_MISSING",
        title: "缓存片段缺少许可证明",
        guidance: "离线时不会绕过许可读取未证明的缓存内容。",
        segmentId: segment.id,
      });
    }
  }
  options.onProgress({ label: "离线证明校验通过", percent: 100 });
  return {
    manifest: meta.manifest,
    licenses,
    segments: new Map(segments.map((segment) => [segment.segmentId, segment])),
    meta,
    offline: true,
    sessionId: null,
  };
}

export async function bootstrapPlayer(options: BootOptions): Promise<AppSnapshot> {
  try {
    return options.offline ? await bootstrapOffline(options) : await bootstrapOnline(options);
  } catch (error) {
    if (error instanceof ControlledPlaybackError) {
      throw error;
    }
    throw new ControlledPlaybackError({
      code: "UNEXPECTED",
      title: "播放器初始化失败",
      guidance: "缓存或本地服务返回了不可用状态，请查看错误详情。",
      technical: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      cause: error,
    });
  }
}
