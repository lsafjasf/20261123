import { summarizeAtTime } from '../shared/analyzer.ts';
import { reviewPackage, safeBaseName, secondsCsv } from '../shared/export.ts';
import {
  DEFAULT_SETTINGS,
  PRESETS,
  formatLufs,
  formatTime,
  type AdSegment,
  type AnalysisResult,
  type AudioMetadata,
  type LoudnessSettings,
  type ProblemInterval,
  type SecondRow,
  type SegmentStats,
  type WorkerRequest,
  type WorkerResponse
} from '../shared/types.ts';
import { appShell } from './template.ts';
import { TimelineRenderer } from './timeline.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('缺少应用挂载点');
app.innerHTML = appShell();

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`缺少元素 ${selector}`);
  return element;
};

const audio = $<HTMLAudioElement>('#audio');
const fileInput = $<HTMLInputElement>('#fileInput');
const dropZone = $<HTMLElement>('#dropZone');
const worker = new Worker('/js/web/worker.js', { type: 'module' });

interface AppState {
  file: File | null;
  url: string | null;
  metadata: AudioMetadata | null;
  result: AnalysisResult | null;
  ads: AdSegment[];
  settings: LoudnessSettings;
  scanning: boolean;
  scanPaused: boolean;
  scanError: string | null;
  progress: number;
  scanElapsed: number;
  currentTime: number;
  activeTab: 'seconds' | 'problems' | 'segments' | 'method';
  secondsFilter: 'all' | 'flags' | 'ads';
  secondsPage: number;
  problemFilter: 'all' | 'critical' | 'warning';
  timelineMode: 'seek' | 'ad';
  lastLivePaint: number;
}

