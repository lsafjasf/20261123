// 主入口：DOM 接线、播放循环（WebAudio 提示音）、锚点编辑、导出
import { Player } from './player.ts';
import { AppState } from './state.ts';
import { drawOverlay } from './overlay.ts';
import { parseLog, serializeLog, detectStartup, detectRuns, type CandidateAnchor } from '../shared/logparse.ts';
import { buildFrameIndex, eventsToCsv } from '../shared/sync.ts';
import { momentView } from '../shared/viewmodel.ts';
import { demoLog, demoAnchors, demoCombos } from '../shared/demo.ts';
import { generateDemoVideo } from './demogen.ts';
import { encodeFrames, verifyWithMse, downloadBlob } from './exporter.ts';
import { renderCandidates, renderAnchorTable, renderSegments, renderEventTable, drawTimeline } from './ui.ts';
import type { Anchor, ComboDef } from '../shared/types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlayCanvas = $<HTMLCanvasElement>('overlay');
const timeline = $<HTMLCanvasElement>('timeline');
const player = new Player(video);
const state = new AppState();
let candidates: CandidateAnchor[] = [];
let beeper: AudioContext | null = null;

// ---------- 工具 ----------
function status(id: string, msg: string): void { $(id).textContent = msg; }
function show(id: string): void { $(id).classList.remove('hidden'); }

function beep(freq: number, dur = 0.05): void {
  if (!$<HTMLInputElement>('chk-beep').checked) return;
  beeper ??= new AudioContext();
  const osc = beeper.createOscillator();
  const gain = beeper.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, beeper.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, beeper.currentTime + dur);
  osc.connect(gain).connect(beeper.destination);
  osc.start();
  osc.stop(beeper.currentTime + dur);
}

// ---------- 叠加层刷新 ----------
function refreshOverlay(): void {
  if (player.framePts.length === 0) return;
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 360;
  if (overlayCanvas.width !== w) { overlayCanvas.width = w; overlayCanvas.height = h; }
  const ctx = overlayCanvas.getContext('2d')!;
  const frame = player.currentFrame();
  const ptsMs = frame >= 0 ? player.framePts[frame] : video.currentTime * 1000;
  const seg = state.segmentAtVideo(ptsMs);
  const mv = state.mapping
    ? momentView(state.mapped, state.comboWindows, ptsMs, seg.confidence, seg.flags)
    : { pressed: [], combos: [], confidence: 0, flags: ['no-mapping'] };
  const inPause = state.frameIndex?.pauses.some((p) =>
    ptsMs > state.frameIndex!.frames[p.afterFrame].pts &&
    ptsMs < state.frameIndex!.frames[p.afterFrame].pts + p.gapMs) ?? false;
  drawOverlay(ctx, w, h, {
    frame, ptsMs, logMs: null, confidence: mv.confidence, flags: mv.flags,
    pressed: mv.pressed, combos: mv.combos, paused: inPause,
  });
  $('frame-status').textContent =
    `帧 ${frame}/${player.frameCount - 1}  PTS ${ptsMs.toFixed(1)}ms`;
  drawTimeline(timeline, state, player);
}

// ---------- 播放循环（rVFC 驱动叠加层与提示音） ----------
let lastBeepT = 0;
function startOverlayLoop(): void {
  const loop = (): void => {
    refreshOverlay();
    if (!video.paused && !video.ended) {
      const now = video.currentTime * 1000;
      for (const e of state.mapped) {
        if (e.videoT > lastBeepT && e.videoT <= now) beep(e.state === 'down' ? 880 : 440);
      }
      lastBeepT = now;
      video.requestVideoFrameCallback(() => loop());
    }
  };
  video.requestVideoFrameCallback(() => loop());
}

