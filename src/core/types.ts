/**
 * 混音器公共类型与常量。所有参数集中在这里，核心算法不读取任何全局可变状态。
 */

export const SAMPLE_RATE = 48000;
export const BLOCK_SAMPLES = 256;

/** 最终总线硬上限（dBFS）。限制器保证输出永不超过它 */
export const CEILING_DB = -1.0;

/** 低于该碰撞速度的事件直接忽略（防止静止接触持续刷事件） */
export const MIN_AUDIBLE_SPEED = 0.12;

/** 优先级：数字越大越重要。混音时压低/替换只针对数字更小的声音 */
export const Priority = {
  Ambient: 0,
  Sfx: 1,
  Danger: 2,
  Dialogue: 3,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export type MaterialId =
  | 'coin'
  | 'wood'
  | 'glass'
  | 'stone'
  | 'rubber'
  | 'metal';

/**
 * 物理引擎推过来的一次碰撞事件。
 * time 为秒级时间戳（事件流自身时间轴，可为小数）；
 * speed 为碰撞点相对速度（m/s）；pan 为 [-1, 1] 的声像。
 */
export interface CollisionEvent {
  id: number;
  time: number;
  material: MaterialId;
  speed: number;
  pan: number;
  priority: Priority;
  /** 可选：对话/危险提示的语义标签，用于音色区分 */
  tag?: string;
}

/** 同类音色轮换：把材质归到“音色族”，族内同时发声数受配额限制 */
export type TimbreFamily =
  | 'metal'
  | 'wood'
  | 'glass'
  | 'stone'
  | 'rubber'
  | 'voice';

export const MATERIAL_FAMILY: Record<MaterialId, TimbreFamily> = {
  coin: 'metal',
  metal: 'metal',
  wood: 'wood',
  glass: 'glass',
  stone: 'stone',
  rubber: 'rubber',
};

/** 每个音色族允许同时存在的最大发声体数量（超出则在族内按优先级/时间轮换） */
export const FAMILY_QUOTA: Record<TimbreFamily, number> = {
  metal: 4,
  wood: 3,
  glass: 3,
  stone: 3,
  rubber: 2,
  voice: 2,
};

/** 总线名。对话与危险提示走独立总线，永远不被侧链压低 */
export type BusName = 'sfx' | 'dialogue' | 'danger' | 'master';

export interface BusConfig {
  /** 静态增益（dB） */
  gainDb: number;
  /** 该总线是否受 master 峰值 ducking 影响 */
  duckable: boolean;
}

export const BUS_CONFIG: Record<Exclude<BusName, 'master'>, BusConfig> = {
  sfx: { gainDb: 0, duckable: true },
  danger: { gainDb: 2, duckable: false },
  dialogue: { gainDb: 3, duckable: false },
};

/** 侧链：对话/危险出现时，sfx 总线被压低的目标 dB */
export const SIDECHAIN_DUCK_DB = -12;
/** 侧链起音/释放（秒） */
export const SIDECHAIN_ATTACK = 0.015;
export const SIDECHAIN_RELEASE = 0.18;

/** master 峰值超限时的二级 ducking 目标与时间常数 */
export const OVERLOAD_DUCK_DB = -8;
export const OVERLOAD_ATTACK = 0.005;
export const OVERLOAD_RELEASE = 0.12;

/** 限制器：块级前瞻平滑 */
export const LIMITER_ATTACK = 0.002;
export const LIMITER_RELEASE = 0.08;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 碰撞速度 -> 线性增益与亮度（0..1）。用确定性曲线，不做随机化 */
export function velocityToGain(speed: number): number {
  const v = clamp(speed / 8, 0, 1);
  // 软拐点：低速有细节、高速不炸
  return 0.08 + 0.92 * Math.tanh(v * 2.2) / Math.tanh(2.2);
}

export function velocityToBrightness(speed: number): number {
  return clamp(0.35 + speed / 10, 0.35, 1);
}
