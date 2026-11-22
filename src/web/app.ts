import { encodeWav16, parseWav } from '../core/wav.ts';
import { identifyTrack } from '../core/identify.ts';
import { analyzeTracks, prepareTracks } from '../core/analyze.ts';
import { buildDialogueFirstMix } from '../core/mix.ts';
import { DEFAULT_THRESHOLDS, type AnalysisReport, type DecodedTrack, type TrackKind } from '../core/types.ts';
import { matrixToCsv, anomaliesToCsv, reportToJson } from '../cli/report.ts';
import { PlaybackEngine, type WebTrack } from './engine.ts';
import { computePeaks, drawWaveform, drawDuckCurve } from './waveform.ts';
import { buildVideoDecoderConfig, detectCodecs, loadMp4ViaMediaSource } from './media-source.ts';

interface LoadedTrack extends WebTrack {
  pcm: { sampleRate: number; channels: Float32Array[] };
}

const state: {
  tracks: LoadedTrack[];
  report: AnalysisReport | null;
  engine: PlaybackEngine | null;
} = { tracks: [], report: null, engine: null };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function setStatus(message: string, tone: 'info' | 'error' | 'ok' = 'info'): void {
  const el = $('status');
  el.textContent = message;
  el.dataset.tone = tone;
}

/** Decode a WAV File to PCM using the shared offline parser. */
async function decodeFile(file: File): Promise<LoadedTrack> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const hasContent = decoded.pcm.channels[0].some((sample) => Math.abs(sample) > 0.0001);
  const identified = identifyTrack(file.name, decoded.channelCount, hasContent);
  const audioBuffer = new AudioBuffer({
    length: decoded.pcm.channels[0].length,
    numberOfChannels: decoded.channelCount,
    sampleRate: decoded.sampleRate,
  });
  decoded.pcm.channels.forEach((channel, ch) => audioBuffer.copyToChannel(channel, ch));
  return {
    fileName: file.name,
    kind: identified.kind,
    buffer: audioBuffer,
    pcm: decoded.pcm,
  };
}

async function handleFiles(fileList: FileList | null): Promise<void> {
  if (!fileList || fileList.length === 0) return;
  setStatus(`正在离线解码 ${fileList.length} 个文件…`);
  const wavFiles = [...fileList].filter((file) => file.name.toLowerCase().endsWith('.wav'));
  const decoded: LoadedTrack[] = [];
  for (const file of wavFiles) {
    try {
      decoded.push(await decodeFile(file));
    } catch (error) {
      setStatus(`无法解析 ${file.name}：${(error as Error).message}`, 'error');
    }
  }
  state.tracks = decoded;
  runAnalysis();
  buildTrackControls();
  initEngine();
  setStatus(`已加载 ${decoded.length} 条轨道并完成离线 QC`, 'ok');
}

function runAnalysis(): void {
  const decodedTracks: DecodedTrack[] = state.tracks.map((track) => ({
    fileName: track.fileName,
    kind: track.kind,
    sampleRate: track.pcm.sampleRate,
    channelCount: track.pcm.channels.length,
    durationSec: track.pcm.channels[0].length / track.pcm.sampleRate,
    pcm: { sampleRate: track.pcm.sampleRate, channels: track.pcm.channels },
  }));
  state.report = analyzeTracks(prepareTracks(decodedTracks), DEFAULT_THRESHOLDS);
  renderMatrix(state.report);
  renderAnomalies(state.report);
}

function renderMatrix(report: AnalysisReport): void {
  const table = $('matrix-body') as HTMLTableSectionElement;
  table.innerHTML = '';
  for (const row of report.matrix) {
    const tr = document.createElement('tr');
    tr.dataset.status = row.status;
    tr.innerHTML = `
      <td>${row.fileName}</td>
      <td>${row.label}</td>
      <td>${row.channelCount}</td>
      <td>${row.sampleRate}</td>
      <td>${row.durationSec.toFixed(3)}</td>
      <td>${row.integratedLufs.toFixed(1)}</td>
      <td>${row.loudnessRange.toFixed(1)}</td>
      <td>${row.truePeakDbfs.toFixed(1)}</td>
      <td>${row.tailSilenceSec.toFixed(3)}</td>
      <td><span class="badge ${row.status}">${row.status}</span></td>`;
    table.appendChild(tr);
  }
}

function renderAnomalies(report: AnalysisReport): void {
  const list = $('anomaly-list');
  list.innerHTML = '';
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...report.anomalies].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const item of sorted) {
    const li = document.createElement('li');
    li.className = `anomaly ${item.severity}`;
    const location = item.atSec !== undefined ? ` @ ${item.atSec.toFixed(2)}s` : '';
    li.innerHTML = `<span class="sev">${item.severity}</span><code>${item.code}</code>
      <strong>${item.track}</strong>${location} — ${item.message}`;
    list.appendChild(li);
  }
}

function buildTrackControls(): void {
  const container = $('track-controls');
  container.innerHTML = '';
  for (const track of state.tracks) {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.innerHTML = `
      <button class="solo" data-file="${track.fileName}">SOLO</button>
      <button class="mute" data-file="${track.fileName}">MUTE</button>
      <input class="fader" type="range" min="0" max="1.5" step="0.01" value="1" data-file="${track.fileName}">
      <span class="track-name" title="${track.fileName}">${track.fileName}</span>`;
    container.appendChild(row);
  }

  container.querySelectorAll<HTMLButtonElement>('button.solo').forEach((button) => {
    button.addEventListener('click', () => {
      const engine = state.engine;
      if (!engine) return;
      const active = button.classList.toggle('armed');
      engine.setSolo(active ? button.dataset.file! : null);
      container.querySelectorAll('button.solo').forEach((other) => {
        if (other !== button) other.classList.remove('armed');
      });
    });
  });
  container.querySelectorAll<HTMLButtonElement>('button.mute').forEach((button) => {
    button.addEventListener('click', () => {
      const engine = state.engine;
      if (!engine) return;
      const muted = button.classList.toggle('armed');
      const fader = container.querySelector<HTMLInputElement>(`.fader[data-file="${button.dataset.file}"]`);
      engine.setTrim(button.dataset.file!, Number(fader?.value ?? 1), muted);
    });
  });
  container.querySelectorAll<HTMLInputElement>('input.fader').forEach((fader) => {
    fader.addEventListener('input', () => {
      state.engine?.setTrim(fader.dataset.file!, Number(fader.value), false);
    });
  });
}

