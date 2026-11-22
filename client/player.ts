import {
  decryptSegment,
  sha256Base64Url,
  unwrapContentKey,
} from "./crypto.js";
import { getMeta } from "./db.js";
import { ControlledPlaybackError, asPlaybackError } from "./errors.js";
import { assertLicenseUsable, licenseRemainingMs, trustedNow } from "./licensing.js";
import type { AppSnapshot, CachedLicense, SegmentDescriptor } from "./types.js";

export interface PlayerEvents {
  onSegment: (segment: SegmentDescriptor, index: number, license: CachedLicense) => void;
  onKeyRotation: (fromEpoch: number, toEpoch: number, segment: SegmentDescriptor) => void;
  onLicenseTick: (remainingMs: number, license: CachedLicense | null) => void;
  onPlayback: (playing: boolean, currentTimeMs: number) => void;
  onExpiredWhilePaused: () => void;
  onCompleted: () => void;
  onFatal: (error: ControlledPlaybackError) => void;
}

const MIME_TYPE = 'video/webm; codecs="vp8,opus"';

function waitForUpdate(sourceBuffer: SourceBuffer): Promise<void> {
  if (!sourceBuffer.updating) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onEnd);
      sourceBuffer.removeEventListener("error", onError);
      sourceBuffer.removeEventListener("abort", onAbort);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("SourceBuffer append failed"));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("SourceBuffer append aborted"));
    };
    sourceBuffer.addEventListener("updateend", onEnd, { once: true });
    sourceBuffer.addEventListener("error", onError, { once: true });
    sourceBuffer.addEventListener("abort", onAbort, { once: true });
  });
}

async function appendData(sourceBuffer: SourceBuffer, data: BufferSource): Promise<void> {
  if (sourceBuffer.updating) {
    await waitForUpdate(sourceBuffer);
  }
  sourceBuffer.appendBuffer(data);
  await waitForUpdate(sourceBuffer);
}

export class ControlledPlayer {
  readonly #video: HTMLVideoElement;
  readonly #snapshot: AppSnapshot;
  readonly #events: PlayerEvents;
  #mediaSource: MediaSource | null = null;
  #sourceBuffer: SourceBuffer | null = null;
  #objectUrl: string | null = null;
  #segmentIndex = 0;
  #started = false;
  #stopped = false;
  #transitioning = false;
  #completed = false;
  #expiredWhilePaused = false;
  #faultOnNextSwitch = false;
  #timer = 0;
  #prefetchedIndex = -1;
  #prefetchedLicense: CachedLicense | null = null;

  constructor(video: HTMLVideoElement, snapshot: AppSnapshot, events: PlayerEvents) {
    this.#video = video;
    this.#snapshot = snapshot;
    this.#events = events;
    this.#bindVideo();
  }

  get currentSegment(): SegmentDescriptor | null {
    return this.#snapshot.manifest.segments[this.#segmentIndex] ?? null;
  }

