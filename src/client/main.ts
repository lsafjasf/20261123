// UI wiring: transport, canvas preview, cue table, export/import.

import { FRAME_RATES, formatTimecode, nominalFps } from '../shared/timebase.ts';
import { SOUND_KINDS } from '../shared/cuelist.ts';
import { SCENE_DURATION } from '../shared/scene.ts';
import { CueStore } from './foley.ts';
import { Transport } from './transport.ts';
import { CueScheduler } from './scheduler.ts';
import { drawScene } from './animator.ts';
import { Timeline } from './timeline.ts';
import { renderMix, encodeWav } from './render.ts';
import { recordScenePreview } from './recorder.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const stage = $<HTMLCanvasElement>('stage');
const timelineCanvas = $<HTMLCanvasElement>('timeline');
const frameReadout = $('frame-readout');
const tcReadout = $('tc-readout');
const srReadout = $('sr-readout');
const fpsSelect = $<HTMLSelectElement>('fps-select');
const rangeIn = $<HTMLInputElement>('range-in');
const rangeOut = $<HTMLInputElement>('range-out');
const cueTableBody = document.querySelector<HTMLTableSectionElement>('#cue-table tbody')!;
const cueCount = $('cue-count');
const roundtripStatus = $('roundtrip-status');

// --- audio + transport ---
const audio = new AudioContext({ latencyHint: 'interactive' });
const master = audio.createGain();
master.gain.value = 0.9;
master.connect(audio.destination);

let currentRate = FRAME_RATES[1].rate; // 24 fps default
const transport = new Transport(audio, currentRate);
const store = new CueStore(currentRate, audio.sampleRate);
const scheduler = new CueScheduler(audio, transport, master);
const timeline = new Timeline(timelineCanvas);

srReadout.textContent = `${audio.sampleRate} Hz`;
transport.loopEndFrame = Math.ceil(SCENE_DURATION * nominalFps(currentRate));

for (const { label, rate } of FRAME_RATES) {
  const opt = document.createElement('option');
  opt.value = label;
  opt.textContent = `${label} fps`;
  if (rate === currentRate) opt.selected = true;
  fpsSelect.appendChild(opt);
}
for (const sel of ['interval-sound', 'single-sound']) {
  const el = $<HTMLSelectElement>(sel);
  for (const kind of SOUND_KINDS) {
    const opt = document.createElement('option');
    opt.value = kind;
    opt.textContent = kind;
    el.appendChild(opt);
  }
}

let looping = false;

function fps(): number {
  return currentRate.num / currentRate.den;
}

function sceneEndFrame(): number {
  return Math.ceil(SCENE_DURATION * fps());
}

// --- render loop ---
function renderFrame(): void {
  const frame = transport.currentFrame();
  if (transport.playing && frame >= sceneEndFrame()) {
    if (looping) transport.seek(0);
    else transport.pause();
  }
  const f = transport.currentFrame();
  drawScene(stage, f / fps());
  timeline.render(f, store.cues, fps(), Number(rangeIn.value), Number(rangeOut.value));
  frameReadout.textContent = `帧 ${f}`;
  tcReadout.textContent = formatTimecode(f, currentRate);
  requestAnimationFrame(renderFrame);
}

transport.onchange = () => renderCueTable();
store.onchange = () => {
  renderCueTable();
  const ok = store.verifyRoundTrip();
  roundtripStatus.textContent = ok ? '✓ 清单导出/重载自洽' : '✗ 清单自洽性失败';
  roundtripStatus.className = ok ? 'hint ok' : 'hint bad';
};

// --- transport controls ---
$('btn-play').addEventListener('click', async () => {
  await audio.resume();
  const btn = $('btn-play');
  if (transport.playing) {
    transport.pause();
    scheduler.stop();
    btn.textContent = '▶ 播放';
  } else {
    transport.play();
    scheduler.start(() => store.cueList);
    btn.textContent = '⏸ 暂停';
  }
});
$('btn-start').addEventListener('click', () => transport.seek(0));
$('btn-prev').addEventListener('click', () => transport.step(-1));
$('btn-next').addEventListener('click', () => transport.step(1));
$('btn-loop').addEventListener('click', (e) => {
  looping = !looping;
  (e.target as HTMLButtonElement).classList.toggle('active', looping);
});
fpsSelect.addEventListener('change', () => {
  const found = FRAME_RATES.find((r) => r.label === fpsSelect.value);
  if (!found) return;
  currentRate = found.rate;
  transport.setRate(currentRate);
  store.setFrameRate(currentRate);
  rangeOut.value = String(sceneEndFrame());
});
timeline.onSeek = (frame) => transport.seek(frame);
timeline.onRange = (from, to) => {
  rangeIn.value = String(from);
  rangeOut.value = String(to);
};
$('btn-set-in').addEventListener('click', () => {
  rangeIn.value = String(transport.currentFrame());
});
$('btn-set-out').addEventListener('click', () => {
  rangeOut.value = String(transport.currentFrame());
});

