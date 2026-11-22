import {
  BlobRangeReader,
  HttpRangeReader,
  demuxMp4,
  type AudioTrack,
  type ByteRangeReader
} from "./mp4.ts";
import { ReviewPlayer, type PlayerSnapshot } from "./player.ts";
import { ViewportRenderer } from "./renderer.ts";
import { formatClock, formatTimecode } from "./timeline.ts";

interface ReviewDebugApi {
  snapshot(): PlayerSnapshot | null;
  step(delta: number): void;
  goTo(frameNumber: number): void;
  redraw(): void;
  thumbnails(): { gopId: number; frameNumber: number; timestamp: number } | null;
}

declare global {
  interface Window {
    frameReview?: ReviewDebugApi;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

const ui = {
  sourceName: byId("sourceName"),
  engineBadge: byId("engineBadge"),
  openButton: byId<HTMLButtonElement>("openButton"),
  fileInput: byId<HTMLInputElement>("fileInput"),
  trackLabel: byId("trackLabel"),
  formatLabel: byId("formatLabel"),
  precisionPill: byId("precisionPill"),
  decodeClock: byId("decodeClock"),
  viewport: byId("viewport"),
  viewer: byId<HTMLCanvasElement>("viewer"),
  previewCanvas: byId<HTMLCanvasElement>("previewCanvas"),
  previewTag: byId("previewTag"),
  viewerIdle: byId("viewerIdle"),
  viewerError: byId("viewerError"),
  watermarkFrame: byId("watermarkFrame"),
  timecode: byId("timecode"),
  fpsFact: byId("fpsFact"),
  gopFact: byId("gopFact"),
  offsetFact: byId("offsetFact"),
  timelineWrap: byId("timelineWrap"),
  timelineTip: byId("timelineTip"),
  tipFrame: byId("tipFrame"),
  tipTime: byId("tipTime"),
  timeline: byId("timeline"),
  keyframeTicks: byId("keyframeTicks"),
  timelineBuffer: byId("timelineBuffer"),
  playhead: byId("playhead"),
  prevButton: byId<HTMLButtonElement>("prevButton"),
  playButton: byId<HTMLButtonElement>("playButton"),
  playGlyph: byId("playGlyph"),
  nextButton: byId<HTMLButtonElement>("nextButton"),
  backJump: byId<HTMLButtonElement>("backJump"),
  forwardJump: byId<HTMLButtonElement>("forwardJump"),
  frameNow: byId("frameNow"),
  frameTotal: byId("frameTotal"),
  muteButton: byId<HTMLButtonElement>("muteButton"),
  muteGlyph: byId("muteGlyph"),
  volume: byId<HTMLInputElement>("volume"),
  heroFrame: byId("heroFrame"),
  heroTotal: byId("heroTotal"),
  heroStatus: byId("heroStatus"),
  gopCounter: byId("gopCounter"),
  gopProgress: byId("gopProgress"),
  gopRange: byId("gopRange"),
  gopKey: byId("gopKey"),
  orderFact: byId("orderFact"),
  cacheBadge: byId("cacheBadge"),
  cacheMeter: byId("cacheMeter"),
  cacheFrames: byId("cacheFrames"),
  cacheBytes: byId("cacheBytes"),
  audioState: byId("audioState"),
  audioList: byId("audioList"),
  footerStatus: byId("footerStatus")
};

const renderer = new ViewportRenderer(ui.viewport, ui.viewer, ui.previewCanvas);
let player: ReviewPlayer | null = null;
let dragging = false;
let loadGeneration = 0;
let muted = false;
let previewFrameNumber: number | null = null;

function padFrame(frameNumber: number): string {
  return String(frameNumber + 1).padStart(4, "0");
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
}

function languageName(track: AudioTrack): string {
  const names: Record<string, string> = {
    eng: "English",
    chi: "中文",
    zho: "中文",
    jpn: "日本語",
    und: "未标注"
  };
  return names[track.language] ?? (track.language?.toUpperCase() || "未标注");
}

function renderAudioTracks(trackList: AudioTrack[]): void {
  ui.audioList.replaceChildren();
  if (trackList.length === 0) {
    const empty = document.createElement("span");
    empty.className = "inspect-note";
    empty.textContent = "当前素材没有音频轨道";
    ui.audioList.append(empty);
    return;
  }
  trackList.forEach((track, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "audio-option";
    button.dataset.trackId = String(track.trackId);
    button.innerHTML = `
      <span class="audio-index">A${index + 1}</span>
      <span><strong>${languageName(track)}</strong><small>${track.channels} ch · ${Math.round(track.sampleRate / 1000)} kHz</small></span>
      <span class="audio-codec">AAC</span>
    `;
    button.addEventListener("click", () => {
      void player?.selectAudioTrack(track.trackId);
      button.blur();
    });
    ui.audioList.append(button);
  });
}

function buildKeyframeTicks(): void {
  ui.keyframeTicks.replaceChildren();
  if (!player) return;
  for (const frame of player.timeline.frames) {
    if (!frame.isKeyframe) continue;
    const tick = document.createElement("span");
    tick.className = "gop-tick";
    tick.style.left = `${(frame.frameNumber / Math.max(1, player.timeline.frames.length)) * 100}%`;
    tick.title = `GOP ${padFrame(frame.frameNumber)}`;
    ui.keyframeTicks.append(tick);
  }
}

function showLoadError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ui.viewerIdle.hidden = true;
  ui.viewerError.hidden = false;
  const title = document.createElement("strong");
  title.textContent = "素材载入失败";
  const detail = document.createElement("span");
  detail.textContent = message;
  const hint = document.createElement("span");
  hint.textContent = "请使用 Chromium / Edge，并选择 H.264 + AAC 的 MP4 文件。";
  ui.viewerError.replaceChildren(title, detail, hint);
  ui.precisionPill.textContent = "载入失败";
  ui.precisionPill.className = "precision-pill error";
  ui.footerStatus.textContent = message;
}

async function loadMedia(reader: ByteRangeReader, name: string): Promise<void> {
  const generation = ++loadGeneration;
  player?.destroy();
  player = null;
  window.frameReview = undefined;
  renderer.reset();
  renderer.clearPreview();
  ui.previewTag.hidden = true;
  ui.timelineTip.hidden = true;
  ui.viewerError.hidden = true;
  ui.viewerIdle.hidden = false;
  ui.sourceName.textContent = name;
  ui.precisionPill.textContent = "建立索引";
  ui.precisionPill.className = "precision-pill";

  try {
    const loaded = await demuxMp4(reader);
    if (generation !== loadGeneration) return;
    const videoTrack = loaded.videoTracks[0];
    const nextPlayer = new ReviewPlayer(reader, loaded, videoTrack);
    player = nextPlayer;
    window.frameReview = {
      snapshot: () => nextPlayer.snapshot,
      step: (delta) => nextPlayer.step(delta),
      goTo: (frameNumber) => nextPlayer.goTo(frameNumber),
      redraw: () => nextPlayer.redraw(),
      thumbnails: () => nextPlayer.thumbnailDebug
    };
    ui.trackLabel.textContent = `V${videoTrack.id}`;
    ui.formatLabel.textContent = `${videoTrack.width} × ${videoTrack.height} · ${videoTrack.codec}`;
    ui.fpsFact.textContent = `${nextPlayer.timeline.fps.toFixed(2)} fps`;
    ui.frameTotal.textContent = padFrame(nextPlayer.timeline.frames.length - 1);
    ui.heroTotal.textContent = `/ ${padFrame(nextPlayer.timeline.frames.length - 1)}`;
    ui.timeline.setAttribute("aria-valuemax", String(nextPlayer.timeline.frames.length - 1));
    renderAudioTracks(loaded.audioTracks);
    buildKeyframeTicks();

    nextPlayer.onFrame((frame, frameNumber) => {
      renderer.drawFrame(frame);
      renderer.clearPreview();
      ui.previewTag.hidden = true;
      previewFrameNumber = null;
    });
    nextPlayer.onPreview((bitmap, frameNumber, _gopId) => {
      previewFrameNumber = frameNumber;
      renderer.drawPreview(bitmap);
      ui.previewTag.hidden = false;
      ui.previewTag.textContent = `I 帧低清预览 · ${padFrame(frameNumber)}`;
    });
    nextPlayer.subscribe(updateInterface);
    ui.viewerIdle.hidden = true;
    nextPlayer.start();
  } catch (error) {
    if (generation === loadGeneration) showLoadError(error);
  }
}

function updateInterface(snapshot: PlayerSnapshot): void {
  if (!player) return;
  const timeline = player.timeline;
  const target = timeline.frameAt(snapshot.targetFrame);
  const total = timeline.frames.length;
  const exact = snapshot.displayedFrame === snapshot.targetFrame && !snapshot.decoding;
  const gopFrames = timeline.gopFrames(target.gopId);
  const gopFirst = gopFrames[0]?.frameNumber ?? target.frameNumber;
  const gopLast = gopFrames.at(-1)?.frameNumber ?? target.frameNumber;
  const gopIndex = Math.max(0, gopFrames.findIndex((frame) => frame.frameNumber === target.frameNumber));
  const gopCount = new Set(timeline.frames.map((frame) => frame.gopId)).size;
  const gopNumber = [...new Set(timeline.frames.map((frame) => frame.gopId))].indexOf(target.gopId) + 1;

  ui.frameNow.textContent = padFrame(snapshot.targetFrame);
  ui.heroFrame.textContent = padFrame(snapshot.targetFrame);
  ui.watermarkFrame.textContent = padFrame(snapshot.targetFrame);
  ui.timecode.textContent = formatTimecode(target, timeline.fps);
  ui.gopFact.textContent = `${gopLast - gopFirst + 1}F`;
  ui.offsetFact.textContent = target.decodeIndex - target.frameNumber > 0
    ? `+${target.decodeIndex - target.frameNumber}`
    : String(target.decodeIndex - target.frameNumber);
  ui.gopCounter.textContent = `GOP ${String(gopNumber).padStart(2, "0")} / ${String(gopCount).padStart(2, "0")}`;
  ui.gopProgress.style.width = `${((gopIndex + 1) / Math.max(1, gopFrames.length)) * 100}%`;
  ui.gopRange.textContent = `${padFrame(gopFirst)} — ${padFrame(gopLast)}`;
  ui.gopKey.textContent = `#${padFrame(target.gopKeyframeFrame)}${target.isKeyframe ? " · 当前" : ""}`;
  ui.orderFact.textContent = `${padFrame(target.frameNumber)} / ${padFrame(target.decodeIndex)}`;
  ui.heroStatus.textContent = exact
    ? `最终帧已命中 · DEC ${padFrame(target.decodeIndex)}`
    : snapshot.decoding
      ? `正在解码目标 GOP · ${gopNumber}/${gopCount}`
      : "等待目标帧";

  if (snapshot.error) {
    ui.precisionPill.textContent = "解码错误";
    ui.precisionPill.className = "precision-pill error";
    ui.footerStatus.textContent = snapshot.error;
  } else if (snapshot.previewActive) {
    ui.precisionPill.textContent = "低清预览";
    ui.precisionPill.className = "precision-pill preview";
    ui.footerStatus.textContent = `关键帧预览 #${padFrame(previewFrameNumber ?? target.frameNumber)} · 等待最终帧`;
  } else if (exact && !snapshot.playing) {
    ui.precisionPill.textContent = "最终帧";
    ui.precisionPill.className = "precision-pill exact";
    ui.footerStatus.textContent = `精确显示 #${padFrame(target.frameNumber)} · ${target.ctsSeconds.toFixed(3)} s`;
  } else {
    ui.precisionPill.textContent = "解码目标帧";
    ui.precisionPill.className = "precision-pill";
    ui.footerStatus.textContent = `GOP ${gopNumber}/${gopCount} · 从解码序 ${padFrame(target.gopStartDecodeIndex)} 起`;
  }
  ui.decodeClock.textContent = `${snapshot.videoStats.lastDecodeMs.toFixed(1)} ms`;

  const cache = snapshot.videoStats.cache;
  ui.cacheBadge.textContent = `${cache.gops} / ${cache.maxGops}`;
  ui.cacheFrames.textContent = String(cache.frames);
  ui.cacheBytes.textContent = megabytes(cache.bytes);
  ui.cacheMeter.style.width = `${Math.min(100, (cache.bytes / cache.maxBytes) * 100)}%`;
  ui.audioState.textContent = snapshot.audioState.toUpperCase();

  const ratio = total <= 1 ? 0 : target.frameNumber / (total - 1);
  ui.playhead.style.left = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  ui.timelineBuffer.style.width = `${Math.min(100, ((target.frameNumber + 1) / total) * 100)}%`;
  ui.timeline.setAttribute("aria-valuenow", String(target.frameNumber));
  ui.timeline.setAttribute("aria-valuetext", `${padFrame(target.frameNumber)}, ${formatTimecode(target, timeline.fps)}`);

  ui.playButton.classList.toggle("playing", snapshot.playing);
  ui.playButton.title = snapshot.playing ? "暂停 (Space)" : "播放 (Space)";
  ui.playButton.setAttribute("aria-label", snapshot.playing ? "暂停" : "播放");
  for (const button of ui.audioList.querySelectorAll<HTMLButtonElement>(".audio-option")) {
    button.classList.toggle("active", Number(button.dataset.trackId) === snapshot.audioTrackId);
  }
  if (snapshot.previewActive && !renderer.hasPreview) ui.previewTag.hidden = false;
  if (!snapshot.previewActive && snapshot.displayedFrame === snapshot.targetFrame) {
    renderer.clearPreview();
    ui.previewTag.hidden = true;
  }
}

function pointerPosition(clientX: number): { seconds: number; ratio: number } {
  const rect = ui.timeline.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  const duration = player?.timeline.durationSeconds ?? 0;
  return { seconds: ratio * duration, ratio };
}

function updateTimelineTip(ratio: number, seconds: number): void {
  if (!player) return;
  const frame = player.timeline.frameAtTime(seconds);
  const width = ui.timeline.getBoundingClientRect().width;
  const left = Math.max(52, Math.min(width - 52, ratio * width));
  ui.timelineTip.style.left = `${left}px`;
  ui.timelineTip.hidden = false;
  ui.tipFrame.textContent = `FRAME ${padFrame(frame.frameNumber)}`;
  ui.tipTime.textContent = formatClock(frame.ctsSeconds);
}

function pointTimeline(clientX: number): void {
  if (!player) return;
  const { seconds, ratio } = pointerPosition(clientX);
  updateTimelineTip(ratio, seconds);
  player.scrubTo(seconds, 120);
}

function bindTimeline(): void {
  ui.timeline.addEventListener("pointerdown", (event) => {
    if (!player) return;
    event.preventDefault();
    dragging = true;
    ui.timeline.setPointerCapture(event.pointerId);
    player.beginScrub();
    pointTimeline(event.clientX);
  });
  ui.timeline.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    pointTimeline(event.clientX);
  });
  const finish = (event: PointerEvent): void => {
    if (!dragging || !player) return;
    dragging = false;
    const { seconds } = pointerPosition(event.clientX);
    updateTimelineTip(Math.max(0, Math.min(1, (event.clientX - ui.timeline.getBoundingClientRect().left) /
      Math.max(1, ui.timeline.getBoundingClientRect().width))), seconds);
    player.endScrub(seconds);
    window.setTimeout(() => {
      if (!dragging) ui.timelineTip.hidden = true;
    }, 420);
    try {
      ui.timeline.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be released by the browser first.
    }
  };
  ui.timeline.addEventListener("pointerup", finish);
  ui.timeline.addEventListener("pointercancel", finish);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input, textarea, select, [contenteditable='true']");
}

