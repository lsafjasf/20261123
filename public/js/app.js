import {
  DEFAULT_CONFIG,
  FPS_OPTIONS,
  MIN_DECEL_SEC,
  clamp,
  durationInBeats,
  fpsAnchors,
  frameToTime,
  nearestFrame,
  normalizeConfig,
  quantizeToFrame,
  shiftImpact,
  snapStartToBeats,
  timecode,
                  
} from "./model.js";
import { renderTapeStop,                   } from "./synth.js";
import { drawScene } from "./scene.js";
import { TimelineRenderer,                     } from "./timeline.js";
import { buildPackage, buildZip,                  } from "./export.js";
import { encodeOpusWebm, webCodecsStatus,                     } from "./webm.js";

function element                       (id        )    {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found     ;
}

const dom = {
  scene: element                   ("sceneCanvas"),
  timeline: element                   ("timelineCanvas"),
  monitor: element                ("monitor"),
  sessionClock: element                ("sessionClock"),
  monitorFrame: element             ("monitorFrame"),
  monitorFps: element             ("monitorFps"),
  monitorTimecode: element             ("monitorTimecode"),
  speed: element             ("speedReadout"),
  freezeFrame: element             ("freezeFrame"),
  impactFrameInput: element                  ("impactFrameInput"),
  fpsSelect: element                   ("fpsSelect"),
  impactMeta: element             ("impactMeta"),
  fpsXray: element                ("fpsXray"),
  startFrameReadout: element             ("startFrameReadout"),
  startFrameInput: element                  ("startFrameInput"),
  startMeta: element             ("startMeta"),
  bpmInput: element                  ("bpmInput"),
  beatReadout: element             ("beatReadout"),
  snapButton: element                   ("snapButton"),
  startMinus: element                   ("startMinus"),
  startPlus: element                   ("startPlus"),
  startSlider: element                  ("startSlider"),
  durationReadout: element                   ("durationReadout"),
  rateFill: element             ("rateFill"),
  previewButton: element                   ("previewButton"),
  stopButton: element                   ("stopButton"),
  autoPreview: element                  ("autoPreview"),
  audioState: element             ("audioState"),
  auditionProgress: element             ("auditionProgress"),
  playheadTC: element             ("playheadTC"),
  playheadSample: element             ("playheadSample"),
  tailVerdict: element             ("tailVerdict"),
  tailNonZero: element             ("tailNonZero"),
  tailPeak: element             ("tailPeak"),
  impactSample: element             ("impactSample"),
  lastNonZero: element             ("lastNonZero"),
  scanRange: element             ("scanRange"),
  holdReadout: element             ("holdReadout"),
  exportButton: element                   ("exportButton"),
  exportAssets: element                ("exportAssets"),
  webCodecsBadge: element             ("webCodecsBadge"),
  mseBadge: element             ("mseBadge"),
  toast: element                ("toast"),
  webmPlayer: element                  ("webmPlayer"),
};

const timeline = new TimelineRenderer(dom.timeline);
let config             = normalizeConfig(DEFAULT_CONFIG);
let result               = renderTapeStop(config);
let inspectSec = config.startSec;
let lastDisplaySec = -1;
let lastRenderedPlayhead = -1;
let userHasInteracted = false;
let autoPreviewTimer = 0;
let toastTimer = 0;

                         
                
               
                       
                                
                 
 

let audioContext                      = null;
let playback                       = null;
let playbackToken = 0;
let audioBufferCache                                              = null;
let opusProxy                        = null;

function audioStateKey(value            )         {
  return [value.startSec, value.impactSec, value.bpm, value.holdSec]
    .map((part) => part.toFixed(9))
    .join("|");
}

function replaceResult(nextConfig            , forceAudio = false)       {
  const previousState = audioStateKey(result.config);
  config = normalizeConfig(nextConfig);
  if (forceAudio || audioStateKey(config) !== previousState) {
    result = renderTapeStop(config);
    audioBufferCache = null;
    opusProxy = null;
  } else {
    result = { ...result, config };
  }
}

function showToast(message        , isError = false)       {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.toggle("is-error", isError);
  dom.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 3800);
}

function formatInteger(value        )         {
  return Math.round(value).toLocaleString("en-US");
}