// ---------- 映射/锚点 UI 刷新 ----------
function refreshMappingUI(): void {
  renderAnchorTable(document.querySelector('#anchor-table tbody')!, state, (id) => {
    state.removeAnchor(id);
    refreshMappingUI();
  });
  renderSegments($('segment-list'), state);
  renderEventTable($('event-table-wrap'), state);
  renderCandidates($('candidate-list'), candidates,
    new Set(state.anchors.map((a) => a.logT)), locateCandidate);
  refreshOverlay();
}

function locateCandidate(c: CandidateAnchor): void {
  const idx = state.log?.events.findIndex((e) => e.t >= c.logT && e.state === 'down') ?? -1;
  state.selectedEvent = idx;
  status('scan-status', `已选中候选「${c.label}」：请逐帧走到对应画面，再点「在当前帧添加人工锚点」`);
  $('btn-add-anchor').textContent = `确认锚点 @日志${c.logT}ms`;
  $('btn-add-anchor').dataset.logt = String(c.logT);
}

// ---------- 文件载入 ----------
$('file-video').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  player.loadFile(f);
  show('stage');
  status('io-status', `已载入视频 ${f.name}，请点击「扫描帧索引」`);
});

function loadLogText(text: string): void {
  state.log = parseLog(text);
  state.recompute();
  show('anchors');
  refreshMappingUI();
  status('io-status', `日志 ${state.log.events.length} 条事件`);
}

$('file-log').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadLogText(await f.text());
});

$('file-anchors').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  state.anchors = JSON.parse(await f.text()) as Anchor[];
  state.recompute();
  refreshMappingUI();
});

$('file-combos').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  state.comboDefs = JSON.parse(await f.text()) as ComboDef[];
  state.recompute();
  refreshMappingUI();
});

// ---------- 演示模式 ----------
$('btn-demo').addEventListener('click', async () => {
  const btn = $('btn-demo') as HTMLButtonElement;
  btn.disabled = true;
  try {
    status('io-status', '正在生成演示视频（WebCodecs 编码中）…');
    const blob = await generateDemoVideo((f) => {
      status('io-status', `生成演示视频 ${(f * 100).toFixed(0)}%`);
    });
    player.loadUrl(URL.createObjectURL(blob));
    state.log = demoLog();
    state.anchors = demoAnchors();
    state.comboDefs = demoCombos();
    state.recompute();
    show('stage'); show('anchors');
    refreshMappingUI();
    status('io-status', '演示数据就绪：请点击「扫描帧索引」，随后可导出标注视频验证。');
  } finally {
    btn.disabled = false;
  }
});

// ---------- 帧索引扫描 ----------
$('btn-scan').addEventListener('click', async () => {
  const btn = $('btn-scan') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const pts = await player.scanFrames(4, (done, total) => {
      status('scan-status', `扫描帧索引… ${(done / total * 100).toFixed(0)}%`);
    });
    state.frameIndex = buildFrameIndex(pts);
    state.recompute();
    status('scan-status',
      `帧索引完成：${pts.length} 帧，中位帧长 ${state.frameIndex.medianFrameMs.toFixed(2)}ms，` +
      `暂停 ${state.frameIndex.pauses.length} 处`);
    for (const id of ['btn-play', 'btn-prev', 'btn-next', 'btn-add-anchor']) {
      ($(id) as HTMLButtonElement).disabled = false;
    }
    show('export'); show('events');
    refreshMappingUI();
    startOverlayLoop();
  } finally {
    btn.disabled = false;
  }
});