const state: AppState = {
  file: null,
  url: null,
  metadata: null,
  result: null,
  ads: [],
  settings: { ...DEFAULT_SETTINGS },
  scanning: false,
  scanPaused: false,
  scanError: null,
  progress: 0,
  scanElapsed: 0,
  currentTime: 0,
  activeTab: 'seconds',
  secondsFilter: 'all',
  secondsPage: 0,
  problemFilter: 'all',
  timelineMode: 'seek',
  lastLivePaint: 0
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function send(message: WorkerRequest): void {
  worker.postMessage(message);
}

function toast(message: string, tone: 'normal' | 'error' = 'normal'): void {
  const element = $<HTMLDivElement>('#toast');
  element.textContent = message;
  element.className = `toast visible ${tone}`;
  window.clearTimeout(Number(element.dataset.timer || 0));
  const timer = window.setTimeout(() => {
    element.className = 'toast';
  }, 3600);
  element.dataset.timer = String(timer);
}

function setProgress(ratio: number, elapsed: number): void {
  state.progress = Math.max(0, Math.min(1, ratio));
  state.scanElapsed = elapsed;
  $<HTMLElement>('#scanProgress').style.width = `${(state.progress * 100).toFixed(2)}%`;
  $<HTMLElement>('#scanRatio').textContent = `${Math.round(state.progress * 100)}%`;
  $<HTMLElement>('#scanElapsed').textContent = `${elapsed.toFixed(1)}s`;
}

function updateScanUi(): void {
  const dot = $<HTMLElement>('#scanDot');
  const label = $<HTMLElement>('#scanLabel');
  const pauseButton = $<HTMLButtonElement>('#scanPauseButton');
  dot.className = 'status-dot';
  if (state.scanning && state.scanPaused) {
    dot.classList.add('paused');
    label.textContent = '已暂停 · 累计状态保留';
    pauseButton.textContent = '继续扫描';
    pauseButton.disabled = false;
  } else if (state.scanning) {
    dot.classList.add('working');
    label.textContent = state.result ? '重新计算分段' : '流式扫描中';
    pauseButton.textContent = '暂停扫描';
    pauseButton.disabled = false;
  } else if (state.result) {
    dot.classList.add('done');
    label.textContent = '扫描完成';
    pauseButton.textContent = '扫描完成';
    pauseButton.disabled = true;
  } else if (state.scanError) {
    dot.classList.add('error');
    label.textContent = '扫描失败 · 查看提示';
    pauseButton.textContent = '暂停扫描';
    pauseButton.disabled = true;
  } else {
    label.textContent = state.file ? '准备扫描' : '等待素材';
    pauseButton.textContent = '暂停扫描';
    pauseButton.disabled = true;
  }
}

async function openFile(file: File): Promise<void> {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.url = URL.createObjectURL(file);
  state.metadata = null;
  state.result = null;
  state.scanning = true;
  state.scanPaused = false;
  state.scanError = null;
  state.progress = 0;
  state.currentTime = 0;
  state.secondsPage = 0;
  state.ads = file.name.toLowerCase() === 'demo.wav'
    ? [{ id: 'demo-ad-1', label: '示例广告段', start: 30, end: 45 }]
    : [];
  audio.src = state.url;
  audio.currentTime = 0;
  setProgress(0, 0);
  updateScanUi();
  renderAll();
  send({ type: 'start', file, request: { ads: state.ads, settings: state.settings } });
  toast(`已载入 ${file.name}，正在流式扫描`);
}

async function loadDemo(): Promise<void> {
  try {
    const response = await fetch('/artifacts/demo.wav');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const file = new File([blob], 'demo.wav', { type: 'audio/wav' });
    await openFile(file);
  } catch (error) {
    state.scanning = false;
    updateScanUi();
    toast(`示例载入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

window.addEventListener('beforeunload', () => {
  if (state.url) URL.revokeObjectURL(state.url);
  worker.terminate();
});

function statusFor(result: AnalysisResult): { text: string; className: string; top: string } {
  if (result.intervals.some((item) => item.severity === 'critical')) {
    return { text: '需复核', className: 'fail', top: '需复核' };
  }
  if (result.intervals.length > 0) {
    return { text: '有警告', className: 'warn', top: '有警告' };
  }
  return { text: '可交付', className: 'pass', top: '可交付' };
}

function renderFileSummary(): void {
  const element = $<HTMLElement>('#fileSummary');
  const metadata = state.metadata || state.result?.metadata;
  if (!state.file) {
    element.className = 'file-summary muted';
    element.innerHTML = '<strong>尚未载入</strong><span>也可以直接打开示例音频</span>';
    $<HTMLElement>('#workTitle').textContent = '响度复核工作台';
    $<HTMLElement>('#workSubtitle').textContent = '逐秒数据、问题区间与广告段独立统计';
    $<HTMLElement>('#topStatus').textContent = '未载入';
    return;
  }
  element.className = 'file-summary';
  if (!metadata) {
    element.innerHTML = `<strong>${escapeHtml(state.file.name)}</strong><span>${(state.file.size / 1024 / 1024).toFixed(1)} MB · 解析中</span>`;
    $<HTMLElement>('#workTitle').textContent = state.file.name;
    $<HTMLElement>('#workSubtitle').textContent = '读取容器与采样参数…';
    $<HTMLElement>('#topStatus').textContent = '解析中';
    return;
  }
  element.innerHTML = `
    <strong>${escapeHtml(metadata.fileName)}</strong>
    <span>${escapeHtml(metadata.format)} · ${metadata.sampleRate / 1000} kHz · ${metadata.channels === 1 ? '单声道' : `${metadata.channels} 声道`}</span>
    <span>${(metadata.fileSize / 1024 / 1024).toFixed(1)} MB · ${formatTime(metadata.duration)}</span>
  `;
  $<HTMLElement>('#workTitle').textContent = metadata.fileName;
  const bitDepth = metadata.bitsPerSample > 0 ? `${metadata.bitsPerSample}-bit` : '压缩音频';
  $<HTMLElement>('#workSubtitle').textContent =
    `${metadata.sampleRate} Hz · ${metadata.channels}ch · ${bitDepth} · ${metadata.decoder === 'wav-stream' ? '流式分块解码' : 'WebCodecs 流式解码'}`;
  $<HTMLElement>('#topStatus').textContent = state.scanning ? '扫描中' : state.result ? '扫描完成' : '准备就绪';
}

function renderSummary(): void {
  const result = state.result;
  const metadata = state.metadata || result?.metadata;
  if (metadata) {
    $<HTMLElement>('#durationTime').textContent = formatTime(metadata.duration);
    $<HTMLElement>('#scaleTarget').textContent = state.settings.target.toFixed(1);
    $<HTMLElement>('#scaleLow').textContent = (state.settings.target - 6).toFixed(0);
    $<HTMLElement>('#scaleHigh').textContent = (state.settings.target + 6).toFixed(0);
  }
  if (!result) {
    $<HTMLElement>('#integratedValue').textContent = '—';
    $<HTMLElement>('#integratedDelta').textContent = state.scanning ? '扫描计算中…' : `目标 ${state.settings.target.toFixed(1)} LUFS`;
    $<HTMLElement>('#integratedDelta').className = 'delta-chip';
    $<HTMLElement>('#gatingText').textContent = state.scanning ? `${Math.round(state.progress * 100)}% 已扫描` : '门控块 0';
    $<HTMLElement>('#samplePeakValue').textContent = '—';
    $<HTMLElement>('#truePeakValue').textContent = '—';
    $<HTMLElement>('#programValue').textContent = '—';
    $<HTMLElement>('#adCountValue').textContent = String(state.ads.length);
    $<HTMLElement>('#deliveryStatus').className = 'status-pill idle';
    $<HTMLElement>('#deliveryStatus').textContent = state.scanning ? '分析中' : '待分析';
    $<HTMLElement>('#targetNeedle').style.left = '50%';
    $<HTMLElement>('#targetMarker').style.left = '50%';
    setExportEnabled(false);
    return;
  }

  const status = statusFor(result);
  const delta = result.integrated - result.settings.target;
  $<HTMLElement>('#integratedValue').textContent = formatLufs(result.integrated);
  $<HTMLElement>('#integratedDelta').textContent =
    `目标 ${result.settings.target.toFixed(1)} · 偏差 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} LU`;
  $<HTMLElement>('#integratedDelta').className =
    `delta-chip ${Math.abs(delta) <= result.settings.tolerance ? 'good' : 'bad'}`;
  $<HTMLElement>('#gatingText').textContent = `${result.gatedBlocks.toLocaleString()} 个门控块进入积分`;
  $<HTMLElement>('#samplePeakValue').textContent = result.samplePeak.toFixed(1);
  $<HTMLElement>('#truePeakValue').textContent = result.truePeak.toFixed(1);
  $<HTMLElement>('#truePeakValue').className = result.truePeak > result.settings.truePeakLimit ? 'danger-text' : '';
  $<HTMLElement>('#samplePeakValue').className = result.samplePeak > result.settings.peakWarning ? 'warn-text' : '';
  $<HTMLElement>('#programValue').textContent = formatLufs(result.program.integrated);
  $<HTMLElement>('#adCountValue').textContent = String(result.ads.length);
  $<HTMLElement>('#deliveryStatus').className = `status-pill ${status.className}`;
  $<HTMLElement>('#deliveryStatus').textContent = status.text;
  $<HTMLElement>('#topStatus').textContent = status.top;

  const position = Math.max(0, Math.min(100, (result.integrated - (result.settings.target - 6)) / 12 * 100));
  $<HTMLElement>('#targetNeedle').style.left = `${position}%`;
  $<HTMLElement>('#targetMarker').style.left = '50%';
  setExportEnabled(true);
}

function setExportEnabled(enabled: boolean): void {
  $<HTMLButtonElement>('#exportJsonButton').disabled = !enabled;
  $<HTMLButtonElement>('#exportCsvButton').disabled = !enabled;
}

function renderLive(): void {
  const result = state.result;
  $<HTMLElement>('#currentTime').textContent = formatTime(state.currentTime, true);
  if (!result) {
    $<HTMLElement>('#liveMomentary').textContent = '—';
    $<HTMLElement>('#liveShortTerm').textContent = '—';
    $<HTMLElement>('#liveIntegrated').textContent = '—';
    $<HTMLElement>('#liveSecond').textContent = state.scanning ? '流式扫描中，完成后可逐秒复核' : '当前秒 —';
    $<HTMLElement>('#livePeak').textContent = 'TP — / SP —';
    return;
  }
  const values = summarizeAtTime(result, state.currentTime);
  $<HTMLElement>('#liveMomentary').textContent = formatLufs(values.momentary);
  $<HTMLElement>('#liveShortTerm').textContent = formatLufs(values.shortTerm);
  $<HTMLElement>('#liveIntegrated').textContent = formatLufs(values.integrated);
  const row = result.seconds[Math.max(0, Math.min(result.seconds.length - 1, Math.floor(state.currentTime)))];
  if (row) {
    const ad = result.ads.find((item) => item.id === row.adId);
    $<HTMLElement>('#liveSecond').textContent =
      `第 ${String(row.index + 1).padStart(2, '0')} 秒 · 均值 ${formatLufs(row.momentary)} · ${ad ? ad.label : '节目'}`;
    $<HTMLElement>('#livePeak').textContent = `TP ${row.truePeak.toFixed(1)} / SP ${row.samplePeak.toFixed(1)} dB`;
  }
  document.querySelectorAll<HTMLElement>('#secondsTable tr[data-second]').forEach((element) => {
    element.classList.toggle('is-current', Number(element.dataset.second) === Math.floor(state.currentTime));
  });
}

function renderAds(): void {
  const container = $<HTMLElement>('#adChips');
  if (state.ads.length === 0) {
    container.innerHTML = '<span class="muted">暂无广告段；可框选时间线后填入入出点</span>';
  } else {
    container.innerHTML = state.ads.map((ad) => `
      <button class="ad-chip" type="button" data-seek="${ad.start}" title="定位到 ${formatTime(ad.start)}">
        <span class="ad-chip-dot"></span>
        <b>${escapeHtml(ad.label)}</b>
        <span>${formatTime(ad.start)} – ${formatTime(ad.end)}</span>
        <em data-remove-ad="${ad.id}" title="移除广告段">×</em>
      </button>
    `).join('');
  }
  $<HTMLButtonElement>('#addAdButton').disabled = !state.file;
  $<HTMLElement>('#adCountValue').textContent = String(state.result ? state.result.ads.length : state.ads.length);
}

function renderTimeline(): void {
  timeline.setData(state.result, state.ads, state.currentTime);
  timeline.setMode(state.timelineMode);
}

function renderAll(): void {
  renderFileSummary();
  renderSummary();
  renderLive();
  renderAds();
  renderTimeline();
  renderTabs();
  updateScanUi();
}

const FLAG_LABELS: Record<SecondRow['flags'][number], string> = {
  'true-peak': '真峰',
  'sample-peak': '采样峰',
  'loudness-burst': '响度突发',
  silence: '静音',
  'program-offset': '整段偏差',
  'ad-offset': '广告偏差'
};

function renderTabs(): void {
  const result = state.result;
  $<HTMLElement>('#secondsBadge').textContent = String(result?.seconds.length || 0);
  $<HTMLElement>('#problemsBadge').textContent = String(result?.intervals.length || 0);
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === state.activeTab);
  });
  const content = $<HTMLElement>('#tabContent');
  if (!result && state.activeTab !== 'method') {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-orbit"></div>
        <strong>${state.scanning ? '正在建立逐秒复核数据' : '尚未载入音频'}</strong>
        <span>${state.scanning ? '流式读取中，完成后自动填充表格与问题区间' : '载入 WAV 后生成逐秒数据、问题区间和分段统计'}</span>
      </div>`;
    return;
  }
  if (state.activeTab === 'seconds') renderSecondsTab();
  if (state.activeTab === 'problems') renderProblemsTab();
  if (state.activeTab === 'segments') renderSegmentsTab();
  if (state.activeTab === 'method') renderMethodTab();
}

function renderSecondsTab(): void {
  const result = state.result;
  if (!result) return;
  const filtered = result.seconds.filter((row) => {
    if (state.secondsFilter === 'flags') return row.flags.length > 0;
    if (state.secondsFilter === 'ads') return row.adId !== null;
    return true;
  });
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.secondsPage = Math.min(state.secondsPage, pageCount - 1);
  const start = state.secondsPage * pageSize;
  const rows = filtered.slice(start, start + pageSize);
  const content = $<HTMLElement>('#tabContent');
  content.innerHTML = `
    <div class="table-toolbar">
      <div class="segmented small">
        <button class="${state.secondsFilter === 'all' ? 'active' : ''}" data-seconds-filter="all" type="button">全部 ${result.seconds.length}</button>
        <button class="${state.secondsFilter === 'flags' ? 'active' : ''}" data-seconds-filter="flags" type="button">含标记 ${result.seconds.filter((row) => row.flags.length > 0).length}</button>
        <button class="${state.secondsFilter === 'ads' ? 'active' : ''}" data-seconds-filter="ads" type="button">广告段 ${result.seconds.filter((row) => row.adId).length}</button>
      </div>
      <div class="table-summary">显示 ${filtered.length ? start + 1 : 0}–${Math.min(start + pageSize, filtered.length)} / ${filtered.length} 秒</div>
    </div>
    <div class="table-scroll">
      <table class="data-table" id="secondsTable">
        <thead><tr>
          <th>时间</th><th>M 均值</th><th>M 峰值</th><th>S 3s</th><th>至本秒 I</th>
          <th>采样峰</th><th>真峰值</th><th>归属</th><th>标记</th>
        </tr></thead>
        <tbody>
          ${rows.map((row) => {
            const ad = result.ads.find((item) => item.id === row.adId);
            return `<tr data-second="${row.index}" class="${row.flags.length ? 'has-flag' : ''}">
              <td><b>${formatTime(row.start)}</b><span class="subtime">–${formatTime(row.end)}</span></td>
              <td>${formatLufs(row.momentary)}</td>
              <td>${formatLufs(row.momentaryMax)}</td>
              <td>${formatLufs(row.shortTerm)}</td>
              <td>${formatLufs(row.integrated)}</td>
              <td class="${row.samplePeak > result.settings.peakWarning ? 'warn-text' : ''}">${row.samplePeak.toFixed(1)}</td>
              <td class="${row.truePeak > result.settings.truePeakLimit ? 'danger-text' : ''}">${row.truePeak.toFixed(1)}</td>
              <td>${ad ? `<span class="tag ad">${escapeHtml(ad.label)}</span>` : '<span class="tag program">节目</span>'}</td>
              <td><div class="flag-list">${row.flags.map((flag) => `<span class="flag ${flag}">${FLAG_LABELS[flag]}</span>`).join('') || '<span class="muted">—</span>'}</div></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <button class="button ghost compact" type="button" data-page="${state.secondsPage - 1}" ${state.secondsPage === 0 ? 'disabled' : ''}>上一页</button>
      <span>第 ${state.secondsPage + 1} / ${pageCount} 页</span>
      <button class="button ghost compact" type="button" data-page="${state.secondsPage + 1}" ${state.secondsPage >= pageCount - 1 ? 'disabled' : ''}>下一页</button>
      <span class="pagination-note">点击行可跳转播放 · CSV 含全部 ${result.seconds.length} 行</span>
    </div>
  `;
}

function visitMetric(interval: ProblemInterval): string {
  if (interval.kind === 'true-peak' || interval.kind === 'sample-peak') return `${interval.metric.toFixed(1)} dB`;
  if (interval.kind === 'program-offset' || interval.kind === 'ad-offset') return `${interval.metric >= 0 ? '+' : ''}${interval.metric.toFixed(1)} LU`;
  return `${formatLufs(interval.metric)} LUFS`;
}

function renderProblemsTab(): void {
  const result = state.result;
  if (!result) return;
  const filtered = result.intervals.filter((item) => state.problemFilter === 'all' || item.severity === state.problemFilter);
  const critical = result.intervals.filter((item) => item.severity === 'critical').length;
  const warning = result.intervals.filter((item) => item.severity === 'warning').length;
  const content = $<HTMLElement>('#tabContent');
  content.innerHTML = `
    <div class="problem-summary">
      <div class="problem-count critical"><span>${critical}</span><b>严重</b><small>需优先修正</small></div>
      <div class="problem-count warning"><span>${warning}</span><b>警告</b><small>交付前复核</small></div>
      <div class="problem-count neutral"><span>${result.intervals.length}</span><b>全部</b><small>按时间排序</small></div>
      <div class="problem-filter">
        <label>筛选<select id="problemFilter" class="select compact-select">
          <option value="all"${state.problemFilter === 'all' ? ' selected' : ''}>全部等级</option>
          <option value="critical"${state.problemFilter === 'critical' ? ' selected' : ''}>仅严重</option>
          <option value="warning"${state.problemFilter === 'warning' ? ' selected' : ''}>仅警告</option>
        </select></label>
      </div>
    </div>
    ${filtered.length === 0 ? `
      <div class="empty-state compact"><strong>当前筛选没有问题区间</strong><span>可切换等级查看，或继续播放复核主观听感。</span></div>
    ` : `
      <div class="problem-list">
        ${filtered.map((item) => `
          <article class="problem-item ${item.severity}" data-seek="${item.start}">
            <div class="problem-rail"></div>
            <div class="problem-main">
              <div class="problem-title">
                <span class="severity-badge ${item.severity}">${item.severity === 'critical' ? '严重' : '警告'}</span>
                <strong>${escapeHtml(item.label)}</strong>
                <span class="problem-time">${formatTime(item.start, true)} – ${formatTime(item.end, true)}</span>
                <span class="problem-duration">${item.duration.toFixed(1)} s</span>
              </div>
              <p>${escapeHtml(item.detail)}</p>
            </div>
            <div class="problem-metric"><strong>${visitMetric(item)}</strong><button type="button" data-seek="${item.start}">定位播放</button></div>
          </article>
        `).join('')}
      </div>
    `}
  `;
}

function segmentCard(segment: SegmentStats, settings: LoudnessSettings): string {
  const delta = segment.integrated - settings.target;
  const position = Math.max(0, Math.min(100, (segment.integrated - (settings.target - 8)) / 16 * 100));
  return `
    <article class="segment-card ${segment.kind}" data-seek="${segment.start}">
      <div class="segment-head">
        <div>
          <span class="segment-kind">${segment.kind === 'program' ? 'PROGRAM' : 'AD BREAK'}</span>
          <h3>${escapeHtml(segment.label)}</h3>
        </div>
        <span class="tag ${segment.kind}">${formatTime(segment.start)} – ${formatTime(segment.end)}</span>
      </div>
      <div class="segment-primary">
        <strong>${formatLufs(segment.integrated)}</strong><span>LUFS I</span>
        <em class="${Math.abs(delta) <= settings.tolerance ? 'good' : 'bad'}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)} LU</em>
      </div>
      <div class="segment-scale"><span style="left:${position}%"></span><i style="left:50%"></i></div>
      <div class="segment-stats">
        <div><span>M 最大</span><b>${formatLufs(segment.momentaryMax)}</b></div>
        <div><span>S 最大</span><b>${formatLufs(segment.shortTermMax)}</b></div>
        <div><span>采样峰</span><b>${segment.samplePeak.toFixed(1)}</b></div>
        <div><span>真峰值</span><b>${segment.truePeak.toFixed(1)}</b></div>
      </div>
      <div class="segment-foot">
        <span>${segment.duration.toFixed(1)} s · ${segment.gatedBlocks} 个门控块</span>
        <span>${segment.kind === 'program' ? '广告块已剔除' : '独立门控，不并入节目'}</span>
      </div>
    </article>
  `;
}

function renderSegmentsTab(): void {
  const result = state.result;
  if (!result) return;
  const content = $<HTMLElement>('#tabContent');
  content.innerHTML = `
    <div class="segment-intro">
      <p>节目净响度剔除全部广告时间；每段广告独立执行 -70 LUFS 绝对门控与 -10 LU 相对门控。</p>
      <span>${result.ads.length} 段广告 · 共 ${result.ads.reduce((sum, ad) => sum + ad.duration, 0).toFixed(1)} s</span>
    </div>
    <div class="segment-grid">
      ${segmentCard(result.program, result.settings)}
      ${result.ads.map((ad) => segmentCard(ad, result.settings)).join('')}
    </div>
    ${result.ads.length === 0 ? `
      <div class="inline-tip">还没有广告段。在时间线切到“框选广告段”，拖出区间后加入即可生成独立统计。</div>
    ` : ''}
  `;
}

function renderMethodTab(): void {
  const content = $<HTMLElement>('#tabContent');
  content.innerHTML = `
    <div class="method-grid">
      <article>
        <span class="method-index">01</span>
        <h3>响度口径</h3>
        <p>ITU-R BS.1770-4 K 加权；Momentary 为 400 ms 窗口、100 ms hop，Short-term 为 3 s 窗口；Integrated 使用 -70 LUFS 绝对门控与 -10 LU 相对门控。</p>
      </article>
      <article>
        <span class="method-index">02</span>
        <h3>峰值口径</h3>
        <p>采样峰取原始离散样本绝对值。真峰值在每个声道上做 8× 多相插值（高于 BS.1770 的 4× 最低要求），因果滤波状态跨分块保留，结束时补零冲刷尾部。</p>
      </article>
      <article>
        <span class="method-index">03</span>
        <h3>长音频内存</h3>
        <p>WAV 按 512 KiB 对齐帧流式解码，只保留滤波状态、100 ms 指标、波形包络和门控统计；不会把整段 PCM 或 AudioBuffer 放进超大数组。</p>
      </article>
      <article>
        <span class="method-index">04</span>
        <h3>暂停与分段</h3>
        <p>扫描暂停、播放暂停都不会重建滤波器、真峰值历史或积分直方图。时间线广告段按块归属重新门控，节目段自动剔除广告块。</p>
      </article>
      <article>
        <span class="method-index">05</span>
        <h3>问题区间</h3>
        <p>逐秒聚合真峰值、采样峰、瞬时突发与静音标记，再把连续秒合并为复核区间。整段/广告偏差独立成条，所有区间均可点击定位。</p>
      </article>
      <article>
        <span class="method-index">06</span>
        <h3>运行边界</h3>
        <p>全部计算在本机浏览器完成。仅使用 TypeScript、Node.js 标准库与 Canvas/WebCodecs/WebAudio/MediaSource 等原生能力，无第三方包、无云端上传。</p>
      </article>
    </div>
    <div class="method-note">
      <strong>复核提示</strong>
      <span>自动标记用于定位，不替代主观监听。广告段边界请以实际编排为准；建议同时检查平台响度规范与 -1 dBTP 峰值上限。</span>
    </div>
  `;
}

const timeline = new TimelineRenderer($<HTMLCanvasElement>('#timelineCanvas'), {
  onSeek(time) {
    seekTo(time);
  },
  onAdSelection(start, end) {
    $<HTMLInputElement>('#adStartInput').value = start.toFixed(2);
    $<HTMLInputElement>('#adEndInput').value = end.toFixed(2);
    $<HTMLElement>('#canvasHint').textContent = `已选区 ${formatTime(start)} – ${formatTime(end)}，填写名称后加入`;
    toast('广告选区已填入，确认入出点后点击“加入广告段”');
  }
});

function seekTo(time: number): void {
  const duration = state.metadata?.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);
  const target = Math.max(0, Math.min(duration || time, time));
  state.currentTime = target;
  if (audio.src && Number.isFinite(audio.duration) && audio.duration > 0) {
    try {
      audio.currentTime = Math.min(audio.duration, target);
    } catch {
      // The media element may still be resolving metadata.
    }
  }
  timeline.setCurrentTime(target);
  renderLive();
}

function waitForAudioMetadata(): Promise<void> {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

async function togglePlayback(): Promise<void> {
  if (!state.url) {
    toast('请先载入音频', 'error');
    return;
  }
  if (audio.paused) {
    await waitForAudioMetadata().catch(() => undefined);
    try {
      await audio.play();
      $<HTMLButtonElement>('#playButton').textContent = '❚❚';
      startPlaybackTicker();
    } catch (error) {
      toast(`无法播放：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  } else {
    audio.pause();
    $<HTMLButtonElement>('#playButton').textContent = '▶';
  }
}

