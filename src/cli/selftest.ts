import { fftRadix2, gainToDb } from '../shared/dsp-math.ts';
import { measureLoudness } from '../shared/loudness.ts';
import { runAnalysis } from '../shared/analysis-pipeline.ts';
import { synthesizeFixture } from '../shared/fixtures.ts';
import type { AudioBufferData } from '../shared/types.ts';

const check = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(`自测失败：${message}`);
  }
  process.stdout.write(`  ok - ${message}\n`);
};

const approximate = (actual: number, expected: number, tolerance: number): boolean =>
  Math.abs(actual - expected) <= tolerance;

const toneBuffer = (
  frequency: number,
  amplitude: number,
  sampleRate: number,
  seconds: number,
): AudioBufferData => {
  const length = sampleRate * seconds;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    data[i] = amplitude * Math.sin(2 * Math.PI * frequency * (i / sampleRate));
  }
  return { sampleRate, channels: [data], label: 'tone' };
};

// Two matched mixes: identical dialogue, one with an overpowering music bed,
// one with the bed attenuated, for deterministic masking assertions.
const maskingControlledFixture = (): {
  loud: Parameters<typeof runAnalysis>[0];
  quiet: Parameters<typeof runAnalysis>[0];
} => {
  const sampleRate = 24000;
  const length = sampleRate * 4;
  const dialogue = new Float32Array(length);
  const loudMusic = new Float32Array(length);
  const quietMusic = new Float32Array(length);
  const silence = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    dialogue[i] =
      0.3 * Math.sin(2 * Math.PI * 800 * t) +
      0.22 * Math.sin(2 * Math.PI * 2400 * t);
    const bed =
      0.7 * Math.sin(2 * Math.PI * 820 * t) +
      0.55 * Math.sin(2 * Math.PI * 2350 * t);
    loudMusic[i] = bed;
    quietMusic[i] = bed * Math.pow(10, -24 / 20);
  }
  const make = (data: Float32Array, label: string): AudioBufferData => ({
    sampleRate,
    channels: [data],
    label,
  });
  return {
    loud: {
      dialogue: make(dialogue, 'dialogue'),
      music: make(loudMusic, 'music'),
      effects: make(silence, 'effects'),
    },
    quiet: {
      dialogue: make(dialogue, 'dialogue'),
      music: make(quietMusic, 'music'),
      effects: make(silence, 'effects'),
    },
  };
};

export const runSelfTest = async (): Promise<void> => {
  process.stdout.write('自测开始\n');

  const real = new Float32Array(8);
  const imag = new Float32Array(8);
  real[0] = 1;
  real[4] = 1;
  fftRadix2(real, imag);
  check(approximate(real[0], 2, 1e-6) && approximate(real[4], 2, 1e-6), 'FFT 直流/奈奎斯特分量正确');

  const fullScale = toneBuffer(1000, 0.5, 24000, 4);
  const loudness = measureLoudness(fullScale);
  check(
    approximate(loudness.truePeakDb, gainToDb(0.5), 0.2),
    '真峰测量接近 0.5 振幅对应电平',
  );
  check(loudness.integratedLufs < -2, '持续正弦的积分响度低于满刻度');

  const fixture = synthesizeFixture(24000, 6);
  const baseline = runAnalysis(fixture, {
    gains: { dialogue: 0, music: 0, effects: 0 },
  });
  check(baseline.devices.length === 4, '四个近似播放条件全部产出分析结果');
  check(
    baseline.devices.every((device) => device.frames.length > 50),
    '每个条件生成逐帧指标',
  );

  const phone = baseline.devices.find((device) => device.deviceId === 'phone-speaker');
  check(phone !== undefined, '手机扬声器条件存在');
  const maskingEvents = phone!.events.filter((event) => event.kind === 'masking');
  const controlled = maskingControlledFixture();
  const maskedReport = runAnalysis(controlled.loud, {
    gains: { dialogue: 0, music: 0, effects: 0 },
  });
  const controlledEvents = maskedReport.devices
    .find((device) => device.deviceId === 'phone-speaker')!
    .events.filter((event) => event.kind === 'masking');
  check(controlledEvents.length > 0, '强掩蔽信号在手机模型中检出对白掩蔽时段');
  check(
    controlledEvents.every((event) => event.endSec > event.startSec),
    '掩蔽事件均带明确起止时间',
  );
  const clearedReport = runAnalysis(controlled.quiet, {
    gains: { dialogue: 0, music: 0, effects: 0 },
  });
  const clearedEvents = clearedReport.devices
    .find((device) => device.deviceId === 'phone-speaker')!
    .events.filter((event) => event.kind === 'masking');
  check(
    clearedEvents.length < controlledEvents.length,
    '压低音乐/效果声后掩蔽事件减少，说明分轨开关参与判定',
  );

  const clipLength = 24000 * 2;
  const clippedSignal = new Float32Array(clipLength);
  for (let i = 0; i < clipLength; i += 1) {
    const t = i / 24000;
    clippedSignal[i] =
      1.3 *
      (Math.sin(2 * Math.PI * 300 * t) +
        0.6 * Math.sin(2 * Math.PI * 1200 * t));
  }
  const clipped: AudioBufferData = {
    sampleRate: 24000,
    channels: [clippedSignal],
    label: 'overdriven',
  };
  const clipReport = runAnalysis(
    { dialogue: clipped, music: clipped, effects: clipped },
    { gains: { dialogue: 0, music: 0, effects: 0 } },
  );
  const clipEvents = clipReport.devices.flatMap((device) =>
    device.events.filter((event) => event.kind === 'clipping'),
  );
  check(clipEvents.length > 0, '满幅方波在各近似输出链中检出削波事件');

  check(
    baseline.modelNotice.includes('近似模型'),
    '报告显著标注近似模型而非真机测量',
  );

  process.stdout.write('全部自测通过\n');
};
