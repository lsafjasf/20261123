import { bootstrapPlayer, offlineRequested, setOfflineRequested, type BootProgress } from "./bootstrap.js";
import { deleteLocalDatabase } from "./db.js";
import { asPlaybackError, ControlledPlaybackError } from "./errors.js";
import { licenseRemainingMs } from "./licensing.js";
import { ControlledPlayer } from "./player.js";
import type { AppSnapshot, CachedLicense, SegmentDescriptor } from "./types.js";

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing UI element #${id}`);
  }
  return found as unknown as T;
}

const ui = {
  app: element<HTMLDivElement>("app"),
  video: element<HTMLVideoElement>("player"),
  bootPanel: element<HTMLDivElement>("boot-panel"),
  bootTitle: element<HTMLHeadingElement>("boot-title"),
  bootLabel: element<HTMLParagraphElement>("boot-label"),
  bootProgress: element<HTMLDivElement>("boot-progress"),
  bootBar: element<HTMLSpanElement>("boot-progress-bar"),
  bootPercent: element<HTMLSpanElement>("boot-percent"),
  startPanel: element<HTMLDivElement>("start-panel"),
  startButton: element<HTMLButtonElement>("start-button"),
  pauseWarning: element<HTMLDivElement>("pause-warning"),
  expiredResume: element<HTMLButtonElement>("expired-resume"),
  completion: element<HTMLDivElement>("completion-panel"),
  reload: element<HTMLButtonElement>("reload-button"),
  play: element<HTMLButtonElement>("play-button"),
  playIcon: element<HTMLSpanElement>("play-icon"),
  nowChapter: element<HTMLSpanElement>("now-chapter"),
  nowTitle: element<HTMLElement>("now-title"),
  currentTime: element<HTMLSpanElement>("current-time"),
  totalTime: element<HTMLSpanElement>("total-time"),
  timeline: element<HTMLDivElement>("timeline"),
  timelineSegments: element<HTMLDivElement>("timeline-segments"),
  playhead: element<HTMLDivElement>("timeline-playhead"),
  activeKey: element<HTMLSpanElement>("active-key-badge"),
  activeKeyLabel: element<HTMLSpanElement>("active-key-label"),
  hint: element<HTMLSpanElement>("transport-hint"),
  networkPill: element<HTMLSpanElement>("network-pill"),
  networkLabel: element<HTMLSpanElement>("network-label"),
  pipelinePill: element<HTMLSpanElement>("pipeline-pill"),
  offlineToggle: element<HTMLButtonElement>("offline-toggle"),
  licenseCard: document.querySelector<HTMLElement>(".license-card")!,
  licenseState: element<HTMLSpanElement>("license-state"),
  licenseSeconds: element<HTMLElement>("license-seconds"),
  licenseRing: element<SVGCircleElement>("license-ring"),
  epochTag: element<HTMLSpanElement>("epoch-tag"),
  ledger: element<HTMLDivElement>("key-ledger"),
  cacheState: element<HTMLSpanElement>("cache-state"),
  cacheBar: element<HTMLSpanElement>("cache-meter-bar"),
  cachedCount: element<HTMLElement>("cached-count"),
  cachedSize: element<HTMLElement>("cached-size"),
  cacheNote: element<HTMLParagraphElement>("cache-note"),
  inject: element<HTMLButtonElement>("inject-failure"),
  rebuild: element<HTMLButtonElement>("rebuild-cache"),
  eventLog: element<HTMLOListElement>("event-log"),
  footerTime: element<HTMLSpanElement>("footer-time"),
  errorScreen: element<HTMLElement>("error-screen"),
  errorCode: element<HTMLSpanElement>("error-code"),
  errorTitle: element<HTMLHeadingElement>("error-title"),
  errorGuidance: element<HTMLParagraphElement>("error-guidance"),
  errorSegment: element<HTMLElement>("error-segment"),
  errorPosition: element<HTMLElement>("error-position"),
  errorTime: element<HTMLElement>("error-time"),
  errorTechnical: element<HTMLElement>("error-technical"),
  errorReload: element<HTMLButtonElement>("error-reload"),
  errorCache: element<HTMLButtonElement>("error-cache"),
  toastStack: element<HTMLDivElement>("toast-stack"),
  startSegments: element<HTMLElement>("start-segments"),
};