let playbackFrame = 0;
function startPlaybackTicker(): void {
  cancelAnimationFrame(playbackFrame);
  const tick = (timestamp: number): void => {
    if (audio.paused) return;
    state.currentTime = audio.currentTime;
    if (timestamp - state.lastLivePaint > 80) {
      state.lastLivePaint = timestamp;
      renderLive();
      timeline.setCurrentTime(state.currentTime);
    }
    playbackFrame = requestAnimationFrame(tick);
  };
  playbackFrame = requestAnimationFrame(tick);
}

function readSettings(): LoudnessSettings {
  const num = (selector: string, fallback: number): number => {
    const value = Number($<HTMLInputElement>(selector).value);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    target: Math.max(-40, Math.min(0, num('#targetInput', state.settings.target))),
    tolerance: Math.max(0.1, num('#toleranceInput', state.settings.tolerance)),
    truePeakLimit: Math.max(-20, Math.min(0, num('#truePeakInput', state.settings.truePeakLimit))),
    peakWarning: Math.max(-30, Math.min(0, num('#peakWarningInput', state.settings.peakWarning))),
    loudnessBurst: state.settings.loudnessBurst,
    silenceThreshold: state.settings.silenceThreshold
  };
}

function writeSettings(settings: LoudnessSettings): void {
  $<HTMLInputElement>('#targetInput').value = settings.target.toFixed(1);
  $<HTMLInputElement>('#toleranceInput').value = settings.tolerance.toFixed(1);
  $<HTMLInputElement>('#truePeakInput').value = settings.truePeakLimit.toFixed(1);
  $<HTMLInputElement>('#peakWarningInput').value = settings.peakWarning.toFixed(1);
}

