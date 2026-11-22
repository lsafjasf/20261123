// UI wiring: preview, anchors, charts, frame list, playback, export.
import { Chart } from './chart.ts';
import { encodeVideo } from './encoder.ts';
import {
  analyze, buildOutputPlan, loadFrames, renderAligned,
} from './pipeline.ts';
import type { LoadedFrame } from './pipeline.ts';
import type { Anchor, Anomaly, FrameAnalysis, PhotoMeta } from './types.ts';
import { IDENTITY } from './types.ts';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const preview = $<HTMLCanvasElement>('#preview');
const pctx = preview.getContext('2d')!;
const statusEl = $('#status');
const frameInfoEl = $('#frame-info');
const frameListEl = $('#frame-list');
const anomalyListEl = $('#anomaly-list');
const anomalyCountEl = $('#anomaly-count');
const resultVideo = $<HTMLVideoElement>('#result-video');

const residualChart = new Chart($<HTMLCanvasElement>('#chart-residual'), '对齐残差 (px)');
const exposureChart = new Chart($<HTMLCanvasElement>('#chart-exposure'), '曝光 (EV)');

const W = preview.width;
const H = preview.height;

interface State {
  photos: PhotoMeta[];
  frames: LoadedFrame[];
  anchors: Anchor[];
  analysis: FrameAnalysis[];
  skipped: boolean[];
  dwell: number[];
  current: number;
  playing: boolean;
  addAnchorMode: boolean;
  nextAnchorId: number;
}

const state: State = {
  photos: [],
  frames: [],
  anchors: [],
  analysis: [],
  skipped: [],
  dwell: [],
  current: 0,
  playing: false,
  addAnchorMode: false,
  nextAnchorId: 1,
};

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// --- playback clock (WebAudio) ---
const audio = new AudioContext();
let playStartAudioTime = 0;
let playStartFrame = 0;

function fps(): number {
  return Math.max(1, Math.min(60, Number($<HTMLInputElement>('#fps').value) || 12));
}

function tick(): void {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.05, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.05);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.06);
}

function outputPlan(): number[] {
  return buildOutputPlan(state.analysis, state.dwell);
}

function playLoop(): void {
  if (!state.playing) return;
  const plan = outputPlan();
  if (!plan.length) { stopPlayback(); return; }
  const elapsed = audio.currentTime - playStartAudioTime;
  const outIdx = (playStartFrame + Math.floor(elapsed * fps())) % plan.length;
  const srcIdx = plan[outIdx];
  if (srcIdx !== state.current) {
    state.current = srcIdx;
    tick();
    drawPreview();
    updateFrameInfo();
    highlightCurrentCard();
  }
  requestAnimationFrame(playLoop);
}

function startPlayback(): void {
  if (!state.analysis.length) return;
  void audio.resume();
  state.playing = true;
  playStartAudioTime = audio.currentTime;
  playStartFrame = 0;
  $<HTMLButtonElement>('#btn-play').textContent = '⏸ 停止';
  requestAnimationFrame(playLoop);
}

function stopPlayback(): void {
  state.playing = false;
  $<HTMLButtonElement>('#btn-play').textContent = '▶ 预览';
}

// --- preview rendering ---
function currentAnalysis(): FrameAnalysis | null {
  return state.analysis[state.current] ?? null;
}

function drawPreview(): void {
  const frame = state.frames[state.current];
  if (!frame) return;
  const a = currentAnalysis();
  renderAligned(pctx, frame, a?.transform ?? IDENTITY, a?.evCorrection ?? 0, W, H);

  // anchor overlay (drawn in reference coordinates)
  for (const anchor of state.anchors) {
    pctx.strokeStyle = '#e8c547';
    pctx.lineWidth = 1.5;
    pctx.beginPath();
    pctx.arc(anchor.x, anchor.y, 8, 0, Math.PI * 2);
    pctx.moveTo(anchor.x - 12, anchor.y);
    pctx.lineTo(anchor.x + 12, anchor.y);
    pctx.moveTo(anchor.x, anchor.y - 12);
    pctx.lineTo(anchor.x, anchor.y + 12);
    pctx.stroke();
    pctx.fillStyle = '#e8c547';
    pctx.font = '11px system-ui';
    pctx.fillText(`A${anchor.id}`, anchor.x + 10, anchor.y - 10);
  }
}

