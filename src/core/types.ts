// 所有核心模块共享的类型定义。核心层不依赖任何 DOM / Web API，可直接在 Node 中测试。

/** 解析后的 3D LUT。data 按 [rIndex][gIndex][bIndex] 排列，每个元素为线性 RGB（域由 domain 决定）。 */
export interface LUT3D {
  /** 稳定标识：对归一化后的文本做 SHA-256，相同文件重复导入结果完全一致。 */
  id: string;
  title: string;
  /** 每条轴的采样点数 N（NxNxN）。 */
  size: number;
  /** 输入域下界，通常为 [0,0,0]。 */
  domainMin: [number, number, number];
  /** 输入域上界，通常为 [1,1,1]；视频类 LUT 可能为 [1023,1023,1023]。 */
  domainMax: [number, number, number];
  /** 长度为 size^3 的扁平 RGB 表，索引 = r*size*size + g*size + b。 */
  data: Float32Array;
  /** 原始格式，用于解释顺序与域差异。 */
  format: "cube" | "3dl" | "dat";
}

/** 时间线上的一个颜色节点。 */
export interface ColorNode {
  id: string;
  /** 在时间线上的位置，单位秒。 */
  time: number;
  /** 引用的 LUT id；null 表示直通（不套 LUT）。 */
  lutId: string | null;
  /** 调色强度 0..1，0 等于原图。 */
  intensity: number;
}

/** 越界 / 过曝检测结果位标记。使用冻结对象而非 const enum，保证类型擦除后仍可运行。 */
export const PixelFlag = {
  None: 0,
  /** 任一通道达到或超过裁切阈值（过曝 / 削波）。 */
  Clipped: 1,
  /** LUT 输出超出合法域 [0,1]（越界）。 */
  OutOfGamut: 2,
  /** LUT 表项本身非法（NaN / 无穷）。 */
  InvalidSample: 4
} as const;
export type PixelFlag = (typeof PixelFlag)[keyof typeof PixelFlag];

export interface GradeOptions {
  /** 调色强度 0..1。 */
  intensity: number;
  /** 是否生成越界标记蒙版。 */
  highlightClipping: boolean;
  /** 判定过曝的通道阈值（0..1），默认 1。 */
  clipThreshold: number;
  /** 高亮叠加颜色 [r,g,b]，0..255。 */
  highlightColor: [number, number, number];
}

export const DEFAULT_GRADE_OPTIONS: GradeOptions = {
  intensity: 1,
  highlightClipping: true,
  clipThreshold: 1,
  highlightColor: [255, 0, 255]
};