function applySettings(): void {
  state.settings = readSettings();
  send({ type: 'set-settings', settings: state.settings });
  renderSummary();
  renderLive();
  toast(`已更新口径：${state.settings.target.toFixed(1)} LUFS / ${state.settings.truePeakLimit.toFixed(1)} dBTP`);
}

function addAd(): void {
  if (!state.metadata) {
    toast('音频参数尚未就绪', 'error');
    return;
  }
  const start = Number($<HTMLInputElement>('#adStartInput').value);
  const end = Number($<HTMLInputElement>('#adEndInput').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.2) {
    toast('请输入有效的广告入点与出点（至少 0.2 秒）', 'error');
    return;
  }
  if (start < 0 || end > state.metadata.duration + 0.001) {
    toast(`广告段必须位于 0 – ${formatTime(state.metadata.duration)} 内`, 'error');
    return;
  }
  if (state.ads.some((ad) => start < ad.end && end > ad.start)) {
    toast('广告段与现有区间重叠，请调整入出点', 'error');
    return;
  }
  const label = $<HTMLInputElement>('#adLabelInput').value.trim() || `广告 ${state.ads.length + 1}`;
  state.ads = [...state.ads, {
    id: crypto.randomUUID(),
    label,
    start,
    end
  }].sort((a, b) => a.start - b.start);
  $<HTMLInputElement>('#adStartInput').value = '';
  $<HTMLInputElement>('#adEndInput').value = '';
  $<HTMLInputElement>('#adLabelInput').value = '';
  $<HTMLElement>('#canvasHint').textContent = '拖拽或点击定位播放';
  timeline.setSelection(null, null);
  send({ type: 'set-ads', ads: state.ads });
  renderAds();
  renderTimeline();
  renderTabs();
  toast(`已加入 ${formatTime(start)} – ${formatTime(end)} · ${label}`);
}

