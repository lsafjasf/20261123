// 手工构造合法 H.264 Baseline 码流：SPS/PPS + 全 I_PCM 宏块的 IDR 帧。
// I_PCM 宏块直接携带原始像素，无需实现 CAVLC 变换编码，
// 生成的每一帧都是可独立解码的纯黑关键帧（Y=16, U=V=128，限幅黑）。

import { BitWriter, ebspFromRbsp } from "./bits.ts";

export interface H264Config {
  width: number; // 像素，需为 16 的倍数
  height: number; // 像素，需为 16 的倍数
}

export interface H264Bitstream {
  sps: Uint8Array; // 含 NAL 头
  pps: Uint8Array; // 含 NAL 头
  idr: Uint8Array; // 含 NAL 头，可作为完整样本
  sample: Uint8Array; // 4 字节长度前缀 + IDR，MP4 (AVCC) 样本格式
  avcC: Uint8Array; // AVCDecoderConfigurationRecord 内容
  config: H264Config;
}

function buildSps(cfg: H264Config): Uint8Array {
  const w = new BitWriter();
  w.bits(66, 8); // profile_idc = Baseline
  w.bits(0, 8); // constraint flags
  w.bits(30, 8); // level_idc = 3.0
  w.ue(0); // seq_parameter_set_id
  w.ue(0); // log2_max_frame_num_minus4 -> frame_num 占 4 bit
  w.ue(2); // pic_order_cnt_type = 2（slice 头不带 POC 字段）
  w.ue(1); // max_num_ref_frames
  w.bit(0); // gaps_in_frame_num_value_allowed_flag
  w.ue(cfg.width / 16 - 1); // pic_width_in_mbs_minus1
  w.ue(cfg.height / 16 - 1); // pic_height_in_map_units_minus1
  w.bit(1); // frame_mbs_only_flag
  w.bit(1); // direct_8x8_inference_flag
  w.bit(0); // frame_cropping_flag
  w.bit(0); // vui_parameters_present_flag
  w.rbspTrailing();
  const rbsp = w.toUint8Array();
  const out = new Uint8Array(1 + rbsp.length);
  out[0] = 0x67; // nal_ref_idc=3, type=7 (SPS)
  out.set(ebspFromRbsp(rbsp), 1);
  return out;
}

function buildPps(): Uint8Array {
  const w = new BitWriter();
  w.ue(0); // pic_parameter_set_id
  w.ue(0); // seq_parameter_set_id
  w.bit(0); // entropy_coding_mode_flag = CAVLC
  w.bit(0); // bottom_field_pic_order_in_frame_present_flag
  w.ue(0); // num_slice_groups_minus1
  w.ue(0); // num_ref_idx_l0_default_active_minus1
  w.ue(0); // num_ref_idx_l1_default_active_minus1
  w.bit(0); // weighted_pred_flag
  w.bits(0, 2); // weighted_bipred_idc
  w.se(0); // pic_init_qp_minus26
  w.se(0); // pic_init_qs_minus26
  w.se(0); // chroma_qp_index_offset
  w.bit(0); // deblocking_filter_control_present_flag
  w.bit(0); // constrained_intra_pred_flag
  w.bit(0); // redundant_pic_cnt_present_flag
  w.rbspTrailing();
  const rbsp = w.toUint8Array();
  const out = new Uint8Array(1 + rbsp.length);
  out[0] = 0x68; // type=8 (PPS)
  out.set(ebspFromRbsp(rbsp), 1);
  return out;
}

function buildIdr(cfg: H264Config): Uint8Array {
  const w = new BitWriter();
  // slice_header
  w.ue(0); // first_mb_in_slice
  w.ue(7); // slice_type = I（所有 slice 同为 I）
  w.ue(0); // pic_parameter_set_id
  w.bits(0, 4); // frame_num (log2_max_frame_num_minus4=0 -> 4 bit)
  w.ue(0); // idr_pic_id
  // pic_order_cnt_type=2 -> 无 POC 字段；IDR 无 dec_ref_pic_marking 以外字段
  w.bit(0); // no_output_of_prior_pics_flag
  w.bit(0); // long_term_reference_flag
  w.se(0); // slice_qp_delta
  const mbCount = (cfg.width / 16) * (cfg.height / 16);
  const pcm = new Uint8Array(256 + 128);
  pcm.fill(16, 0, 256); // Y = 16（限幅黑）
  pcm.fill(128, 256); // Cb = Cr = 128
  for (let mb = 0; mb < mbCount; mb++) {
    w.ue(25); // mb_type = I_PCM
    w.alignZero(); // pcm_alignment_zero_bit
    w.appendBytes(pcm); // pcm_sample_luma[256] + pcm_sample_chroma[128]
  }
  w.rbspTrailing();
  const rbsp = w.toUint8Array();
  const out = new Uint8Array(1 + rbsp.length);
  out[0] = 0x65; // nal_ref_idc=3, type=5 (IDR)
  out.set(ebspFromRbsp(rbsp), 1);
  return out;
}

function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out: number[] = [];
  out.push(1); // configurationVersion
  out.push(66, 0, 30); // profile/compat/level，与 SPS 一致
  out.push(0xff); // 6bit reserved + lengthSizeMinusOne = 3（4 字节长度）
  out.push(0xe0 | 1); // 3bit reserved + numOfSPS = 1
  out.push(sps.length >>> 8, sps.length & 0xff);
  for (const b of sps) out.push(b);
  out.push(1); // numOfPPS
  out.push(pps.length >>> 8, pps.length & 0xff);
  for (const b of pps) out.push(b);
  return Uint8Array.from(out);
}

export function makeH264(config: H264Config): H264Bitstream {
  if (config.width % 16 !== 0 || config.height % 16 !== 0) {
    throw new Error("宽高必须是 16 的倍数");
  }
  const sps = buildSps(config);
  const pps = buildPps();
  const idr = buildIdr(config);
  const sample = new Uint8Array(4 + idr.length);
  new DataView(sample.buffer).setUint32(0, idr.length, false);
  sample.set(idr, 4);
  return { sps, pps, idr, sample, avcC: buildAvcC(sps, pps), config };
}
