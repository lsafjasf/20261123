// 3D LUT 文本解析器，支持 Adobe/Resolve 风格 .cube 与通用 .3dl。
// 设计目标：确定性（同样文本必然得到同样 id 与数据）、无第三方依赖、可在 Node 与浏览器运行。

import type { LUT3D } from "./types.ts";
import { sha256Hex } from "./hash.ts";

export class LUTParseError extends Error {
  readonly lineNumber: number;
  constructor(message: string, lineNumber: number) {
    super(`LUT 解析失败（第 ${lineNumber} 行）：${message}`);
    this.name = "LUTParseError";
    this.lineNumber = lineNumber;
  }
}

interface Normalized {
  /** 去掉注释、统一换行与空白后的有效行，哈希基于它计算。 */
  lines: string[];
  rawText: string;
}

/** 归一化：CRLF->LF、去注释、trim、折叠连续空白、丢弃空行。 */
export function normalizeLutText(text: string): Normalized {
  const lines: string[] = [];
  for (const original of text.replace(/\r\n?/g, "\n").split("\n")) {
    const withoutComment = original.replace(/#.*$/, "").trim();
    if (!withoutComment) continue;
    const collapsed = withoutComment.replace(/\s+/g, " ");
    lines.push(collapsed);
  }
  return { lines, rawText: lines.join("\n") };
}

function toNumber(token: string, lineNumber: number): number {
  const value = Number(token);
  if (!Number.isFinite(value)) throw new LUTParseError(`“${token}” 不是合法数字`, lineNumber);
  return value;
}

function parseCube(lines: string[]): Omit<LUT3D, "id" | "format"> {
  let size = 0;
  let title = "未命名 LUT";
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const parts = line.split(" ");
    if (Number.isNaN(Number(parts[0]))) {
      const keyword = (parts[0] ?? "").toUpperCase();
      const args = parts.slice(1);
      if (keyword === "LUT_3D_SIZE") {
        size = toNumber(args[0] ?? "", lineNumber);
      } else if (keyword === "TITLE") {
        title = (args.join(" ") || title).replace(/^"|"$/g, "");
      } else if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
        const target = keyword === "DOMAIN_MIN" ? domainMin : domainMax;
        for (let channel = 0; channel < 3; channel += 1) {
          target[channel] = toNumber(args[channel] ?? "0", lineNumber);
        }
      } else if (keyword === "LUT_1D_SIZE") {
        throw new LUTParseError("仅支持 3D LUT，发现 LUT_1D_SIZE", lineNumber);
      } else {
        throw new LUTParseError(`未知关键字 “${keyword}”`, lineNumber);
      }
      return;
    }
    if (parts.length !== 3) {
      throw new LUTParseError(`数据行需要 3 个分量，实际为 ${parts.length} 个`, lineNumber);
    }
    values.push(toNumber(parts[0], lineNumber), toNumber(parts[1], lineNumber), toNumber(parts[2], lineNumber));
  });

  if (size < 2 || size > 256) throw new LUTParseError(`LUT_3D_SIZE 非法：${size}`, 0);
  if (values.length !== size * size * size * 3) {
    throw new LUTParseError(`数据点数量 ${values.length / 3} 与 ${size}^3 不匹配`, 0);
  }
  return { title, size, domainMin, domainMax, data: Float32Array.from(values) };
}

/**
 * 通用 .3dl：首行为 N（每轴点数），随后 N^3 行 RGB 整数。
 * Autodesk 风格为 0..1023，17 点表为 0..64。按最大值自动归一化到 0..1。
 * 行序与 .cube 相同（R 最慢、B 最快）。
 */
function parse3dl(lines: string[]): Omit<LUT3D, "id" | "format"> {
  const firstParts = lines[0]?.split(" ") ?? [];
  let size = 0;
  let dataStart = 0;
  if (firstParts.length === 1) {
    size = toNumber(firstParts[0] ?? "0", 1);
    dataStart = 1;
  } else {
    size = Math.round(Math.cbrt(lines.length));
    if (size ** 3 !== lines.length) {
      throw new LUTParseError(`.3dl 行数 ${lines.length} 不是完整立方数，且缺少尺寸头`, 1);
    }
  }
  if (size < 2 || size > 256) throw new LUTParseError(`LUT 尺寸非法：${size}`, 1);

  const rows: number[][] = [];
  let maxValue = 0;
  for (let index = dataStart; index < lines.length; index += 1) {
    const parts = lines[index].split(" ");
    if (parts.length !== 3) {
      throw new LUTParseError(`数据行需要 3 个分量，实际为 ${parts.length} 个`, index + 1);
    }
    const row = parts.map((token) => toNumber(token, index + 1));
    for (const value of row) maxValue = Math.max(maxValue, value);
    rows.push(row);
  }
  if (rows.length !== size ** 3) {
    throw new LUTParseError(`数据点数量 ${rows.length} 与 ${size}^3 不匹配`, 0);
  }
  const scale = maxValue > 1 ? maxValue : 1;
  const data = new Float32Array(rows.length * 3);
  rows.forEach((row, rowIndex) => {
    data[rowIndex * 3] = row[0] / scale;
    data[rowIndex * 3 + 1] = row[1] / scale;
    data[rowIndex * 3 + 2] = row[2] / scale;
  });
  return {
    title: `3DL_${size}`,
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data
  };
}

/** 解析 LUT 文本。format 可显式指定，否则按内容特征自动判别。 */
export function parseLUT(text: string, fileName = "lut"): LUT3D {
  const normalized = normalizeLutText(text);
  if (!normalized.lines.length) throw new LUTParseError("文件为空", 0);
  const looksCube = normalized.lines.some((line) => line.toUpperCase().startsWith("LUT_3D_SIZE"));
  const format: LUT3D["format"] = fileName.toLowerCase().endsWith(".3dl") && !looksCube ? "3dl" : looksCube ? "cube" : "cube";
  const parsed = format === "3dl" ? parse3dl(normalized.lines) : parseCube(normalized.lines);
  return {
    ...parsed,
    format,
    id: sha256Hex(normalized.rawText)
  };
}
