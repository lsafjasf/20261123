// Canvas 证据图：波形 + 四条特征曲线 + 可疑边界标记，可导出 PNG。
import type { FeatureSet } from "./features.ts";
import type { Boundary } from "./detect.ts";
import { robustZ } from "./dsp.ts";

const PANELS = 5;
const PAD_L = 56, PAD_R = 12, PAD_T = 10, PAD_B = 22, GAP = 8;

function drawPanel(
  ctx: CanvasRenderingContext2D,
  y: number, h: number, w: number,
  label: string,
  series: ArrayLike<number>,
  times: Float32Array,
  color: string,
  thresh: number | null,
) {
  ctx.strokeStyle = "#2c3440";
  ctx.strokeRect(PAD_L, y, w - PAD_L - PAD_R, h);
  ctx.fillStyle = "#8b94a3";
  ctx.font = "11px system-ui";
  ctx.textAlign = "right";
  ctx.fillText(label, PAD_L - 6, y + 12);
  let max = 0;
  for (let i = 0; i < series.length; i++) if (series[i] > max) max = series[i];
  max = max || 1;
  const innerW = w - PAD_L - PAD_R;
  const x0 = times[0], x1 = times[times.length - 1] || 1;
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const px = PAD_L + ((times[i] - x0) / (x1 - x0)) * innerW;
    const py = y + h - (series[i] / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
  if (thresh !== null && thresh < max) {
    const py = y + h - (thresh / max) * (h - 4) - 2;
    ctx.strokeStyle = "#ff7a7a55";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD_L, py);
    ctx.lineTo(w - PAD_R, py);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function renderEvidence(
  canvas: HTMLCanvasElement,
  pcm: Float32Array,
  sampleRate: number,
  f: FeatureSet,
  hits: Boundary[],
  zThresh: number,
): void {
  const cssW = canvas.clientWidth || 1100;
  const dpr = window.devicePixelRatio || 1;
  const panelH = 110;
  const h = PAD_T + PANELS * (panelH + GAP) + PAD_B;
  canvas.width = cssW * dpr;
  canvas.height = h * dpr;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, h);

  // 面板 1：波形包络（降采样峰值）
  const nBins = Math.min(2000, Math.floor(cssW));
  const env = new Float32Array(nBins);
  const envT = new Float32Array(nBins);
  const step = Math.max(1, Math.floor(pcm.length / nBins));
  for (let b = 0; b < nBins; b++) {
    let peak = 0;
    const off = b * step;
    for (let i = 0; i < step && off + i < pcm.length; i++) {
      const a = Math.abs(pcm[off + i]);
      if (a > peak) peak = a;
    }
    env[b] = peak;
    envT[b] = (off / sampleRate);
  }

  const zFloor = robustZ(f.floorStep);
  const zPhase = robustZ(f.phaseBreak);
  const zJump = robustZ(f.sampleJump);

  let y = PAD_T;
  drawPanel(ctx, y, panelH, cssW, "波形包络", env, envT, "#7fb3ff", null); y += panelH + GAP;
  drawPanel(ctx, y, panelH, cssW, "底噪阶跃 z", zFloor, f.times, "#ffd166", zThresh); y += panelH + GAP;
  drawPanel(ctx, y, panelH, cssW, "相位断裂 z", zPhase, f.times, "#ef8354", zThresh); y += panelH + GAP;
  drawPanel(ctx, y, panelH, cssW, "样本跳变 z", zJump, f.times, "#c77dff", zThresh); y += panelH + GAP;
  drawPanel(ctx, y, panelH, cssW, "重复相关", f.repeatScore, f.times, "#80ed99", 0.985);

  // 可疑边界竖线 + 时间轴
  const innerW = cssW - PAD_L - PAD_R;
  const x1 = f.times[f.times.length - 1] || 1;
  for (const hit of hits) {
    const px = PAD_L + (hit.time / x1) * innerW;
    ctx.strokeStyle = hit.severity === "high" ? "#ff5a5a" : hit.severity === "mid" ? "#ffc46b" : "#8b94a3";
    ctx.lineWidth = hit.severity === "high" ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(px, PAD_T);
    ctx.lineTo(px, h - PAD_B);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  ctx.fillStyle = "#8b94a3";
  ctx.textAlign = "center";
  for (let t = 0; t <= x1; t += Math.max(1, Math.round(x1 / 10))) {
    const px = PAD_L + (t / x1) * innerW;
    ctx.fillText(`${t.toFixed(0)}s`, px, h - 6);
  }
}

export function exportPng(canvas: HTMLCanvasElement, name: string): void {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = name;
  a.click();
}