function initEngine(): void {
  state.engine?.stop();
  const engine = new PlaybackEngine();
  const webTracks: WebTrack[] = state.tracks.map((track) => ({
    fileName: track.fileName,
    kind: track.kind,
    buffer: track.buffer,
  }));
  engine.load(webTracks);
  state.engine = engine;
  bindTransport(engine);
  requestAnimationFrame(visualizationLoop);
}

function bindTransport(engine: PlaybackEngine): void {
  $('play').onclick = () => engine.play();
  $('pause').onclick = () => engine.pause();
  $('lang-zh').onclick = () => engine.setLanguage('dialogue-zh');
  $('lang-en').onclick = () => engine.setLanguage('dialogue-en');
  $('mode-raw').onclick = () => engine.setMode('raw');
  $('mode-ducked').onclick = () => engine.setMode('ducked');

  const video = $('video') as HTMLVideoElement;
  video.onplay = () => engine.play();
  video.onpause = () => engine.pause();
  video.onseeked = () => engine.seek(video.currentTime);

  const seek = $('seek') as HTMLInputElement;
  seek.oninput = () => {
    const value = Number(seek.value);
    video.currentTime = value;
    engine.seek(value);
  };
}

function visualizationLoop(): void {
  const engine = state.engine;
  if (!engine) return;
  const duration = state.tracks[0]?.buffer.duration ?? 1;
  const position = engine.getCurrentTime();
  const progress = Math.min(1, position / duration);
  const seek = $('seek') as HTMLInputElement;
  seek.max = String(duration);
  if (document.activeElement !== seek) seek.value = String(position);
  $('timecode').textContent = `${position.toFixed(2)}s / ${duration.toFixed(2)}s`;

  const canvas = $('waveform') as HTMLCanvasElement;
  const focusTrack = state.tracks.find((track) => track.kind === engine.getLanguage()) ?? state.tracks[0];
  if (focusTrack) {
    const peaks = computePeaks(focusTrack.pcm, 240);
    drawWaveform(canvas, peaks, progress);
  }

  const duckCanvas = $('duck-canvas') as HTMLCanvasElement;
  const inputs = state.tracks.map((track) => ({ kind: track.kind, pcm: track.pcm }));
  const mix = buildDialogueFirstMix(inputs, engine.getLanguage());
  drawDuckCurve(duckCanvas, mix.duckCurve, progress);
  requestAnimationFrame(visualizationLoop);
}

function download(filename: string, content: BlobPart, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function bindExports(): void {
  $('export-json').onclick = () => {
    if (state.report) download('report.json', reportToJson(state.report), 'application/json');
  };
  $('export-matrix').onclick = () => {
    if (state.report) download('track-matrix.csv', matrixToCsv(state.report), 'text/csv');
  };
  $('export-anomalies').onclick = () => {
    if (state.report) download('anomalies.csv', anomaliesToCsv(state.report), 'text/csv');
  };
  $('export-mix').onclick = () => {
    if (!state.engine || state.tracks.length === 0) return;
    const language = state.engine.getLanguage();
    const inputs = state.tracks.map((track) => ({ kind: track.kind, pcm: track.pcm }));
    const result = buildDialogueFirstMix(inputs, language as TrackKind);
    const wav = encodeWav16(result.mix);
    download(`default-mix-${language}.wav`, wav, 'audio/wav');
  };
}

function bindFileInputs(): void {
  const audioInput = $('audio-files') as HTMLInputElement;
  audioInput.addEventListener('change', () => void handleFiles(audioInput.files));

  const videoInput = $('video-file') as HTMLInputElement;
  videoInput.addEventListener('change', () => {
    const file = videoInput.files?.[0];
    if (!file) return;
    void loadVideo(file);
  });
}

async function loadVideo(file: File): Promise<void> {
  const video = $('video') as HTMLVideoElement;
  video.muted = true; // audio always routed through the WebAudio graph
  try {
    if (file.name.toLowerCase().endsWith('.mp4') && typeof MediaSource !== 'undefined') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const codecs = detectCodecs(buffer);
      await loadMp4ViaMediaSource(video, buffer);
      const decoderConfig = await buildVideoDecoderConfig(codecs);
      const decoderNote = decoderConfig ? `WebCodecs 可解码 ${decoderConfig.codec}` : 'WebCodecs 未确认该编码';
      setStatus(`已通过 MediaSource 载入画面（${decoderNote}），语言切换不重启视频`, 'ok');
      return;
    }
    video.src = URL.createObjectURL(file);
    setStatus('已通过原生 Blob URL 载入画面，语言切换不重启视频', 'ok');
  } catch (error) {
    video.src = URL.createObjectURL(file);
    setStatus(`MSE 路径失败，回退 Blob 播放：${(error as Error).message}`, 'info');
  }
}

function main(): void {
  bindFileInputs();
  bindExports();
  setStatus('请选择 WAV 音轨与可选的 MP4/WebM 画面（全部本地处理，离线可用）');
}

main();
