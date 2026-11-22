export type {
  AlgorithmState,
  AudioPacket,
  ChannelDiagnostic,
  ConcealmentInterval,
  ConcealmentOptions,
  FillMethod,
  GapAnalysis,
  GapClassification,
  RepairEvent,
  RepairReport,
  RepairStats,
  TransitionPlan
} from "./core/types.ts";
export { analyzeGap, classifyGap } from "./core/analyze.ts";
export { concealGap } from "./core/conceal.ts";
export { DEFAULT_OPTIONS, resampleChannels } from "./core/dsp.ts";
export { inspectPacket } from "./core/integrity.ts";
export { repairPackets } from "./core/repair.ts";
export { encodeWavPcm16, makeWav, renderPackets, renderReport } from "./core/render.ts";
export type { RenderedAudio } from "./core/render.ts";
export { muxOpusWebM } from "./media/webm.ts";
export type { EncodedAudioFrame, OpusWebMOptions } from "./media/webm.ts";