let snapshot: AppSnapshot | null = null;
let player: ControlledPlayer | null = null;
let offline = offlineRequested();
let fatalShown = false;
let currentLicense: CachedLicense | null = null;
let started = false;
let completed = false;
let activeSegmentIndex = 0;

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function logEvent(message: string, tone: "normal" | "ok" | "warn" | "error" = "normal"): void {
  const item = document.createElement("li");
  if (tone !== "normal") {
    item.className = `is-${tone}`;
  }
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 8);
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  ui.eventLog.prepend(item);
  while (ui.eventLog.children.length > 18) {
    ui.eventLog.lastElementChild?.remove();
  }
}

function toast(message: string, tone: "normal" | "warn" | "error" = "normal"): void {
  const node = document.createElement("div");
  node.className = tone === "normal" ? "toast" : `toast is-${tone}`;
  node.textContent = message;
  ui.toastStack.append(node);
  window.setTimeout(() => node.remove(), 4_200);
}

function updateNetworkUi(): void {
  ui.offlineToggle.setAttribute("aria-pressed", String(offline));
  ui.offlineToggle.querySelector("span:last-child")!.textContent = offline ? "返回本地联机" : "模拟断网";
  ui.networkPill.classList.toggle("is-offline", offline);
  ui.networkLabel.textContent = offline ? "离线缓存模式" : "本地联机";
  ui.pipelinePill.classList.toggle("is-offline", offline);
  ui.cacheNote.textContent = offline
    ? "离线硬闸门已启用：只读取本地缓存，并逐片段校验许可与哈希。"
    : "联机预热已完成；即使切到断网模式，播放也只从本地缓存解封。";
}

function setBootProgress(progress: BootProgress): void {
  const safePercent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  ui.bootBar.style.width = `${safePercent}%`;
  ui.bootPercent.textContent = `${safePercent}%`;
  ui.bootProgress.setAttribute("aria-valuenow", String(safePercent));
  ui.bootLabel.textContent = progress.label;
}

function renderCourse(appSnapshot: AppSnapshot): void {
  const { manifest, segments } = appSnapshot;
  ui.totalTime.textContent = formatClock(manifest.durationMs);
  ui.startSegments.textContent = String(manifest.segments.length);
  ui.timelineSegments.replaceChildren();
  ui.ledger.replaceChildren();

  manifest.segments.forEach((segment, index) => {
    const bar = document.createElement("div");
    bar.className = "timeline__segment";
    if (segment.rotation === "rotated") {
      bar.classList.add("is-rotated");
    }
    bar.style.setProperty("--segment-duration", String(segment.durationMs));
    bar.style.setProperty("--segment-accent", segment.accent);
    bar.title = `${segment.chapter} · ${segment.title}`;
    const fill = document.createElement("span");
    fill.dataset.fill = String(index);
    bar.append(fill);
    ui.timelineSegments.append(bar);

    const row = document.createElement("div");
    row.className = "ledger-row";
    if (segment.rotation === "rotated") {
      row.classList.add("is-rotated");
    }
    row.dataset.segment = segment.id;
    const rowIndex = document.createElement("span");
    rowIndex.className = "ledger-row__index";
    rowIndex.textContent = String(segment.ordinal).padStart(2, "0");
    const copy = document.createElement("span");
    copy.className = "ledger-row__copy";
    const keyName = document.createElement("strong");
    keyName.textContent = segment.keyId;
    const rotation = document.createElement("span");
    rotation.textContent =
      segment.rotation === "rotated" ? "边界轮换 · 新密钥代次" : segment.rotation === "initial" ? "初始代次" : "同代次延续";
    copy.append(keyName, rotation);
    const epoch = document.createElement("span");
    epoch.className = "ledger-row__epoch";
    epoch.textContent = `EPOCH ${String(segment.keyEpoch).padStart(2, "0")}`;
    row.append(rowIndex, copy, epoch);
    ui.ledger.append(row);
  });

  const totalBytes = [...segments.values()].reduce((total, segment) => total + segment.ciphertext.byteLength, 0);
  ui.cachedCount.textContent = `${segments.size}/${manifest.segments.length}`;
  ui.cachedSize.textContent = formatBytes(totalBytes);
  ui.cacheBar.style.width = `${(segments.size / manifest.segments.length) * 100}%`;
  ui.cacheState.textContent = segments.size === manifest.segments.length ? "缓存完整" : "缓存不完整";
  ui.cacheState.style.color = segments.size === manifest.segments.length ? "var(--mint)" : "var(--red)";
  updateNetworkUi();
}