function populateFps()       {
  dom.fpsSelect.innerHTML = "";
  for (const fps of FPS_OPTIONS) {
    const option = document.createElement("option");
    option.value = String(fps);
    option.textContent = `${fps % 1 === 0 ? fps.toFixed(0) : fps.toFixed(3)} fps`;
    dom.fpsSelect.append(option);
  }
  dom.fpsSelect.value = String(config.fps);
}

function renderFpsXray()       {
  dom.fpsXray.innerHTML = "";
  const anchors = fpsAnchors(config);
  for (const anchor of anchors) {
    const chip = document.createElement("span");
    chip.className = `fps-chip${Math.abs(anchor.fps - config.fps) < 0.001 ? " is-current" : ""}`;
    chip.title = `${anchor.startFrame}f → ${anchor.impactFrame}f @ ${anchor.fps} fps`;
    chip.innerHTML = `<span>${anchor.fps % 1 === 0 ? anchor.fps : anchor.fps.toFixed(2)} P</span><b>${anchor.startFrame}→${anchor.impactFrame}</b>`;
    dom.fpsXray.append(chip);
  }
}

function updateReadouts()       {
  const impactFrame = nearestFrame(config.impactSec, config.fps);
  const startFrame = nearestFrame(config.startSec, config.fps);
  dom.impactFrameInput.value = String(impactFrame);
  dom.startFrameInput.value = String(startFrame);
  dom.startFrameReadout.textContent = String(startFrame);
  dom.impactMeta.textContent = `${timecode(config.impactSec, config.fps)} · ${config.impactSec.toFixed(6)} s`;
  dom.startMeta.textContent = `FRAME / ${config.startSec.toFixed(6)} s`;
  dom.bpmInput.value = String(Math.round(config.bpm));
  dom.beatReadout.textContent = `${durationInBeats(config).toFixed(2)} BEATS`;
  dom.durationReadout.textContent = `${(config.impactSec - config.startSec).toFixed(3)} s`;
  dom.rateFill.style.transform = `scaleX(${clamp((config.impactSec - config.startSec) / config.impactSec, 0.08, 1)})`;
  const minDuration = MIN_DECEL_SEC;
  const maxDuration = config.impactSec - 0.05;
  const duration = config.impactSec - config.startSec;
  dom.startSlider.value = String(Math.round(
    (clamp(duration, minDuration, maxDuration) - minDuration)
      / Math.max(0.001, maxDuration - minDuration) * 1000,
  ));
  dom.monitorFps.textContent = `${config.fps % 1 === 0 ? config.fps.toFixed(0) : config.fps.toFixed(3)} FPS`;
  dom.freezeFrame.textContent = `FRAME ${impactFrame}`;
  dom.impactSample.textContent = formatInteger(result.timing.impactSample);
  dom.tailNonZero.textContent = formatInteger(result.analysis.postImpactNonZero);
  dom.tailPeak.textContent = result.analysis.postImpactPeak.toFixed(6);
  dom.lastNonZero.textContent = formatInteger(result.analysis.lastNonZeroSample);
  dom.scanRange.textContent = `${formatInteger(result.analysis.checkedTailSamples)} smp`;
  dom.holdReadout.textContent = `${config.holdSec.toFixed(3)} s`;
  const pass = result.analysis.postImpactNonZero === 0
    && result.analysis.postImpactPeak === 0
    && result.analysis.impactSampleIsZero;
  dom.tailVerdict.textContent = pass ? "PASS" : "FAIL";
  dom.tailVerdict.classList.toggle("is-fail", !pass);
  renderFpsXray();
}

function displayState()                                                                        {
  let timeSec = inspectSec;
  let playing = false;
  if (playback && audioContext) {
    const elapsed = audioContext.currentTime - playback.when;
    if (elapsed >= 0) {
      timeSec = playback.previewStart + elapsed;
      playing = true;
      const end = result.timing.totalSec;
      if (timeSec >= end) {
        finishPlayback();
        timeSec = config.impactSec;
      }
    }
  }
  const frozen = timeSec >= config.impactSec;
  const flash = frozen ? clamp(1 - (timeSec - config.impactSec) / 0.22, 0, 1) : 0;
  return { timeSec, frozen, flash, playing };
}