function updateFrameInfo(): void {
  const a = currentAnalysis();
  if (!a) {
    frameInfoEl.textContent = state.frames.length
      ? `帧 ${state.current + 1}/${state.frames.length}（尚未分析）`
      : '—';
    return;
  }
  const t = a.transform;
  frameInfoEl.textContent =
    `帧 ${a.index + 1}/${state.analysis.length} · ${a.name} · ` +
    `平移(${t.tx.toFixed(1)}, ${t.ty.toFixed(1)})px 缩放 ${t.s.toFixed(4)} · ` +
    `残差 ${a.residualPx.toFixed(2)}px · 曝光校正 ${a.evCorrection >= 0 ? '+' : ''}${a.evCorrection.toFixed(2)}EV` +
    (a.skipped ? ' · 已跳过' : '') +
    (state.dwell[a.index] ? ` · 停留 +${state.dwell[a.index]}` : '');
}

// --- charts & anomaly list ---
function refreshCharts(): void {
  residualChart.setSeries([{
    label: '残差',
    color: '#5ac8fa',
    values: state.analysis.map((a) => a.residualPx),
  }]);
  exposureChart.setSeries([
    { label: '实测', color: '#ff9f5a', values: state.analysis.map((a) => a.evRaw) },
    { label: '趋势', color: '#7ee787', values: state.analysis.map((a) => a.evTrend), dashed: true },
    { label: '校正', color: '#c580ff', values: state.analysis.map((a) => a.evCorrection) },
  ]);
}

function collectAnomalies(): Anomaly[] {
  const list: Anomaly[] = [];
  for (const a of state.analysis) {
    for (const msg of a.anomalies) {
      const kind = msg.startsWith('对齐') ? 'alignment' : 'exposure';
      list.push({ frame: a.index + 1, name: a.name, kind, detail: msg });
    }
    if (a.skipped) list.push({ frame: a.index + 1, name: a.name, kind: 'skipped', detail: '用户跳过' });
  }
  return list;
}

function refreshAnomalyList(): void {
  const list = collectAnomalies();
  anomalyCountEl.textContent = `(${list.length})`;
  anomalyListEl.innerHTML = '';
  for (const item of list) {
    const li = document.createElement('li');
    if (item.kind === 'skipped') li.className = 'warn';
    li.textContent = `#${item.frame} ${item.name} — ${item.detail}`;
    li.addEventListener('click', () => jumpToFrame(item.frame - 1));
    anomalyListEl.appendChild(li);
  }
}

function jumpToFrame(i: number): void {
  state.current = Math.max(0, Math.min(state.frames.length - 1, i));
  residualChart.setCursor(state.current);
  exposureChart.setCursor(state.current);
  drawPreview();
  updateFrameInfo();
  highlightCurrentCard();
}

// --- frame list ---
function highlightCurrentCard(): void {
  frameListEl.querySelectorAll('.frame-card').forEach((el, i) => {
    el.classList.toggle('current', i === state.current);
  });
}

