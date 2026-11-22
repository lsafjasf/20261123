import { DEVICE_MODELS, DEVICE_ORDER, STEM_LABELS } from '../shared/devices.ts';
import { runAnalysis } from '../shared/analysis-pipeline.ts';
import {
  MODEL_NOTICE,
  type AnalysisReport,
  type AudioBufferData,
  type DeviceId,
  type StemGain,
  type StemId,
} from '../shared/types.ts';
import { decodeAudioFile, detectCodecSupport } from './audio-decode.ts';
import { DevicePlayback } from './playback-graph.ts';
import { TimelineView } from './timeline-view.ts';
import { downloadText, reportToMarkdown } from './report-format.ts';
import { synthesizeBrowserFixture } from './fixture.ts';

const STEM_IDS: StemId[] = ['dialogue', 'music', 'effects'];

interface AppState {
  stems: Partial<Record<StemId, AudioBufferData>>;
  gains: StemGain;
  enabled: Record<StemId, boolean>;
  report: AnalysisReport | null;
  selectedDevice: DeviceId;
  levelMatch: boolean;
}

const state: AppState = {
  stems: {},
  gains: { dialogue: 0, music: 0, effects: 0 },
  enabled: { dialogue: true, music: true, effects: true },
  report: null,
  selectedDevice: DEVICE_ORDER[0],
  levelMatch: false,
};

const $ = <T extends HTMLElement>(selector: string): T =>
  document.querySelector(selector) as T;

const formatSupport = (support: ReturnType<typeof detectCodecSupport>): string =>
  `WebCodecs=${support.webCodecs ? '可用' : '不可用'}，MediaSource=${support.mediaSource ? '可用' : '不可用'}（MP4 支持=${support.mediaSourceMp4 ? '是' : '否'}）`;

const banner = $('#model-banner');
banner.textContent = `${MODEL_NOTICE} 当前环境：${formatSupport(detectCodecSupport())}`;

const runButton = $<HTMLButtonElement>('#run-analysis');
const loaderStatus = $<HTMLSpanElement>('#loader-status');
const transportStatus = $<HTMLSpanElement>('#transport-status');
const deviceSelect = $<HTMLSelectElement>('#device-select');
const timeline = new TimelineView($<HTMLCanvasElement>('#timeline'));
let audioContext: AudioContext | null = null;
let playback: DevicePlayback | null = null;
let playTimer = 0;

const ensureContext = (): AudioContext => {
  if (!audioContext) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioContext = new Ctor();
  }
  return audioContext;
};

const hasAnyStem = (): boolean => Object.keys(state.stems).length > 0;

const refreshRunButton = (): void => {
  runButton.disabled = !hasAnyStem();
};

document.querySelectorAll<HTMLInputElement>('input[type="file"][data-stem]').forEach((input) => {
  input.addEventListener('change', async () => {
    const stem = input.dataset.stem as StemId;
    const file = input.files?.[0];
    const nameLabel = document.querySelector<HTMLElement>(`[data-name="${stem}"]`);
    if (!file) {
      delete state.stems[stem];
      if (nameLabel) nameLabel.textContent = '未选择';
      refreshRunButton();
      return;
    }
    try {
      loaderStatus.textContent = `正在解码 ${file.name}…`;
      const decoded = await decodeAudioFile(file, ensureContext());
      state.stems[stem] = decoded;
      if (nameLabel) {
        nameLabel.textContent = `${file.name}（${decoded.sampleRate} Hz，${decoded.channels[0].length} 采样）`;
      }
      loaderStatus.textContent = '解码完成';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      loaderStatus.textContent = `解码失败：${message}`;
      input.value = '';
      delete state.stems[stem];
      if (nameLabel) nameLabel.textContent = '未选择';
    }
    refreshRunButton();
  });
});

$<HTMLButtonElement>('#load-demo').addEventListener('click', () => {
  const fixture = synthesizeBrowserFixture();
  state.stems = fixture;
  for (const stem of STEM_IDS) {
    const label = document.querySelector<HTMLElement>(`[data-name="${stem}"]`);
    if (label) label.textContent = `内置演示分轨（${STEM_LABELS[stem]}）`;
  }
  loaderStatus.textContent = '已载入演示信号';
  refreshRunButton();
});

for (const deviceId of DEVICE_ORDER) {
  const option = document.createElement('option');
  option.value = deviceId;
  option.textContent = DEVICE_MODELS[deviceId].label;
  deviceSelect.appendChild(option);
}
deviceSelect.value = state.selectedDevice;
deviceSelect.addEventListener('change', () => {
  state.selectedDevice = deviceSelect.value as AppState['selectedDevice'];
  if (playback) stopPlayback();
  if (state.report) {
    timeline.setReport(state.report, state.selectedDevice);
    timeline.draw();
    renderDeviceSummary();
    renderEventTable();
  }
});