function applyDisplayState(force = false)       {
  const state = displayState();
  const timeSec = state.timeSec;
  if (!force && Math.abs(timeSec - lastDisplaySec) < 0.0005) return;
  lastDisplaySec = timeSec;
  inspectSec = state.timeSec;

  const shownFrame = state.frozen
    ? nearestFrame(config.impactSec, config.fps)
    : Math.min(nearestFrame(timeSec, config.fps), nearestFrame(config.impactSec, config.fps));
  dom.monitorFrame.textContent = String(shownFrame).padStart(3, "0");
  dom.monitorTimecode.textContent = timecode(timeSec, config.fps);
  dom.playheadTC.textContent = timecode(timeSec, config.fps);
  dom.playheadSample.textContent = `SAMPLE ${formatInteger(timeSec * result.timing.sampleRate)}`;
  dom.speed.textContent = state.frozen ? "000" : String(Math.round(312 - clamp(timeSec / config.impactSec, 0, 1) * 35));
  dom.monitor.classList.toggle("is-frozen", state.frozen);
  if (playback) {
    dom.audioState.textContent = state.frozen ? "HARD MUTE" : "PLAYING";
  }
  drawScene(dom.scene, {
    timeSec,
    config,
    playing: state.playing,
    frozen: state.frozen,
    impactFlash: state.flash,
  });
  if (force || Math.abs(timeSec - lastRenderedPlayhead) >= 0.0005) {
    timeline.draw(result, timeSec);
    lastRenderedPlayhead = timeSec;
  }
}

function cancelScheduledPreview()       {
  window.clearTimeout(autoPreviewTimer);
  autoPreviewTimer = 0;
}

function scheduleAutoPreview()       {
  if (!userHasInteracted || !dom.autoPreview.checked) return;
  cancelScheduledPreview();
  autoPreviewTimer = window.setTimeout(() => {
    void startPreview();
  }, 240);
}

function commitConfig(nextConfig            , autoAudition = true)       {
  const wasPlaying = playback !== null;
  if (wasPlaying) stopPreview();
  replaceResult(nextConfig);
  updateReadouts();
  inspectSec = config.startSec;
  applyDisplayState(true);
  if (wasPlaying || autoAudition) scheduleAutoPreview();
}

function nudgeStart(frames        )       {
  const current = nearestFrame(config.startSec, config.fps);
  const nextFrame = Math.max(0, current + frames);
  commitConfig({ ...config, startSec: frameToTime(nextFrame, config.fps) });
}

function setImpactFrame(frame        )       {
  const nextImpact = Math.max((MIN_DECEL_SEC + 0.05), frameToTime(frame, config.fps));
  commitConfig(shiftImpact(config, nextImpact));
}

async function ensureAudioContext()                        {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "interactive" });
  }
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

function getPreviewBuffer(context              )              {
  const key = audioStateKey(config);
  if (audioBufferCache?.key === key) return audioBufferCache.buffer;
  const buffer = context.createBuffer(2, result.timing.totalSamples, result.timing.sampleRate);
  buffer.copyToChannel(result.left, 0);
  buffer.copyToChannel(result.right, 1);
  audioBufferCache = { key, buffer };
  return buffer;
}

function setPlaybackUi(playing         )       {
  dom.previewButton.classList.toggle("is-playing", playing);
  dom.audioState.textContent = playing ? "PLAYING" : "READY";
  dom.previewButton.querySelector("span:nth-child(2)") .textContent = playing
    ? "RESTART TAPE STOP"
    : "PREVIEW TAPE STOP";
}

function finishPlayback()       {
  if (!playback) return;
  playbackToken += 1;
  try {
    playback.source.stop();
  } catch {
    // Already ended.
  }
  playback.source.disconnect();
  playback.gain.disconnect();
  playback = null;
  inspectSec = config.impactSec;
  setPlaybackUi(false);
  dom.auditionProgress.style.transform = "scaleX(0)";
}

function stopPreview()       {
  if (playback) {
    const elapsed = audioContext ? audioContext.currentTime - playback.when : 0;
    if (elapsed > 0) {
      inspectSec = clamp(
        playback.previewStart + elapsed,
        0,
        config.impactSec,
      );
    }
    playbackToken += 1;
    try {
      playback.source.stop();
    } catch {
      // Already ended.
    }
    playback.source.disconnect();
    playback.gain.disconnect();
    playback = null;
  }
  setPlaybackUi(false);
  dom.auditionProgress.style.transform = "scaleX(0)";
  applyDisplayState(true);
}