function renderSegment(segment: SegmentDescriptor, index: number): void {
  activeSegmentIndex = index;
  ui.nowChapter.textContent = `${segment.chapter} · EPOCH ${String(segment.keyEpoch).padStart(2, "0")}`;
  ui.nowTitle.textContent = segment.title;
  ui.activeKeyLabel.textContent = `KEY ${segment.keyId.toUpperCase()}`;
  ui.activeKey.classList.add("is-live");
  ui.epochTag.textContent = `EPOCH ${String(segment.keyEpoch).padStart(2, "0")}`;
  ui.hint.textContent = segment.rotation === "rotated"
    ? "已跨过密钥轮换边界：本片段使用新代次材料"
    : "播放器将在片段边界校验许可";

  ui.timelineSegments.querySelectorAll<HTMLElement>(".timeline__segment").forEach((node, nodeIndex) => {
    node.classList.toggle("is-active", nodeIndex === index);
  });
  ui.ledger.querySelectorAll<HTMLElement>(".ledger-row").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.segment === segment.id);
  });
}

function renderProgress(currentTimeMs: number): void {
  if (!snapshot) {
    return;
  }
  ui.currentTime.textContent = formatClock(currentTimeMs);
  const total = snapshot.manifest.durationMs;
  ui.playhead.style.left = `${Math.max(0, Math.min(100, (currentTimeMs / total) * 100))}%`;

  let start = 0;
  snapshot.manifest.segments.forEach((segment, index) => {
    const fill = ui.timelineSegments.querySelector<HTMLElement>(`[data-fill="${index}"]`);
    if (!fill) {
      return;
    }
    const segmentEnd = start + segment.durationMs;
    let ratio = 0;
    if (currentTimeMs >= segmentEnd) {
      ratio = 1;
    } else if (currentTimeMs > start) {
      ratio = (currentTimeMs - start) / segment.durationMs;
    }
    fill.style.width = `${ratio * 100}%`;
    start = segmentEnd;
  });
}

function renderPlaybackState(playing: boolean, currentTimeMs: number): void {
  ui.play.classList.toggle("is-playing", playing);
  ui.play.setAttribute("aria-label", playing ? "暂停" : "播放");
  renderProgress(currentTimeMs);
}

function renderLicense(remainingMs: number, license: CachedLicense | null): void {
  currentLicense = license;
  const windowMs = snapshot?.manifest.policy.licenseTtlMs ?? 30_000;
  const clamped = Math.max(0, remainingMs);
  const ratio = Math.max(0, Math.min(1, clamped / windowMs));
  ui.licenseSeconds.textContent = (clamped / 1000).toFixed(1);
  ui.licenseRing.style.strokeDashoffset = String(320.44 * (1 - ratio));
  ui.licenseCard.classList.toggle("is-warning", clamped > 0 && clamped < 8_000);
  ui.licenseCard.classList.toggle("is-expired", clamped <= 0);
  if (!license) {
    ui.licenseState.textContent = "未签发";
    return;
  }
  if (clamped <= 0) {
    ui.licenseState.textContent = "已过期";
    ui.licenseState.style.color = "var(--red)";
  } else if (clamped < 8_000) {
    ui.licenseState.textContent = "即将到期";
    ui.licenseState.style.color = "var(--yellow)";
  } else {
    ui.licenseState.textContent = "有效";
    ui.licenseState.style.color = "var(--mint)";
  }
}

function segmentLabel(segmentId: string | null): string {
  if (!segmentId) {
    return "—";
  }
  const segment = snapshot?.manifest.segments.find((candidate) => candidate.id === segmentId);
  return segment ? `${segment.id} · ${segment.title}` : segmentId;
}