  get currentLicense(): CachedLicense | null {
    const segment = this.currentSegment;
    return segment ? (this.#snapshot.licenses.get(segment.id) ?? null) : null;
  }

  get isPlaying(): boolean {
    return !this.#video.paused && !this.#video.ended;
  }

  get isPrepared(): boolean {
    return Boolean(this.#sourceBuffer) && !this.#stopped;
  }

  injectNextSwitchFailure(): void {
    this.#faultOnNextSwitch = true;
  }

  #bindVideo(): void {
    this.#video.addEventListener("play", () => {
      if (this.#stopped) {
        this.#video.pause();
        return;
      }
      if (this.#expiredWhilePaused) {
        this.#fail(
          new ControlledPlaybackError({
            code: "LICENSE_EXPIRED",
            title: "恢复播放被拒绝",
            guidance: "暂停时间已越过许可窗口。过期的密钥材料不能继续使用，请重新联机申请许可。",
            segmentId: this.currentSegment?.id,
            recoverable: true,
          }),
        );
        return;
      }
      this.#events.onPlayback(true, this.#video.currentTime * 1000);
    });
    this.#video.addEventListener("pause", () => {
      this.#events.onPlayback(false, this.#video.currentTime * 1000);
    });
    this.#video.addEventListener("timeupdate", () => {
      this.#events.onPlayback(!this.#video.paused, this.#video.currentTime * 1000);
    });
    this.#video.addEventListener("ended", () => {
      if (this.#segmentIndex >= this.#snapshot.manifest.segments.length - 1) {
        this.#completed = true;
        window.clearInterval(this.#timer);
        this.#events.onCompleted();
      }
    });
    this.#video.addEventListener("error", () => {
      this.#fail(
        new ControlledPlaybackError({
          code: "MEDIA_APPEND_FAILED",
          title: "媒体管线报告解码错误",
          guidance: "播放器已停止，不会留下无响应的空白画面。",
          segmentId: this.currentSegment?.id,
          technical: this.#video.error?.message ?? `MediaError ${this.#video.error?.code ?? "unknown"}`,
        }),
      );
    });
  }

  async prepare(): Promise<void> {
    if (!MediaSource.isTypeSupported(MIME_TYPE)) {
      throw new ControlledPlaybackError({
        code: "UNSUPPORTED_API",
        title: "MediaSource 不支持 VP8/Opus",
        guidance: "请使用 Chrome 或 Edge 的当前版本。",
        technical: MIME_TYPE,
      });
    }
    if ((await sha256Base64Url(this.#snapshot.meta.initSegment)) !== this.#snapshot.meta.initSha256) {
      throw new ControlledPlaybackError({
        code: "SEGMENT_HASH_MISMATCH",
        title: "媒体初始化段校验失败",
        guidance: "缓存容器头被破坏，播放器不会挂载 MediaSource。",
      });
    }
    const mediaSource = new MediaSource();
    this.#mediaSource = mediaSource;
    this.#objectUrl = URL.createObjectURL(mediaSource);
    this.#video.src = this.#objectUrl;
    await new Promise<void>((resolve, reject) => {
      mediaSource.addEventListener(
        "sourceopen",
        () => {
          resolve();
        },
        { once: true },
      );
      mediaSource.addEventListener(
        "sourceended",
        () => reject(new Error("MediaSource ended before it opened")),
        { once: true },
      );
    });
    const sourceBuffer = mediaSource.addSourceBuffer(MIME_TYPE);
    this.#sourceBuffer = sourceBuffer;
    sourceBuffer.mode = "segments";
    await appendData(sourceBuffer, this.#snapshot.meta.initSegment);
    mediaSource.duration = this.#snapshot.manifest.durationMs / 1000;
    sourceBuffer.addEventListener("error", () => {
      this.#fail(
        new ControlledPlaybackError({
          code: "MEDIA_APPEND_FAILED",
          title: "媒体缓冲区进入错误状态",
          guidance: "播放器已停止。可重新联机或刷新页面重建缓存。",
          segmentId: this.currentSegment?.id,
        }),
      );
    });
    this.#startTicker();
  }

  async play(): Promise<void> {
    if (this.#stopped || this.#completed) {
      return;
    }
    const segment = this.currentSegment;
    if (!segment) {
      return;
    }
    try {
      assertLicenseUsable(this.#snapshot.licenses.get(segment.id), segment, this.#snapshot.meta.clockOffsetMs);
    } catch (error) {
      this.#fail(asPlaybackError(error, segment.id));
      return;
    }
    if (!this.#started) {
      this.#started = true;
      const playback = this.#video.play();
      try {
        const prepared = await this.#loadSegmentData(0);
        this.#commitSegment(0, prepared.license);
        this.#video.currentTime = 0;
        await playback;
      } catch (error) {
        this.#fail(asPlaybackError(error, this.currentSegment?.id));
      }
      return;
    }
    try {
      await this.#video.play();
    } catch (error) {
      this.#fail(asPlaybackError(error, segment.id));
    }
  }

  pause(): void {
    this.#video.pause();
  }

  async #loadSegmentData(index: number): Promise<{ segment: SegmentDescriptor; license: CachedLicense }> {
    const segment = this.#snapshot.manifest.segments[index];
    const sourceBuffer = this.#sourceBuffer;
    if (!segment || !sourceBuffer) {
      throw new Error("Segment or SourceBuffer unavailable");
    }
    if (index > 0 && this.#faultOnNextSwitch) {
      this.#faultOnNextSwitch = false;
      throw new ControlledPlaybackError({
        code: "SEGMENT_SWITCH_FAILED",
        title: "片段切换失败（受控故障注入）",
        guidance: "播放器已停在错误页。真实链路发生同类异常时也不会回退到白屏。",
        segmentId: segment.id,
        recoverable: true,
      });
    }

    const license = this.#snapshot.licenses.get(segment.id);
    assertLicenseUsable(license, segment, this.#snapshot.meta.clockOffsetMs);
    const cached = this.#snapshot.segments.get(segment.id);
    if (!cached) {
      throw new ControlledPlaybackError({
        code: "SEGMENT_NOT_CACHED",
        title: "片段不在离线缓存中",
        guidance: "断网时只允许播放已缓存的合法片段，播放器不会尝试访问网络。",
        segmentId: segment.id,
      });
    }
    if (cached.keyId !== segment.keyId || cached.keyEpoch !== segment.keyEpoch) {
      throw new ControlledPlaybackError({
        code: "LICENSE_INVALID",
        title: "缓存片段与当前密钥代次不一致",
        guidance: "播放器拒绝把旧代次材料用于新片段。",
        segmentId: segment.id,
      });
    }
    if ((await sha256Base64Url(cached.ciphertext)) !== cached.ciphertextSha256) {
      throw new ControlledPlaybackError({
        code: "SEGMENT_HASH_MISMATCH",
        title: "片段完整性校验失败",
        guidance: "缓存内容被破坏，播放器已停止且不会提交到解码器。",
        segmentId: segment.id,
      });
    }

    const wrappingKey = await getMeta<CryptoKey>("wrappingKey");
    if (!wrappingKey) {
      throw new ControlledPlaybackError({
        code: "DECRYPT_FAILED",
        title: "设备密钥包装器丢失",
        guidance: "缓存密钥无法解封，请联机重建离线缓存。",
        segmentId: segment.id,
      });
    }

    let plaintext: ArrayBuffer;
    try {
      const contentKey = await unwrapContentKey(license.wrappedKey, wrappingKey);
      plaintext = await decryptSegment(cached.ciphertext, cached.iv, contentKey);
    } catch (error) {
      throw new ControlledPlaybackError({
        code: "DECRYPT_FAILED",
        title: "片段解密失败",
        guidance: "密钥材料与片段不匹配，播放被拒绝。",
        segmentId: segment.id,
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    if (plaintext.byteLength !== cached.plaintextSize) {
      throw new ControlledPlaybackError({
        code: "SEGMENT_HASH_MISMATCH",
        title: "解密后片段长度异常",
        guidance: "为避免解码器收到损坏数据，播放器已停止。",
        segmentId: segment.id,
      });
    }

    try {
      await appendData(sourceBuffer, plaintext);
    } catch (error) {
      throw new ControlledPlaybackError({
        code: "MEDIA_APPEND_FAILED",
        title: "片段无法追加到 MediaSource",
        guidance: "媒体管线已停止，不会退化为空白播放器。",
        segmentId: segment.id,
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }

    return { segment, license };
  }

  #commitSegment(index: number, license: CachedLicense): void {
    const segment = this.#snapshot.manifest.segments[index];
    if (!segment) {
      return;
    }
    const previousEpoch = this.currentSegment?.keyEpoch ?? segment.keyEpoch;
    this.#segmentIndex = index;
    this.#expiredWhilePaused = false;
    if (previousEpoch !== segment.keyEpoch) {
      this.#events.onKeyRotation(previousEpoch, segment.keyEpoch, segment);
    }
    this.#events.onSegment(segment, index, license);
  }

  #startTicker(): void {
    const tick = () => {
      if (this.#stopped || this.#completed) {
        return;
      }
      const license = this.currentLicense;
      if (!license) {
        return;
      }
      const remaining = licenseRemainingMs(license, this.#snapshot.meta.clockOffsetMs);
      this.#events.onLicenseTick(remaining, license);
      const segment = this.currentSegment;
      if (segment && !this.#video.paused && !this.#transitioning) {
        const segmentStart = this.#segmentStartMs(this.#segmentIndex);
        const segmentEnd = segmentStart + segment.durationMs;
        const currentTimeMs = this.#video.currentTime * 1000;
        const nextIndex = this.#segmentIndex + 1;
        if (
          this.#prefetchedIndex !== nextIndex &&
          nextIndex < this.#snapshot.manifest.segments.length &&
          currentTimeMs >= segmentEnd - 1_200
        ) {
          void this.#prefetchNext();
          return;
        }
        if (this.#prefetchedIndex === nextIndex && currentTimeMs >= segmentEnd - 16) {
          const nextSegment = this.#snapshot.manifest.segments[nextIndex];
          try {
            if (nextSegment) {
              assertLicenseUsable(
                this.#prefetchedLicense ?? undefined,
                nextSegment,
                this.#snapshot.meta.clockOffsetMs,
              );
              this.#commitSegment(nextIndex, this.#prefetchedLicense as CachedLicense);
            }
            this.#prefetchedIndex = -1;
            this.#prefetchedLicense = null;
          } catch (error) {
            this.#fail(asPlaybackError(error, nextSegment?.id));
          }
          return;
        }
      }
      if (trustedNow(this.#snapshot.meta.clockOffsetMs) < license.expiresAt) {
        return;
      }
      if (remaining <= 0) {
        if (this.#video.paused) {
          if (!this.#expiredWhilePaused) {
            this.#expiredWhilePaused = true;
            this.#events.onExpiredWhilePaused();
          }
          return;
        }
        this.#fail(
          new ControlledPlaybackError({
            code: "LICENSE_EXPIRED",
            title: "许可到期，播放立即停止",
            guidance: "暂停和后台停留都会消耗许可窗口。请重新联机获取新许可。",
            segmentId: this.currentSegment?.id,
            recoverable: true,
          }),
        );
      }
    };
    tick();
    this.#timer = window.setInterval(tick, 200);
  }

  #segmentStartMs(index: number): number {
    return this.#snapshot.manifest.segments
      .slice(0, index)
      .reduce((total, segment) => total + segment.durationMs, 0);
  }

  async #prefetchNext(): Promise<void> {
    if (this.#stopped || this.#completed || this.#transitioning) {
      return;
    }
    const nextIndex = this.#segmentIndex + 1;
    const nextSegment = this.#snapshot.manifest.segments[nextIndex];
    if (!nextSegment) {
      return;
    }
    this.#transitioning = true;
    try {
      const prepared = await this.#loadSegmentData(nextIndex);
      this.#prefetchedIndex = nextIndex;
      this.#prefetchedLicense = prepared.license;
      if (nextIndex === this.#snapshot.manifest.segments.length - 1 && this.#mediaSource?.readyState === "open") {
        this.#mediaSource.endOfStream();
      }
    } catch (error) {
      this.#fail(asPlaybackError(error, nextSegment.id));
    } finally {
      this.#transitioning = false;
    }
  }

  #fail(error: ControlledPlaybackError): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    window.clearInterval(this.#timer);
    this.#video.pause();
    this.#events.onFatal(error);
  }

  destroy(): void {
    this.#stopped = true;
    window.clearInterval(this.#timer);
    this.#video.pause();
    if (this.#sourceBuffer?.updating) {
      try {
        this.#sourceBuffer.abort();
      } catch {
        // The buffer may already be detached.
      }
    }
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }
    this.#video.removeAttribute("src");
    this.#video.load();
  }
}
