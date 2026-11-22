// MP4 解封装：把 moov 样本表展开成逐样本索引，供粗剪计划与重封装使用。
import { Reader, children, findChild,          } from "./boxes.js";

                         
                       
                           
               
                       
              
                            
                    
 

                        
             
                                    
                    
                                  
                                             
                                                                  
                                              
                
                 
                       
                     
                    
 

                        
                  
                            
                           
                                                             
                  
 

function findPath(buf            , box     , path          )             {
  let cur             = box;
  for (const t of path) {
    cur = cur ? findChild(buf, cur.start + cur.headerSize, cur.end, t) : null;
  }
  return cur;
}

// esds 描述符解析：取 DecoderSpecificInfo（AudioSpecificConfig）
function parseEsds(payload            )                                                 {
  const r = new Reader(payload);
  r.skip(4); // version/flags
  let objectType = 0;
  let asc                    = null;
  const readDesc = ()                               => {
    const tag = r.u8();
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = r.u8();
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, len };
  };
  const walk = (end        )       => {
    while (r.pos < end) {
      const { tag, len } = readDesc();
      const bodyEnd = r.pos + len;
      if (tag === 0x03) {
        r.skip(3); // ES_ID + flags
        walk(bodyEnd);
      } else if (tag === 0x04) {
        objectType = r.u8();
        r.skip(13); // streamType..avgBitrate
        walk(bodyEnd);
      } else if (tag === 0x05) {
        asc = r.bytes(len);
      }
      r.pos = bodyEnd;
    }
  };
  walk(r.remaining ? payload.byteLength : 0);
  return { asc, objectType };
}

function parseStsd(buf            , stbl     , kind               )                                                                                                          {
  const stsd = findChild(buf, stbl.start + stbl.headerSize, stbl.end, "stsd");
  if (!stsd) throw new Error("missing stsd");
  const r = new Reader(buf, stsd.start + stsd.headerSize, stsd.size - stsd.headerSize);
  r.skip(4); // version/flags
  const count = r.u32();
  if (count < 1) throw new Error("empty stsd");
  const entryStart = r.abs();
  const entrySize = r.u32();
  const fmt = r.str(4);
  const stsdEntry = buf.slice(entryStart, entryStart + entrySize);
  let codec = fmt, description                    = null;
  let width = 0, height = 0, channelCount = 0, sampleRate = 0;
  if (fmt === "avc1" || fmt === "avc3" || fmt === "hev1" || fmt === "hvc1") {
    r.skip(6 + 2 + 16);
    width = r.u16(); height = r.u16();
    r.skip(4 + 4 + 4 + 2 + 32 + 2 + 2); // 到子 box 区
    const childStart = r.abs();
    const avcC = findChild(buf, childStart, entryStart + entrySize, fmt.startsWith("avc") ? "avcC" : "hvcC");
    if (avcC) {
      description = buf.slice(avcC.start + 8, avcC.end);
      if (fmt.startsWith("avc") && description.byteLength >= 4) {
        const hex = (n        )         => n.toString(16).padStart(2, "0");
        codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
      }
    }
  } else if (fmt === "mp4a") {
    r.skip(6 + 2 + 8);
    channelCount = r.u16();
    r.skip(2 + 2 + 2); // samplesize + pre_defined + reserved
    sampleRate = r.u32() >>> 16;
    const childStart = r.abs();
    const esds = findChild(buf, childStart, entryStart + entrySize, "esds");
    if (esds) {
      const { asc, objectType } = parseEsds(buf.slice(esds.start + 8, esds.end));
      description = asc;
      const aot = asc && asc.byteLength > 0 ? asc[0] >> 3 : 2;
      codec = `mp4a.${objectType.toString(16)}.${aot}`;
    }
  }
  return { codec, description, stsdEntry, width, height, channelCount, sampleRate };
}

function tableU32(buf            , stbl     , type        )           {
  const b = findChild(buf, stbl.start + stbl.headerSize, stbl.end, type);
  if (!b) return [];
  const r = new Reader(buf, b.start + b.headerSize, b.size - b.headerSize);
  r.skip(4);
  const n = r.u32();
  const out           = [];
  for (let i = 0; i < n; i++) out.push(r.u32());
  return out;
}

