// 手工构造 AAC-LC 数字静音帧与 AudioSpecificConfig。
// 静音帧：单个 SCE，max_sfb=0（不传输任何谱线），解码输出全零。

import { BitWriter } from "./bits.ts";

export interface AacConfig {
  sampleRate: number; // 44100 或 48000
  channels: number; // 1 或 2
}

const SAMPLE_RATE_INDEX: Record<number, number> = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4,
  32000: 5, 24000: 6, 22050: 7, 16000: 8, 12000: 9,
  11025: 10, 8000: 11, 7350: 12,
};

export const AAC_FRAME_SAMPLES = 1024;

export function audioSpecificConfig(cfg: AacConfig): Uint8Array {
  const idx = SAMPLE_RATE_INDEX[cfg.sampleRate];
  if (idx === undefined) throw new Error(`不支持的采样率: ${cfg.sampleRate}`);
  const w = new BitWriter();
  w.bits(2, 5); // audioObjectType = AAC LC
  w.bits(idx, 4); // samplingFrequencyIndex
  w.bits(cfg.channels, 4); // channelConfiguration
  w.bit(0); // frameLengthFlag
  w.bit(0); // dependsOnCoreCoder
  w.bit(0); // extensionFlag
  return w.toUint8Array();
}

function silentSce(w: BitWriter, tag: number): void {
  w.bits(0, 3); // id_syn_ele = SCE
  w.bits(tag, 4); // element_instance_tag
  // ics_info
  w.bit(0); // ics_reserved_bit
  w.bits(0, 2); // window_sequence = ONLY_LONG_SEQUENCE
  w.bit(0); // window_shape
  w.bits(0, 6); // max_sfb = 0 -> 无 section、无谱线
  w.bit(0); // predictor_present (LC)
  w.bits(0, 8); // global_gain
  // max_sfb=0 -> section_data / scale_factor_data / spectral 全部为空
  w.bit(0); // pulse_data_present
  w.bit(0); // tns_data_present
  w.bit(0); // gain_control_data_present
}

// 一帧 1024 采样点的数字静音。
export function silentFrame(cfg: AacConfig): Uint8Array {
  const w = new BitWriter();
  if (cfg.channels === 1) {
    silentSce(w, 0);
  } else if (cfg.channels === 2) {
    // 两个独立 SCE（左/右各一），保持比特流最简。
    silentSce(w, 0);
    silentSce(w, 1);
  } else {
    throw new Error(`不支持的声道数: ${cfg.channels}`);
  }
  w.bits(7, 3); // id_syn_ele = END
  w.alignZero();
  return w.toUint8Array();
}