// ---------- 播放控制 ----------
$('btn-play').addEventListener('click', () => {
  if (video.paused) { lastBeepT = video.currentTime * 1000; void video.play(); $('btn-play').textContent = '暂停'; startOverlayLoop(); }
  else { video.pause(); $('btn-play').textContent = '播放'; }
});
$('btn-prev').addEventListener('click', async () => {
  const f = player.currentFrame();
  if (f > 0) { await player.seekFrame(f - 1); refreshOverlay(); }
});
$('btn-next').addEventListener('click', async () => {
  const f = player.currentFrame();
  if (f >= 0 && f < player.frameCount - 1) { await player.seekFrame(f + 1); refreshOverlay(); }
});
timeline.addEventListener('click', async (e) => {
  if (player.framePts.length === 0) return;
  const rect = timeline.getBoundingClientRect();
  const frac = (e.clientX - rect.left - 10) / (rect.width - 20);
  const t0 = player.framePts[0];
  const t1 = player.framePts[player.framePts.length - 1];
  const target = t0 + frac * (t1 - t0);
  let best = 0;
  for (let i = 0; i < player.framePts.length; i++) {
    if (Math.abs(player.framePts[i] - target) < Math.abs(player.framePts[best] - target)) best = i;
  }
  await player.seekFrame(best);
  refreshOverlay();
});

// ---------- 锚点 ----------
$('btn-suggest').addEventListener('click', () => {
  if (!state.log) { status('scan-status', '请先载入手柄日志'); return; }
  const startup = detectStartup(state.log.events);
  candidates = [...(startup ? [startup] : []), ...detectRuns(state.log.events)];
  refreshMappingUI();
});

$('btn-add-anchor').addEventListener('click', () => {
  const frame = player.currentFrame();
  if (frame < 0) return;
  const videoT = player.framePts[frame];
  const btn = $('btn-add-anchor') as HTMLButtonElement;
  let logT = Number(btn.dataset.logt);
  if (!Number.isFinite(logT) || logT <= 0) {
    const sel = state.selectedEvent >= 0 ? state.log?.events[state.selectedEvent] : null;
    const input = window.prompt('该画面对应的日志时间（毫秒）', sel ? String(sel.t) : '');
    if (input === null) return;
    logT = Number(input);
    if (!Number.isFinite(logT)) return;
  }
  state.addAnchor('manual', logT, videoT, `帧${frame}`);
  btn.dataset.logt = '';
  btn.textContent = '在当前帧添加人工锚点';
  refreshMappingUI();
});

// ---------- 导出 ----------
$('btn-export-events').addEventListener('click', () => {
  if (state.mapped.length === 0) return;
  downloadBlob(new Blob([eventsToCsv(state.mapped)], { type: 'text/csv' }), 'events.csv');
});

$('btn-export-mapping').addEventListener('click', () => {
  if (!state.mapping) return;
  const payload = {
    mapping: state.mapping,
    anchors: state.anchors,
    combos: state.comboDefs,
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'mapping.json');
});

$('btn-export-video').addEventListener('click', async () => {
  if (player.framePts.length === 0 || !state.mapping) return;
  const btn = $('btn-export-video') as HTMLButtonElement;
  btn.disabled = true;
  const progress = $<HTMLProgressElement>('export-progress');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext('2d')!;
    const blob = await encodeFrames({
      canvas,
      framePts: player.framePts,
      onProgress: (f) => { progress.value = f; status('export-status', `编码 ${(f * 100).toFixed(0)}%`); },
      draw: async (i) => {
        await player.seekFrame(i);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        refreshOverlay();
        ctx.drawImage(overlayCanvas, 0, 0);
      },
    });
    status('export-status', `封装完成 ${(blob.size / 1024 / 1024).toFixed(2)}MB，MSE 校验中…`);
    const dur = await verifyWithMse(blob, $<HTMLVideoElement>('verify-video'));
    status('export-status', `校验通过：可播放时长 ${dur.toFixed(2)}s`);
    downloadBlob(blob, 'annotated.webm');
  } catch (err) {
    status('export-status', `导出失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
  }
});

// 事件表行点击 → 选中事件（供人工锚点参考）
$('event-table-wrap').addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest('tr');
  if (!tr || !tr.dataset.idx) return;
  state.selectedEvent = Number(tr.dataset.idx);
  const ev = state.log?.events[state.selectedEvent];
  if (ev) status('scan-status', `已选事件 #${ev.t}ms ${ev.btn} ${ev.state}`);
});