const stemControls = $('#stem-controls');
const renderStemControls = (): void => {
  stemControls.innerHTML = '';
  for (const stem of STEM_IDS) {
    const card = document.createElement('div');
    card.className = 'stem-control';
    const enabled = state.enabled[stem];
    card.innerHTML = `
      <label>
        <span>${STEM_LABELS[stem]}</span>
        <label class="inline">
          <input type="checkbox" data-role="enable" ${enabled ? 'checked' : ''} />
          启用
        </label>
      </label>
      <input type="range" min="-40" max="12" step="0.5" value="${state.gains[stem]}"
        data-role="gain" ${enabled ? '' : 'disabled'} />
      <span class="status" data-role="gain-label">${state.gains[stem].toFixed(1)} dB</span>
    `;
    card.querySelector<HTMLInputElement>('[data-role="enable"]')!.addEventListener('change', (event) => {
      state.enabled[stem] = (event.target as HTMLInputElement).checked;
      renderStemControls();
      playback?.setStemGains(effectiveGains());
      markReportStale();
    });
    card.querySelector<HTMLInputElement>('[data-role="gain"]')!.addEventListener('input', (event) => {
      state.gains[stem] = Number((event.target as HTMLInputElement).value);
      card.querySelector<HTMLElement>('[data-role="gain-label"]')!.textContent =
        `${state.gains[stem].toFixed(1)} dB`;
      playback?.setStemGains(effectiveGains());
      markReportStale();
    });
    stemControls.appendChild(card);
  }
};

// Disabled stems are represented by a large negative gain rather than removing
// data, so the analysis frames stay aligned across conditions.
const effectiveGains = (): StemGain => ({
  dialogue: state.enabled.dialogue ? state.gains.dialogue : -96,
  music: state.enabled.music ? state.gains.music : -96,
  effects: state.enabled.effects ? state.gains.effects : -96,
});

const markReportStale = (): void => {
  if (state.report) {
    runButton.textContent = '重新运行检查（参数已变更）';
    loaderStatus.textContent = '分轨参数已变更，当前报告为旧结果，请重新运行检查。';
  }
};

renderStemControls();

$<HTMLInputElement>('#level-match').addEventListener('change', (event) => {
  state.levelMatch = (event.target as HTMLInputElement).checked;
});

const levelTable = $('#level-table');
const deviceSummary = $('#device-summary');

const renderLevelTable = (): void => {
  const report = state.report;
  if (!report) return;
  const rows = [
    ['对白', report.stemLevels.dialogue],
    ['音乐', report.stemLevels.music],
    ['效果声', report.stemLevels.effects],
    ['混音（含增益）', report.mixLevels],
  ] as const;
  levelTable.innerHTML = `
    <table>
      <thead><tr><th>对象</th><th>积分 LUFS</th><th>短期最大</th><th>真峰 dBTP</th><th>峰均比</th></tr></thead>
      <tbody>
        ${rows
          .map(
            ([label, summary]) => `
            <tr><td>${label}</td><td>${summary.integratedLufs.toFixed(1)}</td>
            <td>${summary.shortTermMaxLufs.toFixed(1)}</td>
            <td>${summary.truePeakDb.toFixed(1)}</td>
            <td>${summary.crestFactorDb.toFixed(1)}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
};

function renderDeviceSummary(): void {
  const report = state.report;
  if (!report) return;
  deviceSummary.innerHTML = `<div class="device-cards">
    ${report.devices
      .map((device) => {
        const model = DEVICE_MODELS[device.deviceId];
        const active = device.deviceId === state.selectedDevice;
        const counts = device.events.reduce<Record<string, number>>((acc, event) => {
          acc[event.kind] = (acc[event.kind] ?? 0) + 1;
          return acc;
        }, {});
        return `<div class="device-card" style="${active ? 'border-color:#5aa2ff' : ''}">
          <strong>${model.label}</strong>
          <div>输出响度 ${device.outputLoudness.integratedLufs.toFixed(1)} LUFS</div>
          <div>真峰 ${device.outputLoudness.truePeakDb.toFixed(1)} dBTP</div>
          <div class="muted">掩蔽 ${counts.masking ?? 0} · 削波 ${counts.clipping ?? 0} · 限幅 ${counts.softclip ?? 0}</div>
        </div>`;
      })
      .join('')}
  </div>`;
}

const eventTableBody = $<HTMLTableSectionElement>('#event-table tbody');