async function startPreview()                {
  cancelScheduledPreview();
  userHasInteracted = true;
  try {
    const context = await ensureAudioContext();
    if (playback) stopPreview();
    dom.webmPlayer.pause();
    const buffer = getPreviewBuffer(context);
    const previewStart = Math.max(0, config.startSec - 1.4);
    const when = context.currentTime + 0.055;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const impactAt = when + (config.impactSec - previewStart);
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + 0.012);
    gain.gain.setValueAtTime(1, Math.max(when + 0.012, impactAt - 0.0002));
    gain.gain.setValueAtTime(0, impactAt);

    const token = ++playbackToken;
    playback = { token, when, previewStart, source, gain };
    source.onended = () => {
      if (playback?.token !== token) return;
      finishPlayback();
      applyDisplayState(true);
    };
    source.start(when, previewStart);
    source.stop(when + (result.timing.totalSec - previewStart) + 0.08);
    setPlaybackUi(true);
    inspectSec = previewStart;
    applyDisplayState(true);
  } catch (error) {
    setPlaybackUi(false);
    showToast(`Audio preview failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function durationFromSlider(value        )         {
  const min = MIN_DECEL_SEC;
  const max = Math.max(min + 0.01, config.impactSec - 0.05);
  return min + (clamp(value, 0, 1000) / 1000) * (max - min);
}

function bindTimeline()       {
  let dragging                        = null;
  const pointerMove = (event              )       => {
    if (!dragging || dragging === "scrub") return;
    const time = quantizeToFrame(timeline.timeAt(event.clientX), config.fps);
    if (dragging === "start") {
      commitConfig({ ...config, startSec: time }, false);
    } else {
      commitConfig(shiftImpact(config, Math.max(config.startSec + MIN_DECEL_SEC, time)), false);
    }
  };
  const pointerUp = (event              )       => {
    if (!dragging) return;
    const shouldAudition = dragging !== "scrub" && dom.autoPreview.checked;
    dragging = null;
    if (dom.timeline.hasPointerCapture(event.pointerId)) {
      dom.timeline.releasePointerCapture(event.pointerId);
    }
    if (shouldAudition) scheduleAutoPreview();
  };

  dom.timeline.addEventListener("pointerdown", (event) => {
    const handle = timeline.hitTest(event.clientX);
    dragging = handle;
    dom.timeline.setPointerCapture(event.pointerId);
    if (handle === "scrub") {
      stopPreview();
      inspectSec = quantizeToFrame(timeline.timeAt(event.clientX), config.fps);
      applyDisplayState(true);
    }
    event.preventDefault();
  });
  dom.timeline.addEventListener("pointermove", pointerMove);
  dom.timeline.addEventListener("pointerup", pointerUp);
  dom.timeline.addEventListener("pointercancel", pointerUp);
}

function bindControls()       {
  dom.fpsSelect.addEventListener("change", () => {
    const fps = Number(dom.fpsSelect.value);
    if (!Number.isFinite(fps)) return;
    replaceResult({ ...config, fps }, false);
    updateReadouts();
    applyDisplayState(true);
    showToast(`FPS ${fps}: audio samples unchanged; frames remapped ${nearestFrame(config.startSec, fps)}→${nearestFrame(config.impactSec, fps)}.`);
  });

  dom.impactFrameInput.addEventListener("change", () => {
    userHasInteracted = true;
    setImpactFrame(Number(dom.impactFrameInput.value));
  });

  dom.startFrameInput.addEventListener("change", () => {
    userHasInteracted = true;
    const frame = Number(dom.startFrameInput.value);
    if (!Number.isFinite(frame)) return;
    commitConfig({ ...config, startSec: frameToTime(frame, config.fps) });
  });

  dom.bpmInput.addEventListener("change", () => {
    userHasInteracted = true;
    const bpm = Number(dom.bpmInput.value);
    if (!Number.isFinite(bpm)) return;
    commitConfig({ ...config, bpm });
  });

  dom.startMinus.addEventListener("click", () => {
    userHasInteracted = true;
    nudgeStart(-1);
  });
  dom.startPlus.addEventListener("click", () => {
    userHasInteracted = true;
    nudgeStart(1);
  });
  dom.snapButton.addEventListener("click", () => {
    userHasInteracted = true;
    commitConfig(snapStartToBeats(config, 4));
    showToast("Start snapped to four beats before impact.");
  });
  dom.startSlider.addEventListener("input", () => {
    userHasInteracted = true;
    const duration = durationFromSlider(Number(dom.startSlider.value));
    commitConfig({ ...config, startSec: config.impactSec - duration }, false);
  });
  dom.startSlider.addEventListener("change", scheduleAutoPreview);

  dom.previewButton.addEventListener("click", () => {
    userHasInteracted = true;
    void startPreview();
  });
  dom.stopButton.addEventListener("click", stopPreview);
  dom.autoPreview.addEventListener("change", () => {
    if (!dom.autoPreview.checked) cancelScheduledPreview();
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target                      ;
    if (target?.matches("input, select, textarea, button")) return;
    if (event.code === "Space") {
      event.preventDefault();
      userHasInteracted = true;
      void startPreview();
    } else if (event.key === "[") {
      userHasInteracted = true;
      nudgeStart(-1);
    } else if (event.key === "]") {
      userHasInteracted = true;
      nudgeStart(1);
    } else if (event.key === "Escape") {
      stopPreview();
    }
  });
}

function waitForEvent(
  target             ,
  type        ,
  timeoutMs = 6000,
)                {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      target.removeEventListener(type, onEvent);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const onEvent = ()       => {
      window.clearTimeout(timeout);
      target.removeEventListener(type, onEvent);
      resolve();
    };
    target.addEventListener(type, onEvent, { once: true });
  });
}

let mediaSourceUrl                = null;

async function attachToMediaSource(webm                )                {
  if (typeof MediaSource === "undefined") throw new Error("MediaSource unavailable");
  const candidates = [
    webm.mimeType,
    'audio/webm; codecs="opus"',
    "audio/webm",
  ];
  const mime = candidates.find((candidate) => MediaSource.isTypeSupported(candidate));
  if (!mime) throw new Error("No supported WebM/Opus MSE type");

  if (mediaSourceUrl) URL.revokeObjectURL(mediaSourceUrl);
  dom.webmPlayer.pause();
  const source = new MediaSource();
  mediaSourceUrl = URL.createObjectURL(source);
  const opened = waitForEvent(source, "sourceopen");
  dom.webmPlayer.src = mediaSourceUrl;
  await opened;
  const sourceBuffer = source.addSourceBuffer(mime);
  sourceBuffer.mode = "sequence";
  const appended = waitForEvent(sourceBuffer, "updateend");
  sourceBuffer.appendBuffer(await webm.blob.arrayBuffer());
  await appended;
  source.endOfStream();
  dom.mseBadge.textContent = "MEDIASOURCE · QA PASS";
  dom.mseBadge.classList.add("is-ready");
  dom.mseBadge.title = "已通过 MediaSource 挂载；点击试听 Opus 代理";
}

function downloadBlob(blob      , fileName        )       {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function timestampName()         {
  const now = new Date();
  const pad = (value        )         => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function exportPackage()                {
  if (dom.exportButton.classList.contains("is-busy")) return;
  stopPreview();
  dom.exportButton.classList.add("is-busy");
  const label = dom.exportButton.querySelector("em");
  if (label) label.textContent = "RENDERING";
  try {
    await new Promise      ((resolve) => requestAnimationFrame(() => resolve()));
    const filesExtra                = [];
    let webm                        = null;
    let codecMessage = "WebCodecs unavailable";

    if (webCodecsStatus().available) {
      try {
        if (label) label.textContent = "OPUS ENCODE";
        await new Promise      ((resolve) => requestAnimationFrame(() => resolve()));
        webm = await encodeOpusWebm(result);
        opusProxy = webm;
        filesExtra.push({
          name: "broadcast-proxy.webm",
          data: new Uint8Array(await webm.blob.arrayBuffer()),
        });
        codecMessage = `Opus ${webm.packets} packets / ${webm.encodedBytes} bytes`;
      } catch (error) {
        codecMessage = `Opus encode failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const bundleInfo = {
      generator: "APEX Tape Stop / offline event desk",
      generatedAt: new Date().toISOString(),
      config,
      fpsMap: fpsAnchors(config),
      sampleTiming: result.timing,
      tailGate: {
        nonZeroAfterImpact: result.analysis.postImpactNonZero,
        peakAfterImpact: result.analysis.postImpactPeak,
        lastNonZeroSample: result.analysis.lastNonZeroSample,
      },
      stack: {
        typescript: true,
        nodeStandardLibrary: true,
        webAudio: true,
        canvas: true,
        webCodecs: webCodecsStatus().available,
        mediaSource: typeof MediaSource !== "undefined",
      },
      codecMessage,
    };
    filesExtra.push({
      name: "bundle-info.json",
      data: new TextEncoder().encode(JSON.stringify(bundleInfo, null, 2)),
    });

    if (label) label.textContent = "PACKING";
    await new Promise      ((resolve) => requestAnimationFrame(() => resolve()));
    const bundle = buildPackage(result, filesExtra);
    const fileName = `apex-tape-stop-${timestampName()}.zip`;
    downloadBlob(new Blob([bundle.zip], { type: "application/zip" }), fileName);
    dom.exportAssets.dataset.count = String(bundle.files.length);
    showToast(`${bundle.files.length} files packed · WAV + sample map + tail proof${webm ? " + Opus preview" : ""}.`);

    if (webm) {
      dom.mseBadge.textContent = "MEDIASOURCE · LOADING";
      dom.mseBadge.classList.remove("is-ready");
      try {
        await attachToMediaSource(webm);
      } catch (error) {
        dom.mseBadge.textContent = "MEDIASOURCE · FAIL";
        dom.mseBadge.classList.remove("is-ready");
        showToast(`MediaSource preflight failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  } catch (error) {
    showToast(`Export failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    dom.exportButton.classList.remove("is-busy");
    if (label) label.textContent = "WAV + MAP + PROOF";
  }
}

function bindExport()       {
  dom.exportButton.addEventListener("click", () => {
    userHasInteracted = true;
    void exportPackage();
  });
  dom.mseBadge.addEventListener("click", () => {
    if (!dom.mseBadge.classList.contains("is-ready") || !dom.webmPlayer.src) {
      showToast("Export once to attach the Opus proxy to MediaSource.", true);
      return;
    }
    if (dom.webmPlayer.paused) {
      void dom.webmPlayer.play().catch((error) => {
        showToast(`MSE playback failed: ${String(error)}`, true);
      });
    } else {
      dom.webmPlayer.pause();
    }
  });
}

function initializeCapabilities()       {
  const codecs = webCodecsStatus();
  dom.webCodecsBadge.textContent = codecs.available ? "WEBCODECS · READY" : "WEBCODECS · N/A";
  dom.webCodecsBadge.classList.toggle("is-ready", codecs.available);
  dom.webCodecsBadge.title = codecs.reason;
  const mse = typeof MediaSource !== "undefined"
    && MediaSource.isTypeSupported('audio/webm; codecs="opus"');
  dom.mseBadge.textContent = mse ? "MEDIASOURCE · SUPPORTED" : "MEDIASOURCE · N/A";
  dom.mseBadge.classList.toggle("is-ready", false);
  dom.mseBadge.setAttribute("role", "button");
  dom.mseBadge.tabIndex = mse ? 0 : -1;
}

let startedAt = performance.now();
function updateClock()       {
  const elapsed = Math.floor((performance.now() - startedAt) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  dom.sessionClock.textContent = [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function frameLoop()       {
  const state = displayState();
  if (playback) {
    const span = Math.max(0.001, result.timing.totalSec - playback.previewStart);
    const progress = clamp((state.timeSec - playback.previewStart) / span, 0, 1);
    dom.auditionProgress.style.transform = `scaleX(${progress.toFixed(4)})`;
  }
  applyDisplayState(false);
  requestAnimationFrame(frameLoop);
}

function init()       {
  populateFps();
  updateReadouts();
  bindControls();
  bindTimeline();
  bindExport();
  initializeCapabilities();
  applyDisplayState(true);
  window.setInterval(updateClock, 1000);
  updateClock();
  const resizeObserver = new ResizeObserver(() => {
    lastDisplaySec = -1;
    lastRenderedPlayhead = -1;
    applyDisplayState(true);
  });
  resizeObserver.observe(dom.scene);
  resizeObserver.observe(dom.timeline);
  requestAnimationFrame(frameLoop);

  const debugState = ()                          => ({
    config,
    timing: result.timing,
    analysis: result.analysis,
    crossings: result.crossings,
    fpsMap: fpsAnchors(config),
    codecs: webCodecsStatus(),
    mse: typeof MediaSource !== "undefined",
    playing: playback !== null,
  });
  (window                                      ).__APEX__ = {
    state: debugState,
    preview: startPreview,
    stop: stopPreview,
    export: exportPackage,
    buildPackage: () => buildPackage(result),
    setConfig: (next                     ) => {
      commitConfig({ ...config, ...next });
      return debugState();
    },
    getResult: () => result,
  };
  console.info("[apex] tape-stop desk ready", debugState());
}

init();


//# sourceURL=app.ts