function buildFrameList(): void {
  frameListEl.innerHTML = '';
  state.photos.forEach((photo, i) => {
    const card = document.createElement('div');
    card.className = 'frame-card';
    if (state.skipped[i]) card.classList.add('skipped');

    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = photo.name;
    img.loading = 'lazy';
    img.addEventListener('click', () => jumpToFrame(i));

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = photo.name;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const a = state.analysis[i];
    meta.textContent = a ? `残差 ${a.residualPx.toFixed(2)}px · ${a.evCorrection >= 0 ? '+' : ''}${a.evCorrection.toFixed(2)}EV` : '未分析';

    const row = document.createElement('div');
    row.className = 'row';
    const skipBtn = document.createElement('button');
    skipBtn.textContent = state.skipped[i] ? '恢复' : '跳过';
    skipBtn.addEventListener('click', () => {
      state.skipped[i] = !state.skipped[i];
      rerunAnalysis();
    });
    const dwellLabel = document.createElement('span');
    dwellLabel.textContent = `停留 +${state.dwell[i]}`;
    const minus = document.createElement('button');
    minus.textContent = '−';
    minus.addEventListener('click', () => {
      state.dwell[i] = Math.max(0, state.dwell[i] - 1);
      dwellLabel.textContent = `停留 +${state.dwell[i]}`;
      updateFrameInfo();
    });
    const plus = document.createElement('button');
    plus.textContent = '＋';
    plus.addEventListener('click', () => {
      state.dwell[i] = Math.min(30, state.dwell[i] + 1);
      dwellLabel.textContent = `停留 +${state.dwell[i]}`;
      updateFrameInfo();
    });
    row.append(skipBtn, minus, dwellLabel, plus);
    card.append(img, name, meta, row);
    frameListEl.appendChild(card);
  });
  highlightCurrentCard();
}

// --- anchors ---
function seedDefaultAnchors(): void {
  state.anchors = [
    { id: 1, x: W * 0.2, y: H * 0.8 },
    { id: 2, x: W * 0.5, y: H * 0.9 },
    { id: 3, x: W * 0.78, y: H * 0.72 },
  ];
  state.nextAnchorId = 4;
}

preview.addEventListener('click', (e) => {
  if (!state.addAnchorMode) return;
  const rect = preview.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const y = ((e.clientY - rect.top) / rect.height) * H;
  state.anchors.push({ id: state.nextAnchorId++, x, y });
  drawPreview();
});

preview.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!state.anchors.length) return;
  const rect = preview.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const y = ((e.clientY - rect.top) / rect.height) * H;
  let best = -1;
  let bestD = Infinity;
  state.anchors.forEach((a, i) => {
    const d = (a.x - x) ** 2 + (a.y - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0 && bestD < 30 * 30) {
    state.anchors.splice(best, 1);
    drawPreview();
  }
});

// --- analysis ---
function rerunAnalysis(): void {
  if (!state.frames.length || !state.anchors.length) return;
  setStatus('分析中…');
  // defer so the status paints first
  setTimeout(() => {
    state.analysis = analyze(state.frames, state.anchors, state.skipped);
    for (const a of state.analysis) a.dwell = state.dwell[a.index];
    refreshCharts();
    refreshAnomalyList();
    buildFrameList();
    jumpToFrame(state.current);
    $<HTMLButtonElement>('#btn-export').disabled = false;
    $<HTMLButtonElement>('#btn-play').disabled = false;
    setStatus(`分析完成：${state.analysis.length} 帧，异常 ${collectAnomalies().length} 条`);
  }, 20);
}

// --- export ---
async function postFile(path: string, body: BodyInit): Promise<void> {
  const res = await fetch(path, { method: 'POST', body });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
}

function playWithMse(init: Uint8Array, media: Uint8Array, codecId: string): void {
  const codec = codecId === 'V_VP9' ? 'vp09.00.10.08' : codecId === 'V_VP8' ? 'vp8' : 'av01.0.04M.08';
  const mime = `video/webm; codecs="${codec}"`;
  if (!MediaSource.isTypeSupported(mime)) return;
  const ms = new MediaSource();
  resultVideo.src = URL.createObjectURL(ms);
  resultVideo.hidden = false;
  ms.addEventListener('sourceopen', () => {
    const sb = ms.addSourceBuffer(mime);
    sb.appendBuffer(init as BufferSource);
    sb.addEventListener('updateend', () => {
      sb.appendBuffer(media as BufferSource);
      sb.addEventListener('updateend', () => ms.endOfStream(), { once: true });
    }, { once: true });
  }, { once: true });
}