function renderEventTable(): void {
  const report = state.report;
  if (!report) return;
  const device = report.devices.find((item) => item.deviceId === state.selectedDevice);
  if (!device) return;
  eventTableBody.innerHTML = device.events
    .map(
      (event, index) => `
      <tr class="clickable" data-index="${index}">
        <td>${DEVICE_MODELS[event.deviceId as DeviceId]?.label ?? event.deviceId}</td>
        <td>${event.kind}</td>
        <td class="sev-${event.severity}">${event.severity}</td>
        <td>${event.startSec.toFixed(2)}</td>
        <td>${event.endSec.toFixed(2)}</td>
        <td>${event.message}</td>
      </tr>`,
    )
    .join('');
  eventTableBody.querySelectorAll<HTMLTableRowElement>('tr.clickable').forEach((row) => {
    row.addEventListener('click', () => {
      const event = device.events[Number(row.dataset.index)];
      seekTo(event.startSec);
    });
  });
}

const revealPanels = (): void => {
  for (const id of ['#control-panel', '#visual-panel', '#meter-panel', '#event-panel']) {
    $(id).hidden = false;
  }
};

runButton.addEventListener('click', () => {
  if (!hasAnyStem()) return;
  try {
    loaderStatus.textContent = '正在运行本地分析…';
    const report = runAnalysis(state.stems, {
      gains: effectiveGains(),
      levelMatchTargetLufs: state.levelMatch ? -23 : undefined,
    });
    state.report = report;
    timeline.setWaveform(state.stems);
    timeline.setReport(report, state.selectedDevice);
    timeline.setPlayhead(0);
    renderLevelTable();
    renderDeviceSummary();
    renderEventTable();
    revealPanels();
    $<HTMLButtonElement>('#play').disabled = false;
    $<HTMLButtonElement>('#stop').disabled = false;
    runButton.textContent = '运行检查';
    loaderStatus.textContent = `分析完成：共 ${report.devices.reduce(
      (count, device) => count + device.events.length,
      0,
    )} 个事件`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loaderStatus.textContent = `分析失败：${message}`;
  }
});

const stopPlayback = (): void => {
  if (playTimer) window.clearInterval(playTimer);
  playTimer = 0;
  playback?.dispose();
  playback = null;
  $<HTMLButtonElement>('#play').textContent = '播放';
};

const seekTo = (sec: number): void => {
  timeline.setPlayhead(sec);
  if (playback) {
    const gains = effectiveGains();
    void playback.start(state.stems, gains, sec);
  }
};

$<HTMLCanvasElement>('#timeline').addEventListener('click', (event) => {
  const sec = timeline.timeAtClientX(event.clientX);
  seekTo(sec);
});

$<HTMLButtonElement>('#play').addEventListener('click', async () => {
  if (!state.report) return;
  if (playback) {
    if (audioContext?.state === 'running') {
      await audioContext.suspend();
      $<HTMLButtonElement>('#play').textContent = '继续';
      transportStatus.textContent = '已暂停';
    } else {
      await audioContext?.resume();
      $<HTMLButtonElement>('#play').textContent = '暂停';
      transportStatus.textContent = `正在预览：${DEVICE_MODELS[state.selectedDevice].label}`;
    }
    return;
  }
  const context = ensureContext();
  playback = new DevicePlayback(context, DEVICE_MODELS[state.selectedDevice]);
  const startAt = timeline.currentTimeSec;
  await playback.start(state.stems, effectiveGains(), startAt);
  $<HTMLButtonElement>('#play').textContent = '暂停';
  transportStatus.textContent = `正在预览：${DEVICE_MODELS[state.selectedDevice].label}`;
  playTimer = window.setInterval(() => {
    if (!playback) return;
    const time = playback.currentTime;
    timeline.setPlayhead(time);
    if (time >= state.report!.durationSec) {
      stopPlayback();
      timeline.setPlayhead(0);
      transportStatus.textContent = '播放结束';
    }
  }, 80);
});

$<HTMLButtonElement>('#stop').addEventListener('click', () => {
  stopPlayback();
  timeline.setPlayhead(0);
  transportStatus.textContent = '已停止';
});

$<HTMLButtonElement>('#export-json').addEventListener('click', () => {
  if (!state.report) return;
  downloadText(
    'mix-check-report.json',
    JSON.stringify(state.report, null, 2),
    'application/json',
  );
});

$<HTMLButtonElement>('#export-md').addEventListener('click', () => {
  if (!state.report) return;
  downloadText('mix-check-report.md', reportToMarkdown(state.report), 'text/markdown');
});
