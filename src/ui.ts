// 界面渲染：频谱画布（含触发标记）、陷波器表格、事件日志。
import type { NotchBank, NotchSlot } from './notches.js';

export interface TriggerMark {
  freq: number;
  time: number;
}

const canvas = document.getElementById('spectrum') as HTMLCanvasElement;
const ctx2d = canvas.getContext('2d')!;
const notchBody = document.getElementById('notchBody') as HTMLTableSectionElement;
const logEl = document.getElementById('log') as HTMLUListElement;

export function log(msg: string, cls = ''): void {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.textContent = `[${t}] ${msg}`;
  logEl.prepend(li);
  while (logEl.children.length > 60) logEl.lastChild?.remove();
}

const STATE_TEXT: Record<string, [string, string]> = {
  active: ['抑制中', 'state-active'],
  recovering: ['恢复中', 'state-recover'],
  bypassed: ['已旁路', 'state-bypass'],
};

export function renderNotchTable(
  bank: NotchBank,
  onBypass: (slot: NotchSlot, bypassed: boolean) => void,
): void {
  notchBody.textContent = '';
  if (bank.slots.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    tr.innerHTML = '<td colspan="5">暂无陷波器</td>';
    notchBody.appendChild(tr);
    return;
  }
  for (const s of bank.slots) {
    const tr = document.createElement('tr');
    const [txt, cls] = STATE_TEXT[s.state] ?? ['?', ''];
    const pct = Math.round(s.recoverProgress * 100);
    tr.innerHTML =
      `<td>${s.id}</td><td>${s.freq.toFixed(0)} Hz</td>` +
      `<td class="${cls}">${txt}</td>` +
      `<td><span class="progress"><i style="width:${pct}%"></i></span> ${pct}%</td>`;
    const tdBypass = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = s.state === 'bypassed';
    chk.addEventListener('change', () => onBypass(s, chk.checked));
    tdBypass.appendChild(chk);
    tr.appendChild(tdBypass);
    notchBody.appendChild(tr);
  }
}

export function drawSpectrum(
  db: Float32Array,
  sampleRate: number,
  fftSize: number,
  bank: NotchBank,
  marks: TriggerMark[],
): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx2d.fillStyle = '#10131a';
  ctx2d.fillRect(0, 0, w, h);

  // 网格与频率刻度（对数轴）
  const fMin = 50, fMax = 10000;
  const xOf = (f: number) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
  ctx2d.strokeStyle = '#232b36';
  ctx2d.fillStyle = '#5c6773';
  ctx2d.font = '10px ui-monospace, monospace';
  for (const f of [100, 200, 500, 1000, 2000, 5000]) {
    const x = xOf(f);
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, h); ctx2d.stroke();
    ctx2d.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 6);
  }
  for (const dbLine of [-20, -40, -60, -80]) {
    const y = ((dbLine + 100) / 100) * h;
    const yy = h - y;
    ctx2d.beginPath(); ctx2d.moveTo(0, yy); ctx2d.lineTo(w, yy); ctx2d.stroke();
    ctx2d.fillText(`${dbLine}`, 4, yy - 2);
  }

  // 频谱曲线
  ctx2d.strokeStyle = '#4da3ff';
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  const binHz = sampleRate / fftSize;
  for (let x = 0; x < w; x++) {
    const f = fMin * Math.pow(fMax / fMin, x / w);
    const bin = Math.min(db.length - 1, Math.round(f / binHz));
    const v = Math.max(-100, Math.min(0, db[bin] ?? -100));
    const y = h - ((v + 100) / 100) * h;
    if (x === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();

  // 活动陷波（橙色竖线）
  ctx2d.strokeStyle = '#ffb84d';
  ctx2d.lineWidth = 2;
  for (const s of bank.slots) {
    const x = xOf(s.freq);
    ctx2d.globalAlpha = s.state === 'bypassed' ? 0.3 : 1 - s.recoverProgress * 0.6;
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, h); ctx2d.stroke();
  }
  ctx2d.globalAlpha = 1;

  // 触发标记（红色三角，8 秒内淡出）
  const now = performance.now() / 1000;
  ctx2d.fillStyle = '#ff5d5d';
  for (const m of marks) {
    const age = now - m.time;
    if (age > 8) continue;
    ctx2d.globalAlpha = 1 - age / 8;
    const x = xOf(m.freq);
    ctx2d.beginPath();
    ctx2d.moveTo(x, 14); ctx2d.lineTo(x - 6, 2); ctx2d.lineTo(x + 6, 2);
    ctx2d.closePath(); ctx2d.fill();
  }
  ctx2d.globalAlpha = 1;
}
