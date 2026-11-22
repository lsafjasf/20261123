// LUT 注册表：以归一化文本的 SHA-256 为键，保证同一文件反复导入结果一致、不会重复占用。

import type { LUT3D } from "./types.ts";
import { parseLUT } from "./lutParser.ts";

export interface ImportResult {
  lut: LUT3D;
  /** true 表示此前已导入过，本次为幂等命中。 */
  duplicated: boolean;
}

export class LUTRegistry {
  private readonly entries = new Map<string, LUT3D>();

  importText(text: string, fileName?: string): ImportResult {
    const lut = parseLUT(text, fileName ?? "lut.cube");
    const existing = this.entries.get(lut.id);
    if (existing) {
      return { lut: existing, duplicated: true };
    }
    this.entries.set(lut.id, lut);
    return { lut, duplicated: false };
  }

  get(id: string): LUT3D | undefined {
    return this.entries.get(id);
  }

  list(): LUT3D[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }

  remove(id: string): boolean {
    return this.entries.delete(id);
  }
}
