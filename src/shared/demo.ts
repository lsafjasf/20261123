// 演示数据：确定性的 VFR/掉帧/暂停视频帧表 + 与之对应的手柄日志。
// Node CLI 与浏览器演示模式共用，保证两端生成完全一致的时间轴。
import type { Anchor, ComboDef, InputLog } from './types.ts';

/** 视频帧 PTS（毫秒）：60fps → 3s 录制暂停 → 掉帧 → VFR 20~24fps */
export function demoFramePts(): number[] {
  const pts: number[] = [];
  let t = 0;
  while (t < 30000) { pts.push(Math.round(t * 100) / 100); t += 1000 / 60; }
  t = 33000; // 录制暂停 3s，PTS 跳变
  let i = 0;
  while (t < 60000) {
    if (i % 37 !== 0) pts.push(Math.round(t * 100) / 100); // 周期性掉帧
    t += 1000 / 60; i++;
  }
  while (t < 90000) { pts.push(Math.round(t * 100) / 100); t += 1000 / (20 + (i++ % 5)); }
  return pts;
}

/** 日志时钟比视频早 40s 开始；暂停期间日志时钟继续走但无输入 */
export const DEMO_OFFSET_MS = 40000;
export const DEMO_PAUSE_LOG_START = 70000; // 日志时钟上的暂停起点
export const DEMO_PAUSE_MS = 3000;

/** 地面真值映射（仅用于演示校验）：日志时间 → 视频 PTS */
export function demoTruthVideoT(logT: number): number {
  if (logT < DEMO_PAUSE_LOG_START) return logT - DEMO_OFFSET_MS;
  return logT - DEMO_OFFSET_MS - DEMO_PAUSE_MS;
}

export function demoLog(): InputLog {
  const events: { t: number; btn: string; state: 'down' | 'up' }[] = [];
  const press = (t: number, btn: string, holdMs = 80) => {
    events.push({ t, btn, state: 'down' }, { t: t + holdMs, btn, state: 'up' });
  };
  // 启动动作：3 次 A（logT 41000 起 → 视频 1000ms）
  for (let i = 0; i < 3; i++) press(41000 + i * 200, 'A');
  // 连续输入：8 次 B @180ms（logT 60000 起 → 视频 20000ms）
  for (let i = 0; i < 8; i++) press(60000 + i * 180, 'B', 60);
  // 连招：波动拳 DOWN→FWD→P（视频约 25s）
  press(65000, 'DOWN', 100); press(65090, 'FWD', 100); press(65160, 'P');
  // 暂停前散点
  press(68000, 'X'); press(69500, 'Y');
  // 暂停 3s（日志时钟走到 73000，期间无输入）
  // 暂停后：连续输入 6 次 C @200ms（logT 80000 → 视频 37000）
  for (let i = 0; i < 6; i++) press(80000 + i * 200, 'C', 60);
  // 暂停后再来一次连招（视频约 45s）
  press(88000, 'DOWN', 100); press(88080, 'FWD', 100); press(88150, 'P');
  // VFR 区间散点（视频 60~90s ↔ logT 103000~133000）
  press(105000, 'A'); press(110000, 'B'); press(120000, 'X'); press(130000, 'P');
  events.sort((x, y) => x.t - y.t);
  return { meta: { device: 'demo-pad', note: '合成演示日志' }, events };
}

/** 演示用锚点：故意只给暂停前的两个自动锚点，第三段需人工确认 */
export function demoAnchors(): Anchor[] {
  return [
    { id: 'startup', logT: 41000, videoT: demoTruthVideoT(41000), kind: 'startup', weight: 1, note: '启动动作 A×3' },
    { id: 'run-b', logT: 60000, videoT: demoTruthVideoT(60000), kind: 'run', weight: 1, note: '连续输入 B×8' },
  ];
}

export function demoCombos(): ComboDef[] {
  return [{
    id: 'hadouken', name: '波动拳',
    steps: [
      { btn: 'DOWN', withinMs: 0 },
      { btn: 'FWD', withinMs: 200 },
      { btn: 'P', withinMs: 200 },
    ],
  }];
}
