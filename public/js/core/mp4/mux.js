// MP4 重封装：把保留段（无损样本或转码样本）拼接写成新 MP4。
// 单 chunk/轨道 + co64，两遍构建：先算 moov 尺寸，再回填样本偏移。
import { Writer, box, fullBox } from "./boxes.js";

                            
                   
                            
                                 
                    
                                                 
 

                           
                          
                    
                                                        
                
                 
                       
                                                                    
 

                           
                     
                       
                         
                         
                     
 

const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

// 为转码段构造 avc1 sample entry（description 为编码器输出的 avcC 记录）
export function buildAvc1Entry(width        , height        , avcC            )             {
  const w = new Writer();
  w.u32(0).u16(0); // 6 字节 reserved
  w.u16(1); // data_reference_index
  w.u32(0).u32(0).u32(0).u32(0); // pre_defined/reserved
  w.u16(width).u16(height);
  w.u32(0x00480000).u32(0x00480000); // 72dpi
  w.u32(0);
  w.u16(1);
  for (let i = 0; i < 32; i++) w.u8(0); // compressorname
  w.u16(0x0018).u16(0xffff);
  const entry = w.concat();
  return box("avc1", entry, box("avcC", avcC));
}

function rle(values          )                          {
  const out                          = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

// 按 desc 连续段切 chunk（同一 chunk 只能引用一个 sample description）
function chunkRuns(t          )                                                        {
  const runs                                                        = [];
  for (let i = 0; i < t.samples.length; i++) {
    const d = t.samples[i].desc;
    const last = runs[runs.length - 1];
    if (last && last.desc === d) last.count++;
    else runs.push({ start: i, count: 1, desc: d });
  }
  return runs;
}

function stbl(t          , chunkOffsets          )             {
  // stsd
  const stsdW = new Writer();
  stsdW.u32(0).u32(t.stsdEntries.length);
  for (const e of t.stsdEntries) stsdW.bytes(e);
  const stsd = box("stsd", stsdW.concat());
  // stts
  const sttsW = new Writer();
  const dts = rle(t.samples.map((s) => s.duration));
  sttsW.u32(dts.length);
  for (const [c, d] of dts) sttsW.u32(c).u32(d);
  const stts = fullBox("stts", 0, 0, sttsW.concat());
  // ctts（有非零偏移才写；存在负偏移用 version 1）
  let ctts                    = null;
  const offs = t.samples.map((s) => s.ctsOffset);
  if (offs.some((o) => o !== 0)) {
    const version = offs.some((o) => o < 0) ? 1 : 0;
    const w = new Writer();
    const runs = rle(offs);
    w.u32(runs.length);
    for (const [c, o] of runs) w.u32(c).i32(o);
    ctts = fullBox("ctts", version, 0, w.concat());
  }
  // stss（全关键帧则省略）
  let stss                    = null;
  const keys = t.samples.map((s, i) => (s.keyframe ? i + 1 : 0)).filter((n) => n > 0);
  if (keys.length < t.samples.length) {
    const w = new Writer();
    w.u32(keys.length);
    for (const k of keys) w.u32(k);
    stss = fullBox("stss", 0, 0, w.concat());
  }
  // stsc：每个 desc-run 一个 chunk
  const runs = chunkRuns(t);
  const stscW = new Writer();
  stscW.u32(runs.length);
  runs.forEach((r, i) => stscW.u32(i + 1).u32(r.count).u32(r.desc + 1));
  const stsc = fullBox("stsc", 0, 0, stscW.concat());
  // stsz
  const stszW = new Writer();
  stszW.u32(0).u32(t.samples.length);
  for (const s of t.samples) stszW.u32(s.data.byteLength);
  const stsz = fullBox("stsz", 0, 0, stszW.concat());
  // co64：每 chunk 一个偏移
  const coW = new Writer();
  coW.u32(chunkOffsets.length);
  for (const o of chunkOffsets) coW.u64(o);
  const co64 = fullBox("co64", 0, 0, coW.concat());
  return box("stbl", stsd, stts, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []), stsc, stsz, co64);
}