// --- cue table ---
function renderCueTable(): void {
  const cues = store.cues;
  cueCount.textContent = `(${cues.length})`;
  cueTableBody.textContent = '';
  const current = transport.currentFrame();
  for (const cue of cues) {
    const tr = document.createElement('tr');
    if (cue.frame === current) tr.className = 'current';

    const tdFrame = document.createElement('td');
    tdFrame.textContent = String(cue.frame);
    const tdOffset = document.createElement('td');
    tdOffset.textContent = String(cue.offsetSamples);
    const tdSound = document.createElement('td');
    tdSound.textContent = cue.sound;
    const tdLabel = document.createElement('td');
    tdLabel.textContent = cue.label;

    const tdGain = document.createElement('td');
    const gain = document.createElement('input');
    gain.type = 'range';
    gain.min = '0';
    gain.max = '1';
    gain.step = '0.01';
    gain.value = String(cue.gain);
    gain.addEventListener('input', () => store.setGain(cue.id, Number(gain.value)));
    tdGain.appendChild(gain);

    const tdNudge = document.createElement('td');
    const nudges: Array<[string, () => void, string]> = [
      ['-1f', () => store.nudgeFrames(cue.id, -1), '后退一帧'],
      ['-1s', () => store.nudgeSamples(cue.id, -1), '后退一个采样'],
      ['+1s', () => store.nudgeSamples(cue.id, 1), '前进一个采样'],
      ['+1f', () => store.nudgeFrames(cue.id, 1), '前进一帧'],
    ];
    for (const [label, fn, title] of nudges) {
      const b = document.createElement('button');
      b.className = 'nudge';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      tdNudge.appendChild(b);
    }
    const gotoBtn = document.createElement('button');
    gotoBtn.className = 'nudge';
    gotoBtn.textContent = '↦';
    gotoBtn.title = '跳到这一帧';
    gotoBtn.addEventListener('click', () => transport.seek(cue.frame));
    tdNudge.appendChild(gotoBtn);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'nudge';
    del.textContent = '✕';
    del.addEventListener('click', () => store.removeCue(cue.id));
    tdDel.appendChild(del);

    tr.append(tdFrame, tdOffset, tdSound, tdGain, tdLabel, tdNudge, tdDel);
    cueTableBody.appendChild(tr);
  }
}

// --- generation ---
$('btn-gen-scene').addEventListener('click', () => {
  const from = Math.min(Number(rangeIn.value), Number(rangeOut.value));
  const to = Math.max(Number(rangeIn.value), Number(rangeOut.value));
  store.generateFromScene(from, to, fps());
});
$('btn-gen-interval').addEventListener('click', () => {
  const from = Math.min(Number(rangeIn.value), Number(rangeOut.value));
  const to = Math.max(Number(rangeIn.value), Number(rangeOut.value));
  const every = Number($<HTMLInputElement>('interval-frames').value);
  const sound = $<HTMLSelectElement>('interval-sound').value as (typeof SOUND_KINDS)[number];
  store.generateInterval(from, to, every, sound);
});
$('btn-add-single').addEventListener('click', () => {
  const sound = $<HTMLSelectElement>('single-sound').value as (typeof SOUND_KINDS)[number];
  store.addCue(transport.currentFrame(), sound, 1, '手动');
});
$('btn-clear').addEventListener('click', () => store.clear());

// --- export / import ---
function download(filename: string, data: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('btn-export').addEventListener('click', () => {
  download('foley-cues.json', new Blob([store.export()], { type: 'application/json' }));
});

$('file-import').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    store.import(await file.text());
    const rate = store.frameRate();
    const found = FRAME_RATES.find((r) => r.rate.num === rate.num && r.rate.den === rate.den);
    if (found) {
      currentRate = found.rate;
      fpsSelect.value = found.label;
      transport.setRate(currentRate);
    }
  } catch (err) {
    alert(`清单载入失败: ${String(err)}`);
  }
});

$('btn-wav').addEventListener('click', async () => {
  const btn = $('btn-wav');
  btn.textContent = '渲染中…';
  try {
    const buffer = await renderMix(store.cueList);
    download('foley-mix.wav', new Blob([encodeWav(buffer)], { type: 'audio/wav' }));
  } finally {
    btn.textContent = '渲染 WAV';
  }
});

// --- server save / load ---
async function refreshSavedList(): Promise<void> {
  const sel = $<HTMLSelectElement>('saved-list');
  sel.textContent = '';
  try {
    const names: string[] = await (await fetch('/api/cuelists')).json();
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  } catch {
    /* server storage optional */
  }
}

$('btn-save').addEventListener('click', async () => {
  const name = $<HTMLInputElement>('save-name').value.trim() || 'demo';
  const res = await fetch(`/api/cuelist?name=${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: store.export(),
  });
  if (!res.ok) alert('保存失败');
  await refreshSavedList();
});

$('btn-load').addEventListener('click', async () => {
  const name = $<HTMLSelectElement>('saved-list').value;
  if (!name) return;
  const res = await fetch(`/api/cuelist?name=${encodeURIComponent(name)}`);
  if (!res.ok) {
    alert('载入失败');
    return;
  }
  store.import(await res.text());
});

// --- offline animation recording (WebCodecs -> MediaSource) ---
$('btn-record').addEventListener('click', async () => {
  const btn = $('btn-record');
  btn.textContent = '录制中…';
  const result = await recordScenePreview($<HTMLVideoElement>('recorded'), currentRate, (done, total) => {
    btn.textContent = `录制中 ${done}/${total}`;
  });
  btn.textContent = result.ok ? '重新录制动画预览' : '录制动画预览 (WebCodecs→MediaSource)';
  roundtripStatus.textContent = result.message;
  roundtripStatus.className = result.ok ? 'hint ok' : 'hint bad';
});

// --- boot ---
rangeOut.value = String(sceneEndFrame());
void refreshSavedList();
renderCueTable();
requestAnimationFrame(renderFrame);
