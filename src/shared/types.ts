/**
 * 全项目共享的领域类型定义。
 * 仅使用可被 Node 内置类型擦除直接移除的 TS 语法（type/interface），
 * 不使用 enum、namespace、参数属性等不可擦除语法。
 */

/** 测量管线中的五个分段标识（顺序即管线顺序）。 */
export type StageId =
  | 'capture'
  | 'process'
  | 'upload'
  | 'decode'
  | 'output';

export const STAGE_IDS: readonly StageId[] = [
  'capture',
  'process',
  'upload',
  'decode',
  'output',
];

export const STAGE_LABELS: Readonly<Record<StageId, string>> = {
  capture: '采集',
  process: '处理',
  upload: '上传',
  decode: '解码',
  output: '声卡输出',
};

/** 参与方角色。 */
export type Role = 'sender' | 'receiver';

/** 单个标记事件的阶段时间点（单位毫秒，统一归一到接收端本地时钟）。 */
export interface MarkerTimeline {
  roundId: string;
  /** 标记序号，轮次内自增、从 0 开始。 */
  seq: number;
  /** T0：Canvas 闪光 + WebAudio 短促声响调度时刻。 */
  t0Marker: number;
  /** T1：采集端 AudioWorklet 看到该标记波形。 */
  t1Captured: number | null;
  /** T2：处理 Worklet 输出该标记样本。 */
  t2Processed: number | null;
  /** T3：编码完成、即将通过 WebSocket 发送。 */
  t3Encoded: number | null;
  /** T4：服务端收到该媒体帧（服务端时钟，经时钟同步换算）。 */
  t4ServerRx: number | null;
  /** T5：服务端转发给接收端。 */
  t5ServerTx: number | null;
  /** T6：接收端 WebSocket 收到帧。 */
  t6ClientRx: number | null;
  /** T7：SourceBuffer 完成解复用/解码入队。 */
  t7Decoded: number | null;
  /** T8：输出 Worklet 实际推动声卡播放该标记样本。 */
  t8Output: number | null;
}

/** 单个分段的统计结果。 */
export interface StageStats {
  stage: StageId;
  label: string;
  samples: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  /** 抖动：相邻分段耗时差值的标准差（毫秒）。 */
  jitterMs: number;
  /** 该分段观测到的丢样次数。 */
  droppedSamples: number;
}

/** 一轮测量的完整报告。 */
export interface RoundReport {
  roundId: string;
  label: string;
  startedAt: number;
  closedAt: number | null;
  markerCount: number;
  matchedMarkers: number;
  totalLatency: {
    meanMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
    jitterMs: number;
  };
  stages: StageStats[];
  slowestStage: StageId | null;
  droppedTotal: number;
  clock: {
    offsetMs: number;
    rttMs: number;
  };
}

/** 丢样事件记录。 */
export interface DropEvent {
  roundId: string;
  at: number;
  stage: StageId | 'network';
  detail: string;
  expectedSeq: number | null;
}

/** 轮次元数据。 */
export interface RoundMeta {
  roundId: string;
  label: string;
  startedAt: number;
  closedAt: number | null;
}

