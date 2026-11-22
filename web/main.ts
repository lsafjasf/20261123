import { App, DEFAULT_CONFIG, type AppConfig } from './app.ts';
import type { FilterParams } from '../shared/filters.ts';
import { formatBytes } from './format.ts';

const $ = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const status = document.getElementById('status')!;
const viewport = document.getElementById('viewport')!;

const app = new App(viewport);
let config: AppConfig = { ...DEFAULT_CONFIG, filter: { ...DEFAULT_CONFIG.filter } };

function readConfig(): AppConfig {
  const filter: FilterParams = {
    brightness: Number($('brightness').value),
    sharpen: Number($('sharpen').value),
    distortion: Number($('distortion').value),
  };
  return {
    width: Number($('width').value),
    height: Number($('height').value),
    cols: Number($('cols').value),
    rows: Number($('rows').value),
    halo: Number($('halo').value),
    fps: Number($('fps').value),
    frameCount: Number($('frameCount').value),
    filter,
  };
}

function bindLabels(): void {
  const pairs: [string, string][] = [
    ['halo', 'haloVal'], ['brightness', 'bVal'], ['sharpen', 'sVal'],
    ['distortion', 'dVal'],
  ];
  for (const [src, out] of pairs) {
    $(src).addEventListener('input', () => {
      document.getElementById(out)!.textContent = $(src).value;
    });
  }
}

async function build(): Promise<void> {
  config = readConfig();
  status.textContent = '生成合成帧并建立 GPU 分块…';
  app.dispose();
  viewport.innerHTML = '';
  await app.setup(config);
  $('frameSlider').max = String(config.frameCount - 1);
  buildJumpButtons();
  $('exportBtn').disabled = false;
  status.textContent =
    `就绪：${config.width}x${config.height}（${config.cols}x${config.rows} 块，halo=${config.halo}）。滚动查看任意分块。`;
}

function buildJumpButtons(): void {
  const row = document.getElementById('jumpRow')!;
  row.innerHTML = '';
  const total = config.cols * config.rows;
  for (let i = 0; i < total; i++) {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.type = 'button';
    btn.textContent = `块 ${i}`;
    btn.addEventListener('click', () => {
      app.tileViewer?.scrollToTile(viewport, i);
      status.textContent = `已滚动到分块 ${i}（懒渲染该块核心区）`;
    });
    row.appendChild(btn);
  }
}

async function runExport(): Promise<void> {
  config = readConfig();
  $('exportBtn').disabled = true;
  try {
    const report = await app.runExport(config, (ratio, label) => {
      status.textContent = `导出中 ${label} — ${Math.round(ratio * 100)}%`;
    });
    renderReport(report);
    await app.playViaMse(document.getElementById('player') as HTMLVideoElement, report.webm);
    const blob = new Blob([report.webm], { type: 'video/webm' });
    status.textContent =
      `导出完成：${report.webm.length} 字节，重叠区最大差异 ${report.overlap.maxDiff}/255，MSE 回放已启动。`;
    const url = URL.createObjectURL(blob);
    offerDownload(url, 'tiled-export.webm');
  } catch (err) {
    status.textContent = `导出失败：${(err as Error).message}`;
  } finally {
    $('exportBtn').disabled = false;
  }
}

function renderReport(report: Awaited<ReturnType<App['runExport']>>): void {
  const summary = document.getElementById('summary')!;
  const gpuMs = report.frames[0]?.totalGpuMs;
  const audio = app.lastAudioStats;
  summary.innerHTML = `
    <span class="pill">峰值显式显存 ${formatBytes(report.peakBytes)}</span>
    <span class="pill">重叠采样 ${report.overlap.samples}px</span>
    <span class="pill">重叠最大差 ${report.overlap.maxDiff}</span>
    <span class="pill">重叠平均差 ${report.overlap.meanDiff.toFixed(3)}</span>
    <span class="pill">GPU 首帧 ${gpuMs === null ? '不支持计时' : `${gpuMs.toFixed(2)}ms`}</span>
    ${audio ? `<span class="pill">音频 RMS ${audio.rms.toFixed(3)} 峰值 ${audio.peak.toFixed(3)}</span>` : ''}
  `;
  const table = document.getElementById('tileTable')!;
  const head = '<tr><th>块</th><th>列/行</th><th>核心区</th><th>采样区</th><th>墙钟 ms</th><th>GPU ms</th><th>显式字节</th></tr>';
  const rows = report.tileAverages.map((tile) => {
    const gpu = tile.gpuNanos === null ? '—' : (tile.gpuNanos / 1e6).toFixed(3);
    return `<tr><td>${tile.index}</td><td>${tile.col}/${tile.row}</td>
      <td>${tile.width}×${tile.height}</td><td>${tile.sampleWidth}×${tile.sampleHeight}</td>
      <td>${tile.wallMs.toFixed(3)}</td><td>${gpu}</td><td>${formatBytes(tile.bytes)}</td></tr>`;
  }).join('');
  table.innerHTML = `<table>${head}${rows}</table>`;
}

function offerDownload(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.textContent = '下载 WebM';
  link.className = 'pill';
  document.getElementById('summary')!.appendChild(link);
}

function bindEvents(): void {
  bindLabels();
  $('build').addEventListener('click', () => { void build(); });
  $('exportBtn').addEventListener('click', () => { void runExport(); });
  $('odd').addEventListener('click', () => {
    $('width').value = '1921';
    $('height').value = '1081';
    $('cols').value = '3';
    $('rows').value = '3';
    status.textContent = '已填入奇数尺寸 1921×1081 / 3×3，点击“建立分块”。';
  });
  $('frameSlider').addEventListener('input', () => {
    const index = Number($('frameSlider').value);
    document.getElementById('frameVal')!.textContent = String(index);
    config = readConfig();
    app.showFrame(index, config.filter);
  });
  $('playAudio').addEventListener('click', () => {
    if (!app.lastAudioStats) {
      status.textContent = '请先建立分块。';
      return;
    }
    status.textContent = '通过 WebAudio 播放合成音轨…';
    app.playAudio().then(() => {
      status.textContent = '音轨播放结束。';
    }).catch((err: Error) => {
      status.textContent = `音频播放失败：${err.message}`;
    });
  });
}

bindEvents();
