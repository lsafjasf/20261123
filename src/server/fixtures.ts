/**
 * 程序化测试样本生成器（纯 Node、确定性、无第三方依赖）。
 *
 * 生成的是「指标层」样本（FrameMetric 序列），刻意覆盖三类误判场景：
 * 黑场：纯黑长段 / 近黑但欠曝的正常画面 / 单帧闪白不应打断黑场 / 片头黑场
 * 静止：真静止长镜 / 极缓慢移动（低 diff 但持续运动，不应报静止）/ 黑场不应重复报静止
 * 抖动：手持抖动（高运动+高无序）/ 平滑平移（高运动+低无序，不应报抖动）/ 硬切瞬时尖峰
 * 镜头：硬切 / 叠化软切 / 超短镜头合并
 */
import { createHash } from 'node:crypto';
import type { FrameMetric, MetricBundle } from '../shared/types.ts';
import { ENGINE_VERSION } from '../shared/config.ts';

export interface FixtureSpec {
  name: string;
  description: string;
  /** 期望命中的文件级标签。 */
  expectLabels: Array<'black' | 'still' | 'shaky'>;
  /** 期望至少出现的镜头数。 */
  expectMinShots: number;
  build: (fps: number) => FrameMetric[];
}

const FPS = 30;

function frame(index: number, overrides: Partial<FrameMetric> = {}): FrameMetric {
  return {
    index,
    pts: index / FPS,
    meanLuma: 120,
    blackRatio: 0,
    diff: 8,
    motion: 2,
    motionDisorder: 0.1,
    audioRms: 0.05,
    ...overrides,
  };
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

/** 正常基线帧序列。 */
function baseline(start: number, end: number): FrameMetric[] {
  return range(start, end).map((index) => frame(index));
}

function blackFrames(start: number, end: number): FrameMetric[] {
  return range(start, end).map((index) =>
    frame(index, { meanLuma: 4, blackRatio: 0.995, diff: 0.4, motion: 0.1, motionDisorder: 0, audioRms: 0 }),
  );
}

function freezeFrames(start: number, end: number): FrameMetric[] {
  return range(start, end).map((index) =>
    frame(index, { diff: 0.6, motion: 0.2, motionDisorder: 0.02 }),
  );
}

function shakeFrames(start: number, end: number): FrameMetric[] {
  return range(start, end).map((index) =>
    frame(index, {
      diff: 14 + (index % 3) * 2,
      motion: 9 + (index % 4),
      motionDisorder: 0.55 + (index % 2) * 0.1,
    }),
  );
}

function panFrames(start: number, end: number): FrameMetric[] {
  return range(start, end).map((index) =>
    frame(index, { diff: 12, motion: 8.5, motionDisorder: 0.08 }),
  );
}

function slowDrift(start: number, end: number): FrameMetric[] {
  return range(start, end).map((index) =>
    frame(index, { diff: 1.4, motion: 0.9 + index * 0.0005, motionDisorder: 0.05 }),
  );
}

function hardCut(index: number): FrameMetric[] {
  return [frame(index, { diff: 42, motion: 20, motionDisorder: 0.2 })];
}

function dissolve(start: number, end: number): FrameMetric[] {
  const mid = (start + end) / 2;
  return range(start, end).map((index) => {
    const arch = 1 - Math.abs(index - mid) / (end - start);
    return frame(index, {
      diff: 4 + arch * 16,
      motion: 6,
      motionDisorder: 0.15,
    });
  });
}

export const FIXTURE_SPECS: FixtureSpec[] = [
  {
    name: '01-black-with-flash',
    description: '长黑场中穿插单帧闪白：闪白不应打断黑场，且黑场不能被重复标成静止',
    expectLabels: ['black'],
    expectMinShots: 1,
    build: () => {
      const frames = [...blackFrames(0, 45)];
      frames.push(frame(45, { meanLuma: 200, blackRatio: 0.02, diff: 60 }));
      frames.push(...blackFrames(46, 90));
      frames.push(...baseline(90, 150));
      return frames;
    },
  },
  {
    name: '02-near-black-underexposed',
    description: '近黑欠曝正常画面：亮度低但黑像素占比不达标，不应误判黑场',
    expectLabels: [],
    expectMinShots: 1,
    build: () =>
      range(0, 150).map((index) =>
        frame(index, { meanLuma: 22, blackRatio: 0.72, diff: 6 + (index % 5), motion: 2.5 }),
      ),
  },
  {
    name: '03-freeze-then-motion',
    description: '真静止长镜后恢复运动：应报静止，恢复后区间必须结束',
    expectLabels: ['still'],
    expectMinShots: 1,
    build: () => [...baseline(0, 30), ...freezeFrames(30, 120), ...baseline(120, 180)],
  },
  {
    name: '04-slow-drift-not-freeze',
    description: '极缓慢运镜：diff 很低但块运动持续，不应误判静止',
    expectLabels: [],
    expectMinShots: 1,
    build: () => slowDrift(0, 180),
  },
  {
    name: '05-handheld-shake',
    description: '手持抖动：高运动幅度且方向无序，应报抖动',
    expectLabels: ['shaky'],
    expectMinShots: 1,
    build: () => [...baseline(0, 30), ...shakeFrames(30, 120), ...baseline(120, 180)],
  },
  {
    name: '06-smooth-pan-not-shake',
    description: '平滑横移：运动幅度高但方向一致，不应误判抖动',
    expectLabels: [],
    expectMinShots: 1,
    build: () => [...baseline(0, 20), ...panFrames(20, 170), ...baseline(170, 200)],
  },
  {
    name: '07-hard-cuts-and-dissolve',
    description: '硬切与叠化混排，且含超短镜头：应切出多个镜头并合并碎片',
    expectLabels: [],
    expectMinShots: 3,
    build: () => {
      const frames = [...baseline(0, 60), ...hardCut(60), ...baseline(61, 121)];
      frames.push(...dissolve(121, 129), ...baseline(129, 160));
      frames.push(...hardCut(160), ...baseline(161, 167));
      frames.push(...hardCut(167), ...baseline(168, 220));
      return frames;
    },
  },
  {
    name: '08-mixed-defects',
    description: '综合素材：片头黑场 + 静止 + 抖动 + 硬切，三类标签都应命中且镜头数>=3',
    expectLabels: ['black', 'still', 'shaky'],
    expectMinShots: 3,
    build: () => {
      let frames = [...blackFrames(0, 30), ...hardCut(30), ...baseline(31, 61)];
      frames = [...frames, ...freezeFrames(61, 130), ...hardCut(130), ...baseline(131, 161)];
      frames = [...frames, ...shakeFrames(161, 230), ...hardCut(230), ...baseline(231, 280)];
      return frames;
    },
  },
];

export function buildBundle(spec: FixtureSpec): MetricBundle {
  const frames = spec.build(FPS);
  const sha256 = createHash('sha256')
    .update(`fixture:${spec.name}`)
    .digest('hex');
  const lastPts = frames[frames.length - 1]?.pts ?? 0;
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    file: { name: `${spec.name}.synthetic.mp4`, size: frames.length * 1024, sha256 },
    video: {
      width: 640,
      height: 360,
      frameRate: FPS,
      frameCount: frames.length,
      durationSec: lastPts + 1 / FPS,
      hasAudio: true,
    },
    sampleEvery: 1,
    frames,
    collector: 'node-fixture-generator',
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };
}
