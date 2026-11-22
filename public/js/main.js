// UI 主控：文件加载 -> 解码 -> 特征 -> 检测 -> 交互（阈值/白名单/跳转/导出）。
import { decodeFile } from './decoder.js';
import { FeatureExtractor } from './features.js';
import { Player } from './player.js';
import { Analyzer } from './store.js';
import { FAULT_KINDS } from './segments.js';
import { KIND_COLORS, Waveform } from './waveform.js';
                                                 
                                                                                  

const $ =                        (id        )    =>
  document.getElementById(id)     ;

const KIND_LABELS                              = {
  dropout: '掉字', pop: '爆音', clip: '持续削波', silence: '异常空白',
  noise: '持续噪声', music: '音乐', pause: '正常停顿',
};

const THRESHOLD_FIELDS                                                                                     = [
  { key: 'silenceDb', label: '静音门限 (dB)', step: 1, min: -80, max: -20 },
  { key: 'silenceMinSec', label: '异常空白 ≥ (s)', step: 0.5, min: 0.5, max: 30 },
  { key: 'dropoutMinSec', label: '掉字 ≥ (s)', step: 0.01, min: 0.01, max: 0.5 },
  { key: 'dropoutMaxSec', label: '掉字 ≤ (s)', step: 0.1, min: 0.2, max: 3 },
  { key: 'popJump', label: '爆音跳变 ≥', step: 0.05, min: 0.1, max: 1.5 },
  { key: 'popMaxSec', label: '爆音 ≤ (s)', step: 0.01, min: 0.01, max: 0.5 },
  { key: 'clipMinSec', label: '持续削波 ≥ (s)', step: 0.05, min: 0.02, max: 2 },
  { key: 'noiseFlatness', label: '噪声平坦度 ≥', step: 0.05, min: 0.1, max: 0.9 },
  { key: 'noiseMinDb', label: '噪声能量 ≥ (dB)', step: 1, min: -70, max: -10 },
  { key: 'noiseMinSec', label: '噪声持续 ≥ (s)', step: 0.5, min: 0.2, max: 10 },
  { key: 'musicFlatness', label: '音乐平坦度 ≤', step: 0.02, min: 0.02, max: 0.5 },
  { key: 'musicMinDb', label: '音乐能量 ≥ (dB)', step: 1, min: -70, max: -10 },
  { key: 'musicMinSec', label: '音乐持续 ≥ (s)', step: 0.5, min: 0.5, max: 20 },
];

const analyzer = new Analyzer();
const player = new Player($                  ('audio'));
const wave = new Waveform($('overview'), $('detail'), (sec) => player.seek(sec));
const WL_KEY = 'meeting-audit-whitelist-v1';

function fmtTime(sec        )         {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function setStatus(msg        )       { $('status').textContent = msg; }

// ---------- 阈值面板 ----------
function buildThresholdPanel()       {
  const box = $('thresholds');
  for (const f of THRESHOLD_FIELDS) {
    const row = document.createElement('label');
    row.className = 'th-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(f.step);
    input.min = String(f.min);
    input.max = String(f.max);
    input.value = String(analyzer.thresholds[f.key]);
    input.dataset.key = f.key;
    let timer = 0;
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        const stats = analyzer.updateThresholds({ [f.key]: v }                       );
        afterRecompute(stats);
      }, 150);
    });
    row.append(document.createTextNode(f.label), input);
    box.append(row);
  }
}

function afterRecompute(stats                )       {
  const pct = stats.totalWindows
    ? Math.round((stats.reevaluatedWindows / stats.totalWindows) * 100)
    : 0;
  $('recompute').textContent = stats.segmentOnly
    ? `仅重跑分段合并（帧特征缓存未动），${stats.elapsedMs.toFixed(1)}ms`
    : `重算 ${stats.reevaluatedWindows}/${stats.totalWindows} 窗口 (${pct}%)，` +
      `${stats.elapsedMs.toFixed(1)}ms`;
  renderSegments();
}

