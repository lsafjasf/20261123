import type { AnalysisBand, DeviceId, StemId } from './types.ts';

// 12 bands loosely following Bark scale edges up to 16 kHz, wide enough for
// robust frame power estimates without a large FFT.
export const ANALYSIS_BANDS: AnalysisBand[] = [
  { index: 0, lowHz: 20, highHz: 100, centerHz: 60 },
  { index: 1, lowHz: 100, highHz: 200, centerHz: 150 },
  { index: 2, lowHz: 200, highHz: 300, centerHz: 250 },
  { index: 3, lowHz: 300, highHz: 510, centerHz: 405 },
  { index: 4, lowHz: 510, highHz: 770, centerHz: 640 },
  { index: 5, lowHz: 770, highHz: 1080, centerHz: 925 },
  { index: 6, lowHz: 1080, highHz: 1480, centerHz: 1280 },
  { index: 7, lowHz: 1480, highHz: 2000, centerHz: 1740 },
  { index: 8, lowHz: 2000, highHz: 2700, centerHz: 2350 },
  { index: 9, lowHz: 2700, highHz: 3700, centerHz: 3200 },
  { index: 10, lowHz: 3700, highHz: 7000, centerHz: 5350 },
  { index: 11, lowHz: 7000, highHz: 16000, centerHz: 11500 },
];

export interface DeviceModel {
  id: DeviceId;
  label: string;
  description: string;
  // Per-band output gain in dB applied to the rendered mix. These numbers are
  // published engineering estimates for a whole device class, not measurements
  // of any specific hardware unit.
  bandResponseDb: number[];
  // Additive ambient/self-noise floor per band in dBFS-equivalent power.
  noiseFloorDb: number[];
  // Headroom ceiling: levels above this engage the modelled limiter (dBTP).
  ceilingDb: number;
  // Hard clipping threshold for the modelled output stage (dBTP).
  clipThresholdDb: number;
  // High-pass cut applied by the transducer/chain (second order approximation).
  highPassHz: number;
  // Low-pass cut applied by the transducer/chain.
  lowPassHz: number;
}

const flatResponse = ANALYSIS_BANDS.map(() => 0);

export const DEVICE_MODELS: Record<DeviceId, DeviceModel> = {
  'monitor-headphones': {
    id: 'monitor-headphones',
    label: '监听耳机（近似参考）',
    description:
      '近场封闭监听耳机的近似平坦响应参考链，用于和其它条件做相对比较。',
    bandResponseDb: flatResponse,
    noiseFloorDb: ANALYSIS_BANDS.map(() => -96),
    ceilingDb: -1,
    clipThresholdDb: -0.3,
    highPassHz: 20,
    lowPassHz: 20000,
  },
  'phone-speaker': {
    id: 'phone-speaker',
    label: '手机扬声器（近似模型）',
    description:
      '典型手机全频小喇叭经验模型：低频大幅滚降、2–6 kHz 有峰、输出受限。',
    bandResponseDb: [-18, -12, -8, -4, -1, 1, 3, 4, 5, 4, 1, -4],
    noiseFloorDb: [-78, -78, -76, -74, -72, -70, -70, -70, -70, -70, -72, -75],
    ceilingDb: -2.5,
    clipThresholdDb: -1,
    highPassHz: 220,
    lowPassHz: 12000,
  },
  'car-cabin': {
    id: 'car-cabin',
    label: '车载座舱（近似模型）',
    description:
      '行驶座舱经验模型：路噪/风噪抬高掩蔽底噪，低频被舱体加强，高频受限。',
    bandResponseDb: [4, 5, 3, 1, 0, 0, -1, -2, -3, -4, -7, -12],
    noiseFloorDb: [-55, -52, -52, -55, -58, -60, -62, -63, -64, -65, -68, -72],
    ceilingDb: -2,
    clipThresholdDb: -0.8,
    highPassHz: 40,
    lowPassHz: 11000,
  },
  'laptop-speaker': {
    id: 'laptop-speaker',
    label: '笔记本扬声器（近似模型）',
    description:
      '轻薄笔记本小喇叭经验模型：低频滚降、动态范围小、容易触发内置限幅。',
    bandResponseDb: [-14, -9, -5, -2, 0, 1, 2, 2, 1, 0, -2, -7],
    noiseFloorDb: [-74, -74, -72, -70, -69, -69, -70, -71, -72, -73, -76, -80],
    ceilingDb: -3,
    clipThresholdDb: -1.2,
    highPassHz: 160,
    lowPassHz: 14000,
  },
};

export const DEVICE_ORDER: DeviceId[] = [
  'monitor-headphones',
  'phone-speaker',
  'car-cabin',
  'laptop-speaker',
];

export const STEM_LABELS: Record<StemId, string> = {
  dialogue: '对白',
  music: '音乐',
  effects: '效果声',
};

export const ANALYSIS_CONFIG = {
  fftSize: 2048,
  hopSec: 0.05,
  frameSec: 0.05,
  loudnessWindowSec: 0.4,
  loudnessHopSec: 0.1,
  // Frames below this audibility ratio are treated as masked dialogue.
  audibilityWarn: 0.7,
  audibilityCritical: 0.4,
  // Minimum event length so single-frame flicker is not reported.
  minEventFrames: 3,
};