function showFatal(error: ControlledPlaybackError): void {
  if (fatalShown) {
    return;
  }
  fatalShown = true;
  player?.pause();
  ui.errorCode.textContent = error.code;
  ui.errorTitle.textContent = error.title;
  ui.errorGuidance.textContent = error.guidance;
  ui.errorSegment.textContent = segmentLabel(error.segmentId);
  ui.errorPosition.textContent = `${formatClock(ui.video.currentTime * 1000)} / ${formatClock((snapshot?.manifest.durationMs ?? 0))}`;
  ui.errorTime.textContent = new Date().toISOString().replace("T", " ").slice(0, 19);
  ui.errorTechnical.textContent = [
    `code=${error.code}`,
    `segment=${error.segmentId ?? "none"}`,
    `recoverable=${String(error.recoverable)}`,
    error.technical,
  ]
    .filter(Boolean)
    .join("\n");
  ui.errorScreen.hidden = false;
  ui.app.inert = true;
  logEvent(`${error.code} · ${error.title}`, "error");
  ui.errorReload.focus({ preventScroll: true });
}

function handleUnexpected(error: unknown): void {
  const playbackError = asPlaybackError(error, snapshot?.manifest.segments[activeSegmentIndex]?.id);
  showFatal(playbackError);
}

function playerEvents() {
  return {
    onSegment(segment: SegmentDescriptor, _index: number, license: CachedLicense) {
      renderSegment(segment, _index);
      renderLicense(licenseRemainingMs(license, snapshot?.meta.clockOffsetMs ?? 0), license);
      logEvent(`片段 ${segment.id} 通过许可闸门`, "ok");
    },
    onKeyRotation(fromEpoch: number, toEpoch: number, segment: SegmentDescriptor) {
      ui.epochTag.textContent = `EPOCH ${String(toEpoch).padStart(2, "0")}`;
      toast(`密钥已在片段边界轮换：EPOCH ${String(fromEpoch).padStart(2, "0")} → ${String(toEpoch).padStart(2, "0")}`);
      logEvent(`密钥轮换 ${fromEpoch} → ${toEpoch} · ${segment.keyId}`, "warn");
    },
    onLicenseTick(remainingMs: number, license: CachedLicense | null) {
      renderLicense(remainingMs, license);
    },
    onPlayback(playing: boolean, currentTimeMs: number) {
      renderPlaybackState(playing, currentTimeMs);
    },
    onExpiredWhilePaused() {
      ui.startPanel.hidden = true;
      ui.pauseWarning.hidden = false;
      ui.play.disabled = true;
      ui.hint.textContent = "许可窗口已关闭：恢复操作将被受控拒绝";
      logEvent("暂停期间许可到期，恢复闸门已锁定", "warn");
    },
    onCompleted() {
      completed = true;
      ui.completion.hidden = false;
      ui.play.disabled = true;
      ui.hint.textContent = "全部片段在许可边界内完成";
      logEvent("课程播放完成 · 最后一次许可校验通过", "ok");
    },
    onFatal(error: ControlledPlaybackError) {
      showFatal(error);
    },
  };
}

async function mountSnapshot(appSnapshot: AppSnapshot): Promise<void> {
  snapshot = appSnapshot;
  renderCourse(appSnapshot);
  player = new ControlledPlayer(ui.video, appSnapshot, playerEvents());
  await player.prepare();
  ui.bootPanel.hidden = true;
  ui.startPanel.hidden = false;
  ui.play.disabled = true;
  ui.nowChapter.textContent = "就绪 / 等待开始";
  ui.nowTitle.textContent = appSnapshot.manifest.title;
  ui.activeKeyLabel.textContent = "KEY PRECHECKED";
  ui.hint.textContent = offline ? "离线缓存已校验，点击开始逐片段解封" : "播放将逐片段校验、解密并追加";
  logEvent(offline ? "离线预热校验完成" : "联机预热与许可签发完成", "ok");
}

async function registerShellCache(): Promise<void> {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    return;
  }
  try {
    await navigator.serviceWorker.register("/js/sw.js", { scope: "/" });
    logEvent("应用壳离线缓存已注册", "normal");
  } catch (error) {
    logEvent(`应用壳缓存注册失败：${error instanceof Error ? error.message : String(error)}`, "warn");
  }
}