// ---------- 异常列表 ----------
function renderSegments()       {
  const segs = analyzer.segments;
  wave.setSegments(segs);
  const counts = new Map                     ();
  for (const s of segs) counts.set(s.kind, (counts.get(s.kind) || 0) + 1);
  $('counts').innerHTML = '';
  for (const k of [...FAULT_KINDS, 'music', 'pause']                 ) {
    const n = counts.get(k) || 0;
    if (!n) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.borderColor = KIND_COLORS[k];
    chip.textContent = `${KIND_LABELS[k]} ${n}`;
    $('counts').append(chip);
  }
  const list = $('segments');
  list.innerHTML = '';
  for (const s of segs) {
    if (s.kind === 'pause' && !s.whitelisted) continue; // 普通停顿不刷屏
    const item = document.createElement('div');
    item.className = 'seg';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = KIND_COLORS[s.kind];
    badge.textContent = KIND_LABELS[s.kind] + (s.whitelisted ? '·白名单' : '');
    const time = document.createElement('button');
    time.className = 'time';
    time.textContent = `${fmtTime(s.start)} – ${fmtTime(s.end)}`;
    time.title = '点击跳转';
    time.addEventListener('click', () => {
      const mid = (s.start + s.end) / 2;
      wave.centerOn(mid);
      player.seek(s.start);
      player.audio.play();
    });
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = s.detail;
    item.append(badge, time, detail);
    if (s.kind === 'silence' || s.kind === 'dropout' || s.kind === 'pause') {
      const wl = document.createElement('button');
      wl.className = 'wl';
      wl.textContent = '标为正常停顿';
      wl.addEventListener('click', () => addWhitelist(s));
      item.append(wl);
    }
    list.append(item);
  }
}

// ---------- 白名单 ----------
function loadWhitelist()                  {
  try { return JSON.parse(localStorage.getItem(WL_KEY) || '[]'); }
  catch { return []; }
}

function addWhitelist(s         )       {
  const dur = s.end - s.start;
  const rule                = {
    minSec: Math.max(0.01, dur * 0.7),
    maxSec: dur * 1.4,
    label: `正常停顿 ${dur.toFixed(1)}s`,
  };
  analyzer.setWhitelist([...analyzer.whitelist, rule]);
  localStorage.setItem(WL_KEY, JSON.stringify(analyzer.whitelist));
  renderWhitelist();
  afterRecompute({ reevaluatedWindows: 0, totalWindows: analyzer.feats?.count || 0,
    affectedDetectors: [], segmentOnly: true, elapsedMs: 0 });
}

function renderWhitelist()       {
  const box = $('whitelist');
  box.innerHTML = '';
  analyzer.whitelist.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'wl-row';
    row.textContent = `${r.label}：${r.minSec.toFixed(2)}–${r.maxSec.toFixed(2)}s `;
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', () => {
      const rules = analyzer.whitelist.filter((_, j) => j !== i);
      analyzer.setWhitelist(rules);
      localStorage.setItem(WL_KEY, JSON.stringify(rules));
      renderWhitelist();
      renderSegments();
    });
    row.append(del);
    box.append(row);
  });
}

// ---------- 文件加载 ----------
async function loadFile(file      )                {
  setStatus(`解码中… ${file.name}`);
  $('progress').style.width = '0%';
  const extractor = new FeatureExtractor();
  await player.load(file);
  try {
    await decodeFile(file, {
      onPcm: (chunk) => extractor.push(chunk),
      onProgress: (done, total) => {
        const pct = total > 0 ? Math.min(99, (done / total) * 100) : 0;
        $('progress').style.width = `${pct}%`;
        setStatus(`分析中… ${pct.toFixed(0)}%（${fmtTime(done)} / ${fmtTime(total)}）`);
      },
    });
  } catch (e) {
    setStatus(`解码失败：${(e         ).message}`);
    return;
  }
  $('progress').style.width = '100%';
  const feats = extractor.finish();
  analyzer.setFeatures(feats);
  wave.setData(feats, analyzer.segments);
  renderSegments();
  setStatus(`完成：${fmtTime(feats.count * feats.hopSec)}，${feats.count} 个分析窗口`);
}

// ---------- 导出 ----------
function exportReport()       {
  const report = {
    generatedAt: new Date().toISOString(),
    thresholds: analyzer.thresholds,
    whitelist: analyzer.whitelist,
    segments: analyzer.segments,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'meeting-audit-report.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 启动 ----------
function init()       {
  analyzer.whitelist = loadWhitelist();
  buildThresholdPanel();
  renderWhitelist();
  $('file').addEventListener('change', (e) => {
    const f = (e.target                    ).files?.[0];
    if (f) void loadFile(f);
  });
  $('demo').addEventListener('click', async () => {
    const res = await fetch('demo.wav');
    const blob = await res.blob();
    await loadFile(new File([blob], 'demo.wav'));
  });
  $('export').addEventListener('click', exportReport);
  // 播放头跟随
  const tick = ()       => {
    if (!player.audio.paused) wave.setPlayhead(player.time, true);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  player.audio.addEventListener('seeked', () => wave.setPlayhead(player.time));
}

init();