async function exportAll(): Promise<void> {
  if (!state.analysis.length) return;
  stopPlayback();
  const plan = outputPlan();
  if (!plan.length) {
    setStatus('输出计划为空：所有帧都被跳过了');
    return;
  }
  const rate = fps();
  setStatus(`编码中 0/${plan.length}…`);
  $<HTMLButtonElement>('#btn-export').disabled = true;
  try {
    const result = await encodeVideo({
      width: W,
      height: H,
      fps: rate,
      frameCount: plan.length,
      renderFrame: (outIdx, canvas) => {
        const srcIdx = plan[outIdx];
        const ctx = canvas.getContext('2d')!;
        const a = state.analysis[srcIdx];
        renderAligned(ctx, state.frames[srcIdx], a.transform, a.evCorrection, W, H);
      },
      onProgress: (done, total) => setStatus(`编码中 ${done}/${total}…`),
    });

    setStatus('上传导出文件…');
    await postFile('/api/export/video?name=timelapse.webm', result.file);

    // PNG sequence of the corrected, aligned frames
    const seqCanvas = new OffscreenCanvas(W, H);
    const seqCtx = seqCanvas.getContext('2d')!;
    for (let i = 0; i < plan.length; i++) {
      const srcIdx = plan[i];
      const a = state.analysis[srcIdx];
      renderAligned(seqCtx, state.frames[srcIdx], a.transform, a.evCorrection, W, H);
      const blob = await seqCanvas.convertToBlob({ type: 'image/png' });
      const seqName = `seq_${String(i + 1).padStart(4, '0')}_src${String(srcIdx + 1).padStart(4, '0')}.png`;
      await postFile(`/api/export/frame?name=${encodeURIComponent(seqName)}`, blob);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      fps: rate,
      outputFrames: plan.length,
      codec: result.codecId,
      frames: state.analysis.map((a) => ({
        index: a.index + 1,
        name: a.name,
        skipped: a.skipped,
        dwell: state.dwell[a.index],
        transform: a.transform,
        residualPx: Number(a.residualPx.toFixed(3)),
        evRaw: Number(a.evRaw.toFixed(3)),
        evTrend: Number(a.evTrend.toFixed(3)),
        evCorrection: Number(a.evCorrection.toFixed(3)),
      })),
      anomalies: collectAnomalies(),
    };
    await postFile('/api/export/report', JSON.stringify(report));

    playWithMse(result.init, result.media, result.codecId);
    setStatus(`导出完成：export/timelapse.webm（${result.frames} 帧）+ PNG 序列 + report.json / anomalies.csv`);
  } catch (err) {
    setStatus(`导出失败：${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('#btn-export').disabled = false;
  }
}

// --- boot ---
async function boot(): Promise<void> {
  setStatus('加载照片列表…');
  const res = await fetch('/api/photos');
  const data = (await res.json()) as { photos: PhotoMeta[] };
  state.photos = data.photos;
  if (!state.photos.length) {
    setStatus('photos/ 目录为空，请先运行 node tools/make-sample-photos.ts');
    return;
  }
  setStatus(`解码 ${state.photos.length} 张照片…`);
  state.frames = await loadFrames(state.photos, W, H);
  state.skipped = state.photos.map(() => false);
  state.dwell = state.photos.map(() => 0);
  seedDefaultAnchors();
  buildFrameList();
  jumpToFrame(0);
  $<HTMLButtonElement>('#btn-analyze').disabled = false;
  $<HTMLButtonElement>('#btn-add-anchor').disabled = false;
  $<HTMLButtonElement>('#btn-clear-anchors').disabled = false;
  setStatus(`已加载 ${state.frames.length} 帧，点击「分析」开始`);
}

$('#btn-reload').addEventListener('click', () => location.reload());
$('#btn-analyze').addEventListener('click', rerunAnalysis);
$('#btn-play').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));
$('#btn-export').addEventListener('click', () => void exportAll());
$('#btn-add-anchor').addEventListener('click', (e) => {
  state.addAnchorMode = !state.addAnchorMode;
  (e.target as HTMLButtonElement).classList.toggle('active', state.addAnchorMode);
});
$('#btn-clear-anchors').addEventListener('click', () => {
  state.anchors = [];
  drawPreview();
});

void boot();
