// Canvas 叠加层：按键状态、连招窗口、置信度、帧读数。纯函数，导出时复用。
export interface OverlayState {
  frame: number;
  ptsMs: number;
  logMs: number | null;
  confidence: number; // 0..1
  flags: string[];
  /** 当前按下的按键及已按住时长 ms */
  pressed: { btn: string; heldMs: number }[];
  /** 进行中的连招窗口 */
  combos: { name: string; remainMs: number; totalMs: number }[];
  paused?: boolean;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, s: OverlayState): void {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const u = Math.max(1, Math.round(h / 360)); // 分辨率无关的单位
  ctx.font = `${12 * u}px ui-monospace, monospace`;
  ctx.textBaseline = 'middle';

  // 顶部置信度条
  const conf = Math.max(0, Math.min(1, s.confidence));
  const confColor = conf >= 0.8 ? '#2ea043' : conf >= 0.6 ? '#c9a227' : '#d0453e';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, w, 18 * u);
  ctx.fillStyle = confColor;
  ctx.fillRect(0, 0, w * conf, 4 * u);
  ctx.fillStyle = '#fff';
  const flagText = s.flags.length > 0 ? ` [${s.flags.join(',')}]` : '';
  ctx.fillText(`帧 ${s.frame}  PTS ${s.ptsMs.toFixed(1)}ms  置信 ${(conf * 100).toFixed(0)}%${flagText}`,
    8 * u, 9 * u);
  if (s.logMs !== null) {
    ctx.textAlign = 'right';
    ctx.fillText(`日志 ${s.logMs.toFixed(0)}ms`, w - 8 * u, 9 * u);
    ctx.textAlign = 'left';
  }

  // 左下按键芯片
  let x = 10 * u;
  const y = h - 26 * u;
  for (const p of s.pressed) {
    const label = `${p.btn} ${(p.heldMs / 1000).toFixed(1)}s`;
    const tw = ctx.measureText(label).width + 16 * u;
    ctx.fillStyle = 'rgba(47,111,237,0.85)';
    roundRect(ctx, x, y - 11 * u, tw, 22 * u, 5 * u);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 8 * u, y);
    x += tw + 6 * u;
  }

  // 右上连招窗口
  let cy = 30 * u;
  for (const c of s.combos) {
    const frac = c.totalMs > 0 ? c.remainMs / c.totalMs : 0;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, w - 170 * u, cy - 10 * u, 160 * u, 20 * u, 5 * u);
    ctx.fill();
    ctx.fillStyle = '#e8c15a';
    ctx.fillRect(w - 166 * u, cy + 5 * u, 152 * u * Math.max(0, frac), 3 * u);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${c.name} ${(c.remainMs / 1000).toFixed(2)}s`, w - 162 * u, cy - 1 * u);
    cy += 26 * u;
  }

  if (s.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 18 * u, w, 14 * u);
    ctx.fillStyle = '#e8c15a';
    ctx.fillText('⏸ 录制暂停区间', 8 * u, 25 * u);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
