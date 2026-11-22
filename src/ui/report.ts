import type { RenderResult } from '../dsp/engine.js';

const f = (x: number, d = 2) => (isFinite(x) ? x.toFixed(d) : '−∞');

function row(cells: string[], header = false): string {
  const tag = header ? 'th' : 'td';
  return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
}

export function renderLoudnessTable(r: RenderResult): void {
  const el = document.getElementById('loudnessTable') as HTMLElement;
  const b = r.loudnessBefore;
  const a = r.loudnessAfter;
  el.innerHTML = [
    row(['指标', '处理前', '处理后'], true),
    row(['综合响度 (LUFS)', f(b.integratedLufs, 1), f(a.integratedLufs, 1)]),
    row(['短时峰值 (LUFS)', f(b.peakLufsShortTerm, 1), f(a.peakLufsShortTerm, 1)]),
    row(['响度范围 LRA (LU)', f(b.lra, 1), f(a.lra, 1)]),
    row(['采样峰值 (dBFS)', f(r.peakBeforeDb), f(r.peakAfterDb)]),
    row(['真峰值 (dBTP)', '—', f(r.truePeakAfterDb)]),
    row(['补偿增益 (dB)', '—', f(r.makeupDb)]),
    row([
      '峰值检查',
      '—',
      `<span class="${r.ceilingOk ? 'ok' : 'bad'}">${r.ceilingOk ? '未越线 ✓' : '越线 ✗'}</span>`,
    ]),
  ].join('');
}

export function renderTransientTable(r: RenderResult): void {
  const el = document.getElementById('transientTable') as HTMLElement;
  const rows = [row(['频段', '瞬态数', '平均损失 dB', '最大损失 dB', '波峰因数前', '波峰因数后'], true)];
  for (const t of r.transient) {
    rows.push(row([
      t.band,
      String(t.onsetCount),
      f(t.meanLossDb),
      f(t.maxLossDb),
      f(t.crestBeforeDb, 1),
      f(t.crestAfterDb, 1),
    ]));
  }
  el.innerHTML = rows.join('');
}

export function loudnessReportJson(r: RenderResult, sourceName: string): string {
  return JSON.stringify({
    source: sourceName,
    generatedAt: new Date().toISOString(),
    loudness: {
      before: {
        integratedLufs: r.loudnessBefore.integratedLufs,
        shortTermMaxLufs: r.loudnessBefore.peakLufsShortTerm,
        lraLu: r.loudnessBefore.lra,
        samplePeakDb: r.peakBeforeDb,
      },
      after: {
        integratedLufs: r.loudnessAfter.integratedLufs,
        shortTermMaxLufs: r.loudnessAfter.peakLufsShortTerm,
        lraLu: r.loudnessAfter.lra,
        samplePeakDb: r.peakAfterDb,
        truePeakDbtp: r.truePeakAfterDb,
      },
    },
    makeupDb: r.makeupDb,
    ceilingDb: r.ceilingDb,
    ceilingOk: r.ceilingOk,
  }, null, 2);
}

export function transientReportJson(r: RenderResult, sourceName: string, sampleRate: number): string {
  return JSON.stringify({
    source: sourceName,
    generatedAt: new Date().toISOString(),
    note: 'lossDb 为每个瞬态起音后 15ms 窗口 RMS 的处理前后差值（正数=损失）',
    bands: r.transient.map((t) => ({
      band: t.band,
      onsetCount: t.onsetCount,
      meanLossDb: t.meanLossDb,
      maxLossDb: t.maxLossDb,
      crestBeforeDb: t.crestBeforeDb,
      crestAfterDb: t.crestAfterDb,
      crestDeltaDb: t.crestDeltaDb,
      onsets: t.onsets.map((o) => ({
        timeSec: o.index / sampleRate,
        impactDbBefore: o.impactDbBefore,
        impactDbAfter: o.impactDbAfter,
        lossDb: o.lossDb,
        peakDbBefore: o.peakDbBefore,
        peakDbAfter: o.peakDbAfter,
      })),
    })),
  }, null, 2);
}

export function download(filename: string, data: BlobPart, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