function bindKeyboard(): void {
  window.addEventListener("keydown", (event) => {
    if (!player || isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === " " && event.target instanceof HTMLButtonElement) return;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      const direction = key === "ArrowRight" ? 1 : -1;
      player.step(direction * (event.shiftKey ? 10 : 1));
    } else if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      player.step(key === "PageDown" ? 10 : -10);
    } else if (key === "Home") {
      event.preventDefault();
      player.goTo(0);
    } else if (key === "End") {
      event.preventDefault();
      player.goTo(player.timeline.frames.length - 1);
    } else if (key === " ") {
      event.preventDefault();
      void player.togglePlay();
    } else if (key === "," || key === ".") {
      event.preventDefault();
      player.step(key === "." ? 1 : -1);
    }
  });
}

function bindControls(): void {
  const buttons = [
    ui.prevButton,
    ui.playButton,
    ui.nextButton,
    ui.backJump,
    ui.forwardJump,
    ui.openButton,
    ui.muteButton
  ];
  for (const button of buttons) {
    button.addEventListener("click", () => button.blur());
  }
  ui.prevButton.addEventListener("click", () => player?.step(-1));
  ui.nextButton.addEventListener("click", () => player?.step(1));
  ui.backJump.addEventListener("click", () => player?.step(-10));
  ui.forwardJump.addEventListener("click", () => player?.step(10));
  ui.playButton.addEventListener("click", () => {
    void player?.togglePlay();
  });
  ui.muteButton.addEventListener("click", () => {
    muted = !muted;
    ui.muteButton.classList.toggle("muted", muted);
    ui.muteButton.title = muted ? "取消静音" : "静音";
    ui.muteButton.setAttribute("aria-label", muted ? "取消静音" : "静音");
    ui.muteGlyph.textContent = muted ? "MUTE" : "VOL";
    player?.setMuted(muted);
  });
  ui.volume.addEventListener("input", () => {
    player?.setVolume(Number(ui.volume.value) / 100);
  });
  ui.openButton.addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", () => {
    const file = ui.fileInput.files?.[0];
    if (!file) return;
    void loadMedia(new BlobRangeReader(file), file.name);
    ui.fileInput.value = "";
  });
}

function bindFileDrop(): void {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (!file || !/\.(mp4|mov|m4v)$/i.test(file.name)) return;
    void loadMedia(new BlobRangeReader(file), file.name);
  });
}

async function boot(): Promise<void> {
  ui.volume.value = "80";
  bindTimeline();
  bindKeyboard();
  bindControls();
  bindFileDrop();
  ui.engineBadge.textContent = typeof VideoDecoder === "undefined" ? "NO WEBCODECS" : "WEBCODECS READY";
  if (typeof VideoDecoder === "undefined" || typeof AudioDecoder === "undefined") {
    showLoadError(new Error("当前浏览器缺少 WebCodecs 解码能力"));
    return;
  }

  const observer = new ResizeObserver(() => {
    renderer.resize();
    player?.redraw();
  });
  observer.observe(ui.viewport);
  window.addEventListener("beforeunload", () => {
    observer.disconnect();
    player?.destroy();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) player?.pause();
  });

  try {
    const reader = await HttpRangeReader.open("/media/demo-video.mp4");
    await loadMedia(reader, "demo-video.mp4 · 48F GOP · 2 AUDIO");
  } catch (error) {
    showLoadError(error);
  }
}

void boot();
