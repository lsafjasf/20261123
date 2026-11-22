// 颜色时间线：管理多个颜色节点，并在任意播放时刻给出平滑过渡后的调色状态。

import type { ColorNode } from "./types.ts";

export interface TimelineSample {
  /** 当前时刻主 LUT id（过渡起点节点）。 */
  fromLutId: string | null;
  /** 过渡终点 LUT id；无过渡时与 fromLutId 相同。 */
  toLutId: string | null;
  /** 终点 LUT 的混合权重 0..1。 */
  mix: number;
  /** 平滑后的强度 0..1。 */
  intensity: number;
  /** 当前时刻落在哪个节点区间（左侧节点索引）。 */
  segmentIndex: number;
}

export class ColorTimeline {
  private nodes: ColorNode[] = [];

  addNode(node: ColorNode): void {
    this.nodes.push(node);
    this.nodes.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }

  removeNode(id: string): void {
    this.nodes = this.nodes.filter((node) => node.id !== id);
  }

  updateNode(id: string, patch: Partial<Omit<ColorNode, "id">>): void {
    const target = this.nodes.find((node) => node.id === id);
    if (!target) return;
    Object.assign(target, patch);
    this.nodes.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }

  getNodes(): readonly ColorNode[] {
    return this.nodes;
  }

  clear(): void {
    this.nodes = [];
  }

  /** 在指定时刻采样调色状态；节点之间对强度做线性插值，对 LUT 做交叉混合。 */
  sampleAt(time: number): TimelineSample | null {
    if (!this.nodes.length) return null;
    const sorted = this.nodes;
    if (time <= sorted[0].time) {
      const first = sorted[0];
      return {
        fromLutId: first.lutId,
        toLutId: first.lutId,
        mix: 0,
        intensity: first.intensity,
        segmentIndex: 0
      };
    }
    const last = sorted[sorted.length - 1];
    if (time >= last.time) {
      return {
        fromLutId: last.lutId,
        toLutId: last.lutId,
        mix: 0,
        intensity: last.intensity,
        segmentIndex: sorted.length - 1
      };
    }
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const left = sorted[index];
      const right = sorted[index + 1];
      if (time >= left.time && time <= right.time) {
        const span = right.time - left.time;
        const t = span === 0 ? 0 : (time - left.time) / span;
        // smoothstep 缓动，让节点交接处无折点。
        const eased = t * t * (3 - 2 * t);
        return {
          fromLutId: left.lutId,
          toLutId: right.lutId,
          mix: eased,
          intensity: left.intensity + (right.intensity - left.intensity) * eased,
          segmentIndex: index
        };
      }
    }
    return null;
  }
}
