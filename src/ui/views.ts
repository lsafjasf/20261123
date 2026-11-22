import { BAND_COLOR_HEX } from './controls.js';

interface Ctx {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

function setup(id: string): Ctx {
  const canvas = document.getElementById(id) as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, w: cssW, h: cssH };
}

function columnMinMax(x: Float32Array, cols: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(cols).fill(Infinity);
  const max = new Float32Array(cols).fill(-Infinity);
  for (let i = 0; i < x.length; i++) {
    const c = Math.min(cols - 1, Math.floor(i / x.length * cols));
    if (x[i] < min[c]) min[c] = x[i];
    if (x[i] > max[c]) max[c] = x[i];
  }
  return { min, max };
}

export function drawWaveform(
  before: Float32Array | null,
  after: Float32Array | null,
  ceilingDb: number,
): void {
  const { ctx, w, h } = setup('waveCanvas');
  const mid = h / 2;
  const amp = h / 2 - 8;

  ctx.strokeStyle = '#2c313a';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  // Ceiling lines — peaks must never cross these.
  const ceilLin = Math.pow(10, ceilingDb / 20);
  ctx.strokeStyle = '#ff5f56';
  ctx.setLineDash([5, 4]);
  for (const sign of [1, -1]) {
    const y = mid - sign * ceilLin * amp;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = '#ff5f56';
  ctx.font = '10px sans-serif';
  ctx.fillText(`天花板 ${ceilingDb.toFixed(1)} dBTP`, 6, mid - ceilLin * amp - 3);

  const draw = (x: Float32Array, color: string) => {
    const { min, max } = columnMinMax(x, Math.floor(w));
    ctx.fillStyle = color;
    for (let c = 0; c < w; c++) {
      const y1 = mid - max[c] * amp;
      const y2 = mid - min[c] * amp;
      ctx.fillRect(c, y1, 1, Math.max(1, y2 - y1));
    }
  };
  if (before) draw(before, 'rgba(138,145,157,0.55)');
  if (after) draw(after, 'rgba(77,163,255,0.75)');

  ctx.fillStyle = '#8a919d';
  ctx.fillText(before ? '灰: 原始' : '', w - 110, 14);
  ctx.fillStyle = '#4da3ff';
  ctx.fillText(after ? '蓝: 处理后' : '', w - 52, 14);
}

export interface GainLane {
  name: string;
  gainDb: Float32Array;
  color: string;
}

export function drawGainLanes(lanes: GainLane[], limiterGainDb: Float32Array | null): void {
  const { ctx, w, h } = setup('gainCanvas');
  const all = limiterGainDb
    ? [...lanes, { name: '限制器', gainDb: limiterGainDb, color: '#ff5f56' }]
    : lanes;
  const laneH = h / all.length;
  const topDb = 3;
  const botDb = -24;
  const yOf = (db: number, lane: number) =>
    lane * laneH + ((topDb - db) / (topDb - botDb)) * laneH;

  all.forEach((lane, li) => {
    ctx.strokeStyle = '#2c313a';
    ctx.strokeRect(0.5, li * laneH + 0.5, w - 1, laneH - 1);
    // 0 dB reference
    ctx.strokeStyle = 'rgba(138,145,157,0.4)';
    ctx.beginPath();
    ctx.moveTo(0, yOf(0, li));
    ctx.lineTo(w, yOf(0, li));
    ctx.stroke();

    const cols = Math.floor(w);
    const { min } = columnMinMax(lane.gainDb, cols);
    ctx.fillStyle = lane.color + '55';
    ctx.strokeStyle = lane.color;
    ctx.beginPath();
    ctx.moveTo(0, yOf(0, li));
    for (let c = 0; c < cols; c++) ctx.lineTo(c, yOf(Math.max(botDb, min[c]), li));
    ctx.lineTo(cols - 1, yOf(0, li));
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const y = yOf(Math.max(botDb, min[c]), li);
      if (c === 0) ctx.moveTo(c, y); else ctx.lineTo(c, y);
    }
    ctx.stroke();

    let minDb = 0;
    for (let i = 0; i < lane.gainDb.length; i++) minDb = Math.min(minDb, lane.gainDb[i]);
    ctx.fillStyle = lane.color;
    ctx.font = '11px sans-serif';
    ctx.fillText(`${lane.name}  最深 ${minDb.toFixed(1)} dB`, 6, li * laneH + 14);
  });
}

export interface EnergyLane {
  name: string;
  energyDb: Float32Array;
  peakDb: number;
}

export function drawEnergyLanes(lanes: EnergyLane[]): void {
  const { ctx, w, h } = setup('energyCanvas');
  const laneH = h / lanes.length;
  const topDb = 0;
  const botDb = -60;
  const yOf = (db: number, lane: number) =>
    lane * laneH + ((topDb - Math.max(botDb, db)) / (topDb - botDb)) * laneH;

  lanes.forEach((lane, li) => {
    const color = BAND_COLOR_HEX[li % BAND_COLOR_HEX.length];
    ctx.strokeStyle = '#2c313a';
    ctx.strokeRect(0.5, li * laneH + 0.5, w - 1, laneH - 1);

    const cols = Math.floor(w);
    ctx.fillStyle = color + '44';
    ctx.beginPath();
    ctx.moveTo(0, yOf(botDb, li));
    for (let c = 0; c < cols; c++) {
      const idx = Math.min(lane.energyDb.length - 1, Math.floor(c / cols * lane.energyDb.length));
      ctx.lineTo(c, yOf(lane.energyDb[idx], li));
    }
    ctx.lineTo(cols - 1, yOf(botDb, li));
    ctx.closePath();
    ctx.fill();

    // Peak marker for the band.
    ctx.strokeStyle = color;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, yOf(lane.peakDb, li));
    ctx.lineTo(w, yOf(lane.peakDb, li));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.font = '11px sans-serif';
    ctx.fillText(`${lane.name}  峰值 ${lane.peakDb.toFixed(1)} dB`, 6, li * laneH + 14);
  });
}