function removeAd(id: string): void {
  const ad = state.ads.find((item) => item.id === id);
  if (!ad) return;
  state.ads = state.ads.filter((item) => item.id !== id);
  send({ type: 'set-ads', ads: state.ads });
  renderAds();
  renderTimeline();
  renderTabs();
  toast(`已移除 ${ad.label}，分段统计更新中`);
}

function downloadFile(name: string, type: string, content: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson(): void {
  const result = state.result;
  if (!result) return;
  const payload = reviewPackage(result);
  downloadFile(`${safeBaseName(result.metadata.fileName)}-loudness-review.json`, 'application/json;charset=utf-8', JSON.stringify(payload, null, 2));
  toast('已导出 JSON 复核包');
}

function exportCsv(): void {
  const result = state.result;
  if (!result) return;
  downloadFile(`${safeBaseName(result.metadata.fileName)}-loudness-seconds.csv`, 'text/csv;charset=utf-8', secondsCsv(result));
  toast(`已导出 ${result.seconds.length} 行逐秒数据`);
}

document.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  if (!target) return;
  const remove = target.closest<HTMLElement>('[data-remove-ad]');
  if (remove) {
    event.stopPropagation();
    removeAd(remove.dataset.removeAd || '');
    return;
  }
  const tab = target.closest<HTMLButtonElement>('[data-tab]');
  if (tab?.dataset.tab) {
    state.activeTab = tab.dataset.tab as AppState['activeTab'];
    renderTabs();
    return;
  }
  const filter = target.closest<HTMLButtonElement>('[data-seconds-filter]');
  if (filter?.dataset.secondsFilter) {
    state.secondsFilter = filter.dataset.secondsFilter as AppState['secondsFilter'];
    state.secondsPage = 0;
    renderSecondsTab();
    return;
  }
  const page = target.closest<HTMLButtonElement>('[data-page]');
  if (page?.dataset.page) {
    state.secondsPage = Math.max(0, Number(page.dataset.page));
    renderSecondsTab();
    return;
  }
  const seek = target.closest<HTMLElement>('[data-seek]');
  if (seek?.dataset.seek) {
    seekTo(Number(seek.dataset.seek));
    return;
  }
  const row = target.closest<HTMLElement>('[data-second]');
  if (row?.dataset.second) {
    seekTo(Number(row.dataset.second) + 0.01);
  }
});

