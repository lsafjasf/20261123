import { DEFAULT_BAND_SETTINGS, type BandCompSettings } from '../dsp/dynamics.js';
import { DEFAULT_CROSSOVERS, BAND_NAMES } from '../dsp/crossover.js';
import type { EngineSettings } from '../dsp/engine.js';

interface CtlDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const MASTER_CTLS: CtlDef[] = [
  { key: 'targetLufs', label: '目标响度', min: -30, max: -6, step: 0.5, unit: 'LUFS' },
  { key: 'ceilingDb', label: '峰值天花板', min: -6, max: 0, step: 0.1, unit: 'dBTP' },
  { key: 'maxMakeupDb', label: '最大补偿增益', min: 0, max: 18, step: 0.5, unit: 'dB' },
  { key: 'maxLimiterGrDb', label: '限制器GR预算', min: 0, max: 12, step: 0.5, unit: 'dB' },
];

const BAND_CTLS: CtlDef[] = [
  { key: 'thresholdDb', label: '阈值', min: -48, max: 0, step: 0.5, unit: 'dB' },
  { key: 'ratio', label: '压缩比', min: 1, max: 10, step: 0.1, unit: ':1' },
  { key: 'attackMs', label: '启动', min: 0.1, max: 100, step: 0.1, unit: 'ms' },
  { key: 'releaseMs', label: '释放', min: 10, max: 500, step: 1, unit: 'ms' },
  { key: 'maxGainReductionDb', label: '最大GR', min: 0, max: 30, step: 0.5, unit: 'dB' },
  { key: 'transientPreserve', label: '瞬态保留', min: 0, max: 1, step: 0.05, unit: '' },
];

const BAND_COLORS = ['var(--band0)', 'var(--band1)', 'var(--band2)', 'var(--band3)'];

export const BAND_COLOR_HEX = ['#ff9f43', '#3ecf8e', '#4da3ff', '#c792ea'];

function makeSlider(
  def: CtlDef,
  value: number,
  onChange: () => void,
): { label: HTMLLabelElement; get: () => number } {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(def.step);
  input.value = String(value);
  const update = () => {
    caption.textContent = `${def.label} ${Number(input.value).toFixed(def.step < 1 ? 1 : 0)}${def.unit}`;
  };
  input.addEventListener('input', () => { update(); onChange(); });
  update();
  label.append(caption, input);
  return { label, get: () => Number(input.value) };
}

export interface ControlsUI {
  readSettings: () => EngineSettings;
}

export function buildControls(onChange: () => void): ControlsUI {
  const masterEl = document.getElementById('masterControls') as HTMLElement;
  const bandEl = document.getElementById('bandControls') as HTMLElement;
  const xoInfo = document.getElementById('xoInfo') as HTMLElement;
  xoInfo.textContent = `分频点 ${DEFAULT_CROSSOVERS.join(' / ')} Hz（LR4）`;

  const masterDefaults: Record<string, number> = {
    targetLufs: -14, ceilingDb: -1, maxMakeupDb: 12, maxLimiterGrDb: 6,
  };
  const masterGetters: Record<string, () => number> = {};
  for (const def of MASTER_CTLS) {
    const { label, get } = makeSlider(def, masterDefaults[def.key], onChange);
    masterEl.appendChild(label);
    masterGetters[def.key] = get;
  }

  const bandGetters: Record<string, () => number>[] = [];
  BAND_NAMES.forEach((name, i) => {
    const box = document.createElement('div');
    box.className = 'band';
    const h = document.createElement('h3');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = BAND_COLORS[i];
    const range = i === 0 ? `< ${DEFAULT_CROSSOVERS[0]} Hz`
      : i === BAND_NAMES.length - 1 ? `> ${DEFAULT_CROSSOVERS[DEFAULT_CROSSOVERS.length - 1]} Hz`
      : `${DEFAULT_CROSSOVERS[i - 1]}–${DEFAULT_CROSSOVERS[i]} Hz`;
    h.append(sw, document.createTextNode(`${name} · ${range}`));
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const getters: Record<string, () => number> = {};
    const defaults = DEFAULT_BAND_SETTINGS as unknown as Record<string, number>;
    for (const def of BAND_CTLS) {
      const { label, get } = makeSlider(def, defaults[def.key], onChange);
      ctl.appendChild(label);
      getters[def.key] = get;
    }
    box.append(h, ctl);
    bandEl.appendChild(box);
    bandGetters.push(getters);
  });

  return {
    readSettings(): EngineSettings {
      const bands: BandCompSettings[] = bandGetters.map((g) => ({
        thresholdDb: g.thresholdDb(),
        ratio: g.ratio(),
        attackMs: g.attackMs(),
        releaseMs: g.releaseMs(),
        kneeDb: DEFAULT_BAND_SETTINGS.kneeDb,
        makeupDb: 0,
        maxGainReductionDb: g.maxGainReductionDb(),
        transientPreserve: g.transientPreserve(),
      }));
      return {
        crossovers: [...DEFAULT_CROSSOVERS],
        bands,
        targetLufs: masterGetters.targetLufs(),
        ceilingDb: masterGetters.ceilingDb(),
        maxMakeupDb: masterGetters.maxMakeupDb(),
        maxLimiterGrDb: masterGetters.maxLimiterGrDb(),
      };
    },
  };
}