function buildSamples(buf            , stbl     )           {
  // stts: [count, delta] 对
  const sttsBox = findChild(buf, stbl.start + stbl.headerSize, stbl.end, "stts");
  if (!sttsBox) return [];
  const sttsR = new Reader(buf, sttsBox.start + sttsBox.headerSize, sttsBox.size - sttsBox.headerSize);
  sttsR.skip(4);
  const sttsN = sttsR.u32();
  const stts                          = [];
  for (let i = 0; i < sttsN; i++) stts.push([sttsR.u32(), sttsR.u32()]);

  const cttsBox = findChild(buf, stbl.start + stbl.headerSize, stbl.end, "ctts");
  const ctts                          = [];
  if (cttsBox) {
    const r = new Reader(buf, cttsBox.start + cttsBox.headerSize, cttsBox.size - cttsBox.headerSize);
    const version = r.u8();
    r.skip(3);
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const cnt = r.u32();
      const off = version === 1 ? r.i32() : r.u32();
      ctts.push([cnt, off]);
    }
  }

  const keySet = new Set        ();
  const stss = tableU32(buf, stbl, "stss");
  for (const s of stss) keySet.add(s - 1); // 1-based -> 0-based
  const allKey = stss.length === 0; // 无 stss 视为全关键帧（常见于音频）

  const sizesBox = findChild(buf, stbl.start + stbl.headerSize, stbl.end, "stsz");
  if (!sizesBox) return [];
  const szR = new Reader(buf, sizesBox.start + sizesBox.headerSize, sizesBox.size - sizesBox.headerSize);
  szR.skip(4);
  const uniform = szR.u32();
  const count = szR.u32();
  const sizes           = [];
  for (let i = 0; i < count; i++) sizes.push(uniform || szR.u32());

  // stsc + stco/co64 -> 每样本文件偏移
  const stscBox = findChild(buf, stbl.start + stbl.headerSize, stbl.end, "stsc");
  const stsc                                  = [];
  if (stscBox) {
    const r = new Reader(buf, stscBox.start + stscBox.headerSize, stscBox.size - stscBox.headerSize);
    r.skip(4);
    const n = r.u32();
    for (let i = 0; i < n; i++) stsc.push([r.u32(), r.u32(), r.u32()]);
  }
  const co64 = findChild(buf, stbl.start + stbl.headerSize, stbl.end, "co64");
  const chunkOffsets           = [];
  if (co64) {
    const r = new Reader(buf, co64.start + co64.headerSize, co64.size - co64.headerSize);
    r.skip(4);
    const n = r.u32();
    for (let i = 0; i < n; i++) chunkOffsets.push(r.u64());
  } else {
    for (const v of tableU32(buf, stbl, "stco")) chunkOffsets.push(v);
  }

  const offsets = new Array        (count);
  let sampleIdx = 0;
  for (let c = 0; c < chunkOffsets.length && sampleIdx < count; c++) {
    const chunkNo = c + 1;
    let spc = 0;
    for (let i = 0; i < stsc.length; i++) {
      const next = i + 1 < stsc.length ? stsc[i + 1][0] : Infinity;
      if (chunkNo >= stsc[i][0] && chunkNo < next) { spc = stsc[i][1]; break; }
    }
    let off = chunkOffsets[c];
    for (let s = 0; s < spc && sampleIdx < count; s++, sampleIdx++) {
      offsets[sampleIdx] = off;
      off += sizes[sampleIdx];
    }
  }

  const samples           = new Array(count);
  let dts = 0, ti = 0, tLeft = stts.length ? stts[0][0] : 0;
  let ci = 0, cLeft = ctts.length ? ctts[0][0] : 0;
  for (let i = 0; i < count; i++) {
    const dur = stts.length ? stts[ti][1] : 0;
    const coff = ctts.length ? ctts[ci][1] : 0;
    samples[i] = {
      index: i,
      offset: offsets[i],
      size: sizes[i],
      dts,
      cts: dts + coff,
      duration: dur,
      keyframe: allKey || keySet.has(i),
    };
    dts += dur;
    if (--tLeft <= 0 && ++ti < stts.length) tLeft = stts[ti][0];
    if (ctts.length && --cLeft <= 0 && ++ci < ctts.length) cLeft = ctts[ci][0];
  }
  return samples;
}

export function demux(buf            )        {
  let moov             = null;
  const brands = { major: "", minor: 0, compat: []             };
  for (const b of children(buf, 0, buf.byteLength)) {
    if (b.type === "moov") moov = b;
    else if (b.type === "ftyp") {
      const r = new Reader(buf, b.start + b.headerSize, b.size - b.headerSize);
      brands.major = r.str(4);
      brands.minor = r.u32();
      while (r.remaining >= 4) brands.compat.push(r.str(4));
    }
  }
  if (!moov) throw new Error("不是有效的 MP4（缺少 moov）");
  const mvhdBox = findChild(buf, moov.start + moov.headerSize, moov.end, "mvhd");
  if (!mvhdBox) throw new Error("缺少 mvhd");
  const mr = new Reader(buf, mvhdBox.start + mvhdBox.headerSize, mvhdBox.size - mvhdBox.headerSize);
  const mv = mr.u8();
  mr.skip(3);
  if (mv === 1) { mr.skip(16); } else { mr.skip(8); }
  const timescale = mr.u32();
  const duration = mv === 1 ? mr.u64() : mr.u32();

  const tracks          = [];
  for (const trak of children(buf, moov.start + moov.headerSize, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = findPath(buf, trak, ["tkhd"]);
    const mdhd = findPath(buf, trak, ["mdia", "mdhd"]);
    const hdlr = findPath(buf, trak, ["mdia", "hdlr"]);
    const stbl = findPath(buf, trak, ["mdia", "minf", "stbl"]);
    if (!tkhd || !mdhd || !hdlr || !stbl) continue;
    const hr = new Reader(buf, hdlr.start + hdlr.headerSize, hdlr.size - hdlr.headerSize);
    hr.skip(8);
    const handler = hr.str(4);
    const kind                = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";

    const tr = new Reader(buf, tkhd.start + tkhd.headerSize, tkhd.size - tkhd.headerSize);
    const tv = tr.u8();
    tr.skip(3);
    if (tv === 1) { tr.skip(8 + 8); } else { tr.skip(4 + 4); }
    const trackId = tr.u32();

    const dr = new Reader(buf, mdhd.start + mdhd.headerSize, mdhd.size - mdhd.headerSize);
    const dv = dr.u8();
    dr.skip(3);
    if (dv === 1) { dr.skip(8 + 8); } else { dr.skip(4 + 4); }
    const ts = dr.u32();
    const dur = dv === 1 ? dr.u64() : dr.u32();

    const stsd = parseStsd(buf, stbl, kind);
    tracks.push({
      id: trackId,
      kind,
      timescale: ts,
      duration: dur,
      ...stsd,
      samples: kind === "other" ? [] : buildSamples(buf, stbl),
    });
  }
  return { buf, timescale, duration, brands, tracks };
}

export function sampleData(movie       , s        )             {
  return movie.buf.subarray(s.offset, s.offset + s.size);
}