document.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement | null;
  if (target?.id === 'problemFilter') {
    state.problemFilter = target.value as AppState['problemFilter'];
    renderProblemsTab();
  }
});

$<HTMLInputElement>('#fileInput').addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
});

for (const type of ['dragenter', 'dragover']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files[0];
  if (file) openFile(file);
});

$<HTMLButtonElement>('#demoButton').addEventListener('click', () => { void loadDemo(); });
$<HTMLButtonElement>('#playButton').addEventListener('click', () => { void togglePlayback(); });
$<HTMLButtonElement>('#backButton').addEventListener('click', () => seekTo(state.currentTime - 5));
$<HTMLButtonElement>('#forwardButton').addEventListener('click', () => seekTo(state.currentTime + 5));
$<HTMLButtonElement>('#scanPauseButton').addEventListener('click', () => {
  state.scanPaused = !state.scanPaused;
  send({ type: state.scanPaused ? 'pause' : 'resume' });
  updateScanUi();
  toast(state.scanPaused ? '扫描已暂停，累计状态保留' : '继续扫描，沿用同一个分析状态');
});
$<HTMLButtonElement>('#addAdButton').addEventListener('click', addAd);
$<HTMLButtonElement>('#exportJsonButton').addEventListener('click', exportJson);
$<HTMLButtonElement>('#exportCsvButton').addEventListener('click', exportCsv);