async function boot(): Promise<void> {
  updateNetworkUi();
  ui.pipelinePill.title = MediaSource.isTypeSupported('video/webm; codecs="vp8,opus"')
    ? "VP8 + Opus / MSE 可用"
    : "当前浏览器不支持 VP8 + Opus / MSE";
  logEvent("本地设备启动 · 检查 WebCodecs 与缓存");
  void registerShellCache();
  try {
    try {
      await mountSnapshot(
        await bootstrapPlayer({
          offline,
          onProgress: (progress) => setBootProgress(progress),
        }),
      );
    } catch (error) {
      if (offline || !(error instanceof ControlledPlaybackError) || error.code !== "NETWORK_ERROR") {
        throw error;
      }
      offline = true;
      setOfflineRequested(true);
      updateNetworkUi();
      logEvent("本地服务不可达，自动回退到已验证离线缓存", "warn");
      setBootProgress({ label: "本地服务不可达，尝试已验证离线缓存", percent: 18 });
      await mountSnapshot(
        await bootstrapPlayer({
          offline: true,
          onProgress: (progress) => setBootProgress(progress),
        }),
      );
    }
  } catch (error) {
    handleUnexpected(error);
  }
}

async function startPlayback(): Promise<void> {
  if (!player || !snapshot || started) {
    return;
  }
  started = true;
  ui.startPanel.hidden = true;
  ui.play.disabled = false;
  logEvent(`开始播放 · ${offline ? "OFFLINE" : "ONLINE"} / CACHE-SOURCE`);
  await player.play();
}

function reloadWithCache(keepOffline: boolean): void {
  setOfflineRequested(keepOffline);
  window.location.reload();
}

function resetCacheAndReload(): void {
  setOfflineRequested(false);
  void deleteLocalDatabase().finally(() => window.location.reload());
}

ui.startButton.addEventListener("click", () => {
  void startPlayback();
});

ui.play.addEventListener("click", () => {
  if (!player) {
    return;
  }
  if (!started) {
    void startPlayback();
    return;
  }
  if (ui.video.paused) {
    void player.play();
  } else {
    player.pause();
  }
});

ui.expiredResume.addEventListener("click", () => {
  void player?.play();
});

ui.offlineToggle.addEventListener("click", () => {
  offline = !offline;
  setOfflineRequested(offline);
  updateNetworkUi();
  toast(offline ? "已进入模拟断网：仅允许本地缓存与有效许可" : "已恢复本地联机标识（播放仍读取缓存）", offline ? "warn" : "normal");
  logEvent(offline ? "切换 OFFLINE · 缓存硬闸门启用" : "切换 ONLINE · 不自动放宽缓存策略", offline ? "warn" : "normal");
});

ui.inject.addEventListener("click", () => {
  if (!player || completed) {
    toast("当前没有可注入的片段切换", "warn");
    return;
  }
  player.injectNextSwitchFailure();
  toast("已安排下一片段切换失败，用于验证错误页收敛", "warn");
  logEvent("故障演练：下一片段切换将失败", "warn");
});

ui.rebuild.addEventListener("click", () => {
  if (offline) {
    toast("重建缓存需要本地联机，请先返回联机模式", "warn");
    return;
  }
  resetCacheAndReload();
});

ui.reload.addEventListener("click", () => reloadWithCache(false));

ui.errorReload.addEventListener("click", () => reloadWithCache(false));
ui.errorCache.addEventListener("click", resetCacheAndReload);

window.addEventListener("online", () => {
  if (!offlineRequested()) {
    offline = false;
    updateNetworkUi();
    logEvent("浏览器恢复网络；缓存策略不变", "normal");
  }
});

window.addEventListener("offline", () => {
  logEvent("浏览器报告网络离线；本地缓存策略保持启用", "warn");
  toast("网络已断开；播放仍只读取本地缓存", "warn");
});

window.addEventListener("error", (event) => {
  if (!fatalShown) {
    handleUnexpected(event.error ?? new Error(event.message));
  }
});

window.addEventListener("unhandledrejection", (event) => {
  if (!fatalShown) {
    handleUnexpected(event.reason);
  }
});

window.setInterval(() => {
  ui.footerTime.textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}, 1_000);
ui.footerTime.textContent = new Date().toLocaleString("zh-CN", { hour12: false });

void boot();
