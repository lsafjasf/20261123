import { api } from './lib/api.js';
import { VideoScanner } from './lib/scanner.js';
import { FrameMetricExtractor } from './lib/metrics.js';
import { runSampleLab, supportsWebCodecs } from './lib/sample-generator.js';
import { analyze } from './lib/engine.js';

const state = {
  config: null,
  scanner: null,
  currentSha: null,
};

const $ = (id) => document.getElementById(id);

async function boot() {
  renderCapability();
  const health = await api.health();
  const { config } = await api.config();
  state.config = config;
  console.log('引擎版本', health.engineVersion, '参数哈希', health.configHash);
  await refreshJobs();
  bindEvents();
}

function renderCapability() {
  const checks = [
    ['WebCodecs', supportsWebCodecs()],
    ['WebAudio', !!(globalThis.AudioContext || globalThis.webkitAudioContext)],
    ['Canvas', !!document.createElement('canvas').getContext],
    ['MediaSource', typeof globalThis.MediaSource !== 'undefined'],
    ['WebCrypto', !!globalThis.crypto?.subtle],
  ];
  $('capability').innerHTML = checks
    .map(([name, ok]) => `<span class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${name}</span>`)
    .join('　');
}

function bindEvents() {
  $('filePicker').addEventListener('change', () => {
    $('scanBtn').disabled = $('filePicker').files.length === 0;
  });
  $('scanBtn').addEventListener('click', onScan);
  $('analyzeBtn').addEventListener('click', onAnalyze);
  $('mseBtn').addEventListener('click', onMsePlay);
  $('sampleBtn').addEventListener('click', () => {
    $('labCard').hidden = !$('labCard').hidden;
  });
  $('labRunBtn').addEventListener('click', onRunLab);
}

async function onScan() {
  const files = [...$('filePicker').files];
  const sampleEvery = Number($('sampleEvery').value);
  const batchSize = Number($('batchSize').value);
  const { engineVersion } = await api.health();
  state.scanner = new VideoScanner({
    canvas: $('grabCanvas'),
    video: $('player'),
    onProgress: updateProgress,
    onLog: (msg) => console.log('[扫描]', msg),
  });
  for (const file of files) {
    const outcome = await state.scanner.scan(file, {
      sampleEvery,
      batchSize,
      blackPixelLuma: state.config.black.pixelLumaThreshold,
      engineVersion,
    });
    state.currentSha = outcome.sha256;
    $('analyzeBtn').disabled = false;
    $('mseBtn').disabled = false;
    await refreshJobs();
  }
}

async function onAnalyze() {
  if (!state.currentSha) return;
  const { result } = await api.analyze(state.currentSha);
  renderResult(result);
}

async function onMsePlay() {
  const file = $('filePicker').files[0];
  if (!file) return;
  $('player').src = URL.createObjectURL(file);
  await $('player').play().catch(() => {});
}

async function onRunLab() {
  const output = $('labOutput');
  output.textContent = '生成样本并通过 WebCodecs 编解码往返…';
  const frameCount = Number($('labFrames').value);
  const factory = (canvas) =>
    new FrameMetricExtractor(canvas, state.config.black.pixelLumaThreshold);
  try {
    const lab = await runSampleLab($('grabCanvas'), factory, frameCount, (msg) =>
      console.log('[实验室]', msg),
    );
    const lines = [];
    for (const item of lab) {
      const found = analyze(item.metrics, 30, state.config);
      lines.push(
        [
          item.scenario.padEnd(16),
          `黑场x${found.black.length}`,
          `静止x${found.freeze.length}`,
          `抖动x${found.shake.length}`,
          `切换x${found.cuts.length}`,
          `镜头x${found.shots.length}`,
        ].join('  '),
      );
    }
    output.textContent = lines.join('\n');
  } catch (error) {
    output.textContent = `样本实验室失败: ${error.message}`;
  }
}

async function refreshJobs() {
  const { scans } = await api.listScans();
  const tbody = $('jobTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const scan of scans) {
    const ratio = scan.totalFrames
      ? (scan.lastFrameIndex + 1) / scan.totalFrames
      : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${scan.fileName}</td>
      <td><code>${scan.sha256.slice(0, 12)}…</code></td>
      <td>${scan.status}</td>
      <td><div class="progress"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>${(ratio * 100).toFixed(1)}%</td>
      <td>${scan.lastFrameIndex + 1}</td>
      <td><button data-sha="${scan.sha256}" class="pick">选用</button></td>`;
    tr.querySelector('.pick').addEventListener('click', () => {
      state.currentSha = scan.sha256;
      $('analyzeBtn').disabled = scan.status !== 'done';
      $('mseBtn').disabled = false;
    });
    tbody.appendChild(tr);
  }
}

function updateProgress(event) {
  if (event.phase !== 'scan') return;
  console.log(`进度 ${(event.ratio * 100).toFixed(1)}% 检查点帧=${event.checkpoint}`);
}

function renderResult(result) {
  $('resultCard').hidden = false;
  const labels = result.labels
    .map((label) => `<span class="pill ${label.label === 'still' ? 'freeze' : label.label}">${label.label}(${label.severity})</span>`)
    .join(' ');
  $('summary').innerHTML = `
    <strong>${result.fileName}</strong>　${labels || '无文件级标签'}<br/>
    时长 ${result.durationSec.toFixed(2)}s · ${result.shots.length} 个镜头 ·
    黑场 ${result.black.length} / 静止 ${result.freeze.length} / 抖动 ${result.shake.length} ·
    引擎 ${result.engineVersion} / 参数 ${result.configHash}`;

  const shotRows = result.shots
    .map(
      (shot) => `<tr><td>${shot.shotId}</td><td>${shot.startTc}</td><td>${shot.endTc}</td>
      <td>${shot.durationSec.toFixed(2)}</td><td>${shot.assignee}</td><td>${shot.flags.join('|') || '-'}</td></tr>`,
    )
    .join('');
  $('shotTable').querySelector('tbody').innerHTML = shotRows;

  const issues = [...result.black, ...result.freeze, ...result.shake]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map(
      (segment) => `<tr><td><span class="pill ${segment.kind}">${segment.kind}</span></td>
      <td>${segment.startTc}</td><td>${segment.endTc}</td><td>${segment.durationSec.toFixed(2)}</td>
      <td>${segment.severity.toFixed(2)}</td></tr>`,
    )
    .join('');
  $('issueTable').querySelector('tbody').innerHTML = issues;

  $('exportRow').innerHTML = ['labels.csv', 'segments.csv', 'shots.csv', 'timeline.edl', 'analysis.json']
    .map(
      (name) =>
        `<a class="dl" href="/api/results/${result.sha256}/export/${encodeURIComponent(name)}" download="${name}">${name}</a>`,
    )
    .join('');
}

boot().catch((error) => {
  console.error(error);
  alert(`初始化失败: ${error.message}`);
});