function trak(t          , trackId        , movieTimescale        , chunkOffsets          )             {
  const trackDur = t.samples.reduce((a, s) => a + s.duration, 0);
  const movieDur = Math.round((trackDur * movieTimescale) / t.timescale);
  // tkhd
  const tk = new Writer();
  tk.u32(0).u32(0).u32(trackId).u32(0).u32(movieDur);
  tk.u32(0).u32(0);
  tk.u16(0).u16(0).u16(t.kind === "audio" ? 0x0100 : 0).u16(0);
  for (const m of UNITY_MATRIX) tk.u32(m);
  tk.u32(t.width << 16).u32(t.height << 16);
  const tkhd = fullBox("tkhd", 0, 0x000003, tk.concat());
  // mdhd
  const md = new Writer();
  md.u32(0).u32(0).u32(t.timescale).u32(trackDur).u16(0x55c4).u16(0);
  const mdhd = fullBox("mdhd", 0, 0, md.concat());
  // hdlr
  const hd = new Writer();
  hd.u32(0).str(t.kind === "video" ? "vide" : "soun").u32(0).u32(0).u32(0);
  hd.str(t.kind === "video" ? "VideoHandler\0" : "SoundHandler\0");
  const hdlr = fullBox("hdlr", 0, 0, hd.concat());
  // minf
  const mediaHeader =
    t.kind === "video"
      ? fullBox("vmhd", 0, 1, new Writer().u16(0).u16(0).u16(0).u16(0).concat())
      : fullBox("smhd", 0, 0, new Writer().u16(0).u16(0).concat());
  const url = fullBox("url ", 0, 1, new Uint8Array(0));
  const drefW = new Writer();
  drefW.u32(1).bytes(url);
  const dinf = box("dinf", fullBox("dref", 0, 0, drefW.concat()));
  const minf = box("minf", mediaHeader, dinf, stbl(t, chunkOffsets));
  const mdia = box("mdia", mdhd, hdlr, minf);
  // elst：仅当需要平移展示起点（音频 priming / 视频首帧 cts > 0）
  let edts                    = null;
  if (t.mediaTimeOffset !== 0) {
    const e = new Writer();
    e.u32(1).u32(movieDur).i32(t.mediaTimeOffset).u16(1).u16(0);
    edts = box("edts", fullBox("elst", 0, 0, e.concat()));
  }
  return box("trak", tkhd, ...(edts ? [edts] : []), mdia);
}

export function mux(input          )             {
  const movieTs = input.movieTimescale;
  // ftyp
  const fw = new Writer();
  fw.str(input.majorBrand).u32(input.minorVersion);
  const compat = new Set(input.compatBrands);
  compat.add("isom");
  for (const b of compat) fw.str(b);
  const ftyp = box("ftyp", fw.concat());

  // mdat 头尺寸（payload 超 4GB 时用 64 位 largesize）
  const payloadSize = input.tracks.reduce(
    (a, t) => a + t.samples.reduce((x, s) => x + s.data.byteLength, 0),
    0,
  );
  const mdatHeader = payloadSize + 8 >= 0xffffffff ? 16 : 8;

  const buildMoov = (offsets            )             => {
    const traks = input.tracks.map((t, i) => trak(t, i + 1, movieTs, offsets[i]));
    const mv = new Writer();
    mv.u32(0).u32(0).u32(movieTs);
    const movieDur = Math.max(
      ...input.tracks.map((t) =>
        Math.round((t.samples.reduce((a, s) => a + s.duration, 0) * movieTs) / t.timescale),
      ),
      0,
    );
    mv.u32(movieDur);
    mv.u32(0x00010000).u16(0x0100).u16(0).u32(0).u32(0);
    for (const m of UNITY_MATRIX) mv.u32(m);
    for (let i = 0; i < 6; i++) mv.u32(0);
    mv.u32(input.tracks.length + 1);
    return box("moov", fullBox("mvhd", 0, 0, mv.concat()), ...traks);
  };

  // 第一遍：占位偏移求 moov 尺寸（chunk 数与 desc-run 数一致，尺寸稳定）
  let moov = buildMoov(input.tracks.map((t) => chunkRuns(t).map(() => 0)));
  const dataStart = ftyp.byteLength + moov.byteLength + mdatHeader;
  const offsets             = [];
  let cur = dataStart;
  for (const t of input.tracks) {
    const trackOffsets           = [];
    for (const run of chunkRuns(t)) {
      trackOffsets.push(cur);
      for (let i = run.start; i < run.start + run.count; i++) cur += t.samples[i].data.byteLength;
    }
    offsets.push(trackOffsets);
  }
  // 第二遍：真实偏移（尺寸不变）
  moov = buildMoov(offsets);

  const mw = new Writer();
  if (mdatHeader === 16) mw.u32(1).str("mdat").u64(payloadSize + 16);
  else mw.u32(payloadSize + 8).str("mdat");
  const mdatHead = mw.concat();

  const out = new Writer();
  out.bytes(ftyp).bytes(moov).bytes(mdatHead);
  for (const t of input.tracks) for (const s of t.samples) out.bytes(s.data);
  return out.concat();
}
