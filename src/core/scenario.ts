/**
 * 确定性碰撞事件流：用固定 seed 生成一场“硬币轻响 -> 木箱/玻璃同时落地”
 * 的物理碰撞场景，包含连续小幅碰撞、同帧多事件、对话与危险提示。
 * 事件流本身也是 seed 驱动的，测试里可以直接比较两次生成结果。
 */

import { Rng } from './rng.ts';
import { Priority, type CollisionEvent, type MaterialId } from './types.ts';

export interface ScenarioOptions {
  /** 总时长（秒） */
  duration: number;
  /** 每秒平均碰撞数（物理引擎高频事件） */
  collisionsPerSecond: number;
  seed: number;
}

export const DEFAULT_SCENARIO: ScenarioOptions = {
  duration: 12,
  collisionsPerSecond: 14,
  seed: 20261123,
};

const PHYSICS_MATERIALS: MaterialId[] = [
  'coin',
  'coin',
  'coin',
  'wood',
  'glass',
  'stone',
  'rubber',
  'metal',
];

export function generateScenario(
  options: Partial<ScenarioOptions> = {},
): CollisionEvent[] {
  const cfg = { ...DEFAULT_SCENARIO, ...options };
  const rng = new Rng(cfg.seed);
  const events: CollisionEvent[] = [];
  let id = 1;

  // 物理碰撞：指数间隔的高频事件流，速度服从对数正态式分布
  let time = rng.range(0, 0.05);
  while (time < cfg.duration) {
    const material =
      PHYSICS_MATERIALS[rng.int(0, PHYSICS_MATERIALS.length - 1)];
    const speed = Math.max(
      0.04,
      rng.next() * rng.next() * 9 + rng.range(0.02, 0.3),
    );
    events.push({
      id: id++,
      time,
      material,
      speed,
      pan: rng.range(-0.9, 0.9),
      priority: Priority.Sfx,
    });
    // 偶发同帧簇（物理引擎一帧内多次接触）
    if (rng.next() < 0.18) {
      events.push({
        id: id++,
        time: time + rng.range(0.001, 0.008),
        material,
        speed: speed * rng.range(0.5, 1),
        pan: rng.range(-0.9, 0.9),
        priority: Priority.Sfx,
      });
    }
    time += -Math.log(1 - rng.next()) / cfg.collisionsPerSecond;
  }

  // 剧情锚点：木箱与玻璃在同一时刻落地（同帧、高速、多材质）
  const impactTime = Math.round(cfg.duration * 0.62 * 1000) / 1000;
  events.push({
    id: id++,
    time: impactTime,
    material: 'wood',
    speed: 7.6,
    pan: -0.55,
    priority: Priority.Sfx,
    tag: 'crate-landing',
  });
  events.push({
    id: id++,
    time: impactTime + 0.004,
    material: 'glass',
    speed: 8.4,
    pan: 0.5,
    priority: Priority.Sfx,
    tag: 'glass-shatter',
  });
  // 玻璃碎片后续小碰撞
  for (let i = 0; i < 6; i++) {
    events.push({
      id: id++,
      time: impactTime + 0.05 + i * 0.03 + rng.range(0, 0.01),
      material: 'glass',
      speed: rng.range(0.4, 2.2),
      pan: rng.range(0.2, 0.95),
      priority: Priority.Sfx,
    });
  }

  // 重要对话：压在密集碰撞上，验证侧链与优先级
  events.push({
    id: id++,
    time: cfg.duration * 0.3,
    material: 'rubber',
    speed: 0,
    pan: 0,
    priority: Priority.Dialogue,
    tag: 'dialogue-watch-out',
  });
  // 危险提示：与落地同时出现，必须始终清楚
  events.push({
    id: id++,
    time: impactTime,
    material: 'metal',
    speed: 0,
    pan: 0,
    priority: Priority.Danger,
    tag: 'danger-alarm',
  });
  events.push({
    id: id++,
    time: cfg.duration * 0.85,
    material: 'rubber',
    speed: 0,
    pan: 0.15,
    priority: Priority.Dialogue,
    tag: 'dialogue-clear',
  });

  return events.sort((a, b) => (a.time === b.time ? a.id - b.id : a.time - b.time));
}