$<HTMLSelectElement>('#presetSelect').addEventListener('change', (event) => {
  const preset = PRESETS.find((item) => item.id === (event.target as HTMLSelectElement).value);
  if (!preset) return;
  state.settings = { ...preset.settings };
  writeSettings(state.settings);
  send({ type: 'set-settings', settings: state.settings });
  renderSummary();
  renderLive();
  toast(`口径切换为 ${preset.name}`);
});
for (const selector of ['#targetInput', '#toleranceInput', '#truePeakInput', '#peakWarningInput']) {
  $(selector).addEventListener('change', applySettings);
}

$<HTMLButtonElement>('#seekModeButton').addEventListener('click', () => {
  state.timelineMode = 'seek';
  $<HTMLButtonElement>('#seekModeButton').classList.add('active');
  $<HTMLButtonElement>('#adModeButton').classList.remove('active');
  $<HTMLElement>('#canvasHint').textContent = '拖拽或点击定位播放';
  timeline.setMode('seek');
});
$<HTMLButtonElement>('#adModeButton').addEventListener('click', () => {
  state.timelineMode = 'ad';
  $<HTMLButtonElement>('#adModeButton').classList.add('active');
  $<HTMLButtonElement>('#seekModeButton').classList.remove('active');
  $<HTMLElement>('#canvasHint').textContent = '在时间线上拖出广告范围';
  timeline.setMode('ad');
});

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    $<HTMLElement>('#durationTime').textContent = formatTime(audio.duration);
  }
});
audio.addEventListener('timeupdate', () => {
  if (!audio.paused) {
    state.currentTime = audio.currentTime;
    renderLive();
  }
});
audio.addEventListener('play', () => {
  $<HTMLButtonElement>('#playButton').textContent = '❚❚';
  startPlaybackTicker();
});
audio.addEventListener('pause', () => {
  $<HTMLButtonElement>('#playButton').textContent = '▶';
  state.currentTime = audio.currentTime;
  renderLive();
  timeline.setCurrentTime(state.currentTime);
});
audio.addEventListener('ended', () => {
  $<HTMLButtonElement>('#playButton').textContent = '▶';
  state.currentTime = audio.duration || state.currentTime;
  renderLive();
});

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return;
  const element = event.target as HTMLElement | null;
  if (element && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(element.tagName)) return;
  event.preventDefault();
  void togglePlayback();
});

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  if (message.type === 'metadata') {
    state.metadata = message.metadata;
    $<HTMLElement>('#durationTime').textContent = formatTime(message.metadata.duration);
    renderFileSummary();
    renderSummary();
    updateScanUi();
    return;
  }
  if (message.type === 'progress') {
    setProgress(message.ratio, message.elapsed);
    if (!state.result) {
      $<HTMLElement>('#gatingText').textContent = `${Math.round(message.ratio * 100)}% 已扫描 · 流式状态`;
    }
    return;
  }
  if (message.type === 'error') {
    state.scanning = false;
    state.scanPaused = false;
    state.scanError = message.message;
    updateScanUi();
    toast(message.message, 'error');
    return;
  }
  if (message.type === 'result') {
    const wasScanning = state.scanning;
    state.result = message.result;
    state.metadata = message.result.metadata;
    state.ads = message.result.ads.map((ad) => ({ id: ad.id, label: ad.label, start: ad.start, end: ad.end }));
    state.scanning = false;
    state.scanPaused = false;
    state.scanError = null;
    state.currentTime = Math.min(state.currentTime, message.result.metadata.duration);
    setProgress(1, state.scanElapsed);
    renderAll();
    const status = statusFor(message.result);
    if (wasScanning) {
      toast(`扫描完成：${formatLufs(message.result.integrated)} LUFS，真峰值 ${message.result.truePeak.toFixed(1)} dBTP，${status.text}`);
    }
  }
};

renderAll();
writeSettings(state.settings);
window.setTimeout(() => { void loadDemo(); }, 250);
