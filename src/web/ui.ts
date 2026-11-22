// DOM 渲染：候选锚点、锚点表、段列表、逐事件表、时间轴
import type { AppState } from './state.ts';
import type { Player } from './player.ts';
import type { CandidateAnchor } from '../shared/logparse.ts';

export function renderCandidates(
  el: HTMLElement,
  candidates: CandidateAnchor[],
  confirmedLogT: Set<number>,
  onLocate: (c: CandidateAnchor) => void,
): void {
  el.innerHTML = '';
  for (const c of candidates) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (confirmedLogT.has(c.logT) ? ' confirmed' : '');
    chip.textContent = `${c.label} @日志${c.logT}ms`;
    chip.title = '点击后在事件表中定位该时刻';
    chip.addEventListener('click', () => onLocate(c));
    el.appendChild(chip);
  }
  if (candidates.length === 0) el.textContent = '未检测到启动动作或连续输入。';
}

export function renderAnchorTable(
  tbody: HTMLTableSectionElement,
  state: AppState,
  onRemove: (id: string) => void,
): void {
  tbody.innerHTML = '';
  const conflicts = new Map(state.mapping?.conflicts.map((c) => [c.anchorId, c.residualMs]) ?? []);
  const sorted = [...state.anchors].sort((a, b) => a.logT - b.logT);
  for (const a of sorted) {
    const tr = document.createElement('tr');
    const residual = conflicts.get(a.id);
    const kindLabel = { startup: '启动', run: '连输', manual: '人工' }[a.kind];
    tr.innerHTML =
      `<td>${kindLabel}</td><td>${a.logT}</td><td>${a.videoT.toFixed(1)}</td>` +
      `<td>${residual !== undefined ? `<span class="conf-low">冲突 ${residual}ms</span>` : '—'}</td>` +
      `<td>${a.note ?? ''}</td>`;
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.textContent = '删除';
    btn.addEventListener('click', () => onRemove(a.id));
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

export function renderSegments(el: HTMLElement, state: AppState): void {
  if (!state.mapping) { el.textContent = '（尚无映射：请至少添加一个锚点）'; return; }
  const lines = state.mapping.segments.map((s) => {
    const lo = s.startLogT === -Infinity ? '-∞' : s.startLogT.toFixed(0);
    const hi = s.endLogT === Infinity ? '+∞' : s.endLogT.toFixed(0);
    const flags = s.flags.length > 0 ? `  [${s.flags.join(',')}]` : '';
    return `段${s.id} 日志[${lo}, ${hi}) 斜率${s.a.toFixed(4)} 置信${(s.confidence * 100).toFixed(0)}%${flags}`;
  });
  el.textContent = lines.join('\n');
  el.style.whiteSpace = 'pre-line';
}

export function renderEventTable(el: HTMLElement, state: AppState, maxRows = 200): void {
  if (state.mapped.length === 0) { el.innerHTML = '<span class="muted">（无映射事件）</span>'; return; }
  const rows = state.mapped.slice(0, maxRows).map((m) => {
    const cls = m.confidence >= 0.8 ? 'conf-high' : m.confidence >= 0.6 ? 'conf-mid' : 'conf-low';
    return `<tr data-idx="${m.index}"><td>${m.index}</td><td>${m.logT}</td><td>${m.btn}</td>` +
      `<td>${m.state}</td><td>${m.videoT}</td><td>${m.frame}</td>` +
      `<td class="${cls}">${(m.confidence * 100).toFixed(0)}%</td><td>${m.flags.join('|')}</td></tr>`;
  });
  el.innerHTML =
    '<table><thead><tr><th>#</th><th>日志ms</th><th>键</th><th>沿</th><th>视频ms</th>' +
    '<th>帧</th><th>置信</th><th>标记</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}

export function drawTimeline(
  canvas: HTMLCanvasElement,
  state: AppState,
  player: Player,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 960;
  const cssH = 64;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  const pts = player.framePts;
  if (pts.length === 0) return;
  const t0 = pts[0];
  const t1 = pts[pts.length - 1];
  const x = (t: number) => ((t - t0) / (t1 - t0)) * (cssW - 20) + 10;

  // 映射段置信度底色
  if (state.mapping) {
    for (const seg of state.mapping.segments) {
      const vLo = seg.a * (seg.startLogT === -Infinity ? state.mapping.anchors[0].logT : seg.startLogT) + seg.b;
      const vHi = seg.a * (seg.endLogT === Infinity ? state.mapping.anchors[state.mapping.anchors.length - 1].logT : seg.endLogT) + seg.b;
      const xa = Math.max(10, x(Math.min(vLo, vHi)));
      const xb = Math.min(cssW - 10, x(Math.max(vLo, vHi)));
      if (xb <= xa) continue;
      ctx.fillStyle = seg.confidence >= 0.8 ? 'rgba(46,160,67,0.25)'
        : seg.confidence >= 0.6 ? 'rgba(201,162,39,0.25)' : 'rgba(208,69,62,0.25)';
      ctx.fillRect(xa, 8, xb - xa, 40);
    }
  }
  // 暂停标记
  if (state.frameIndex) {
    ctx.fillStyle = '#d0453e';
    for (const p of state.frameIndex.pauses) {
      const px = x(state.frameIndex.frames[p.afterFrame].pts);
      ctx.fillRect(px - 1, 4, 2, 48);
    }
  }
  // 锚点
  for (const a of state.anchors) {
    ctx.fillStyle = a.kind === 'manual' ? '#e8c15a' : '#2f6fed';
    ctx.beginPath();
    ctx.arc(x(a.videoT), 28, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // 播放头
  const cur = player.video.currentTime * 1000;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x(cur) - 1, 0, 2, cssH);
}
