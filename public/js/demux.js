// 容器解析：WAV 头、MP3 帧、MP4(m4a) 样本表。只用标准 DataView/File.slice。

                          
                     
                   
                   
                     
                        
                       
 

export async function parseWav(file      )                   {
  const head = new DataView(await file.slice(0, 64 * 1024).arrayBuffer());
  if (head.getUint32(0, false) !== 0x52494646) throw new Error('不是 RIFF/WAV 文件');
  let pos = 12;
  let fmt                 = null;
  while (pos + 8 <= head.byteLength) {
    const id = head.getUint32(pos, false);
    const size = head.getUint32(pos + 4, true);
    if (id === 0x666d7420) { // 'fmt '
      const format = head.getUint16(pos + 8, true);
      fmt = {
        dataOffset: 0, dataSize: 0,
        channels: head.getUint16(pos + 10, true),
        sampleRate: head.getUint32(pos + 12, true),
        bitsPerSample: head.getUint16(pos + 22, true),
        floatFormat: format === 3,
      };
      if (format !== 1 && format !== 3 && format !== 0xfffe) {
        throw new Error(`不支持的 WAV 编码格式 (${format})，仅支持 PCM`);
      }
    } else if (id === 0x64617461 && fmt) { // 'data'
      fmt.dataOffset = pos + 8;
      fmt.dataSize = Math.min(size, file.size - fmt.dataOffset);
      return fmt;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('WAV 中未找到 data 块');
}

// ---------------- MP3 ----------------

const MP3_BITRATES                           = {
  // MPEG1 LayerIII / MPEG2&2.5 LayerIII
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MP3_RATES                           = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

                                                                 

// 顺序扫描 MP3 帧，每次产出一批帧（供 AudioDecoder 解码）。
export async function* mp3Frames(
  file      , batchFrames = 64,
)                                                      {
  const buf = new Uint8Array(await file.arrayBuffer());
  let pos = 0;
  // 跳过 ID3v2
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14)
      | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + sz;
  }
  let batch               = [];
  let batchLen = 0;
  let info                 = null;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) { pos++; continue; }
    const ver = (buf[pos + 1] >> 3) & 3;       // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const layer = (buf[pos + 1] >> 1) & 3;     // 1=LayerIII
    const brIdx = (buf[pos + 2] >> 4) & 15;
    const srIdx = (buf[pos + 2] >> 2) & 3;
    const pad = (buf[pos + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      pos++; continue;
    }
    const bitrate = (ver === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[brIdx] * 1000;
    const sampleRate = MP3_RATES[ver][srIdx];
    const coef = ver === 3 ? 144 : 72;
    const frameLen = Math.floor((coef * bitrate) / sampleRate) + pad;
    if (frameLen <= 4 || pos + frameLen > buf.length) { pos++; continue; }
    const channels = ((buf[pos + 3] >> 6) & 3) === 3 ? 1 : 2;
    info = { sampleRate, channels };
    batch.push(buf.subarray(pos, pos + frameLen));
    batchLen += frameLen;
    pos += frameLen;
    if (batch.length >= batchFrames) {
      const merged = new Uint8Array(batchLen);
      let o = 0;
      for (const b of batch) { merged.set(b, o); o += b.length; }
      yield { data: merged, info };
      batch = []; batchLen = 0;
    }
  }
  if (batch.length && info) {
    const merged = new Uint8Array(batchLen);
    let o = 0;
    for (const b of batch) { merged.set(b, o); o += b.length; }
    yield { data: merged, info };
  }
}

// ---------------- MP4 / M4A ----------------

                           
                
                                                        
                     
                   
                                        
                                     
 

function boxType(b            , p        )         {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}

function findBox(b            , start        , end        , type        )         {
  let p = start;
  while (p + 8 <= end) {
    const dv = new DataView(b.buffer, b.byteOffset + p);
    let size = dv.getUint32(0, false);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8, false)); hdr = 16; }
    if (size === 0) size = end - p;
    if (boxType(b, p + 4) === type) return p;
    p += size;
  }
  return -1;
}

function boxPayload(b            , p        )                                 {
  const dv = new DataView(b.buffer, b.byteOffset + p);
  let size = dv.getUint32(0, false);
  let hdr = 8;
  if (size === 1) { size = Number(dv.getBigUint64(8, false)); hdr = 16; }
  if (size === 0) size = b.length - p;
  return { start: p + hdr, end: p + size };
}

// 在 esds 描述符里找 DecoderSpecificInfo(tag 0x05) 即 AudioSpecificConfig
function findAsc(b            , start        , end        )                    {
  let p = start;
  while (p + 2 <= end) {
    const tag = b[p];
    p++;
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const c = b[p++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    if (tag === 0x05) return b.subarray(p, p + len);
    // 0x03 ES_Descr / 0x04 DecoderConfig 有少量前置字节后嵌套子描述符
    if (tag === 0x03) {
      const sub = findAsc(b, p + 3, p + len);
      if (sub) return sub;
    }
    if (tag === 0x04) {
      const sub = findAsc(b, p + 13, p + len);
      if (sub) return sub;
    }
    p += len;
  }
  return null;
}

export async function parseMp4(file      )                    {
  // 读 moov 盒（通常几 MB 内）
  const headSize = Math.min(file.size, 64 * 1024 * 1024);
  const buf = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
  const moovPos = findBox(buf, 0, buf.length, 'moov');
  if (moovPos < 0) throw new Error('MP4 中未找到 moov 盒（可能是不支持的流式封装）');
  const moov = boxPayload(buf, moovPos);

  // 找音频 trak
  let trakPos = moov.start;
  let stbl = -1;
  while ((trakPos = findBox(buf, trakPos, moov.end, 'trak')) >= 0) {
    const trak = boxPayload(buf, trakPos);
    const mdia = findBox(buf, trak.start, trak.end, 'mdia');
    if (mdia < 0) { trakPos = trak.end; continue; }
    const mdiaP = boxPayload(buf, mdia);
    const hdlr = findBox(buf, mdiaP.start, mdiaP.end, 'hdlr');
    if (hdlr >= 0) {
      const hp = boxPayload(buf, hdlr);
      if (boxType(buf, hp.start + 8) !== 'soun') { trakPos = trak.end; continue; }
    }
    const minf = findBox(buf, mdiaP.start, mdiaP.end, 'minf');
    if (minf < 0) { trakPos = trak.end; continue; }
    const minfP = boxPayload(buf, minf);
    stbl = findBox(buf, minfP.start, minfP.end, 'stbl');
    if (stbl >= 0) break;
    trakPos = trak.end;
  }
  if (stbl < 0) throw new Error('MP4 中未找到音频轨');
  const st = boxPayload(buf, stbl);
  const dv = new DataView(buf.buffer, buf.byteOffset);

  // stsd -> mp4a 入口 -> esds
  const stsd = findBox(buf, st.start, st.end, 'stsd');
  if (stsd < 0) throw new Error('缺少 stsd');
  const stsdP = boxPayload(buf, stsd);
  const entry = stsdP.start + 8; // version/flags + count
  const codec4 = boxType(buf, entry + 4);
  const channels = dv.getUint16(entry + 24, false);
  const sampleRate = dv.getUint32(entry + 32, false) >>> 16;
  let description                    = null;
  const esds = findBox(buf, entry + 36, stsdP.end, 'esds');
  if (esds >= 0) {
    const ep = boxPayload(buf, esds);
    description = findAsc(buf, ep.start + 4, ep.end);
  }

  // stsz: 样本尺寸表
  const stsz = findBox(buf, st.start, st.end, 'stsz');
  if (stsz < 0) throw new Error('缺少 stsz');
  const stszP = boxPayload(buf, stsz);
  const defaultSize = dv.getUint32(stszP.start + 4, false);
  const sampleCount = dv.getUint32(stszP.start + 8, false);
  const sizes = new Uint32Array(sampleCount);
  if (defaultSize === 0) {
    for (let i = 0; i < sampleCount; i++) {
      sizes[i] = dv.getUint32(stszP.start + 12 + i * 4, false);
    }
  } else sizes.fill(defaultSize);

  // stco / co64: chunk 偏移
  let chunkOffsets              ;
  const stco = findBox(buf, st.start, st.end, 'stco');
  const co64 = findBox(buf, st.start, st.end, 'co64');
  if (co64 >= 0) {
    const p = boxPayload(buf, co64);
    const n = dv.getUint32(p.start + 4, false);
    chunkOffsets = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      chunkOffsets[i] = Number(dv.getBigUint64(p.start + 8 + i * 8, false));
    }
  } else if (stco >= 0) {
    const p = boxPayload(buf, stco);
    const n = dv.getUint32(p.start + 4, false);
    chunkOffsets = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      chunkOffsets[i] = dv.getUint32(p.start + 8 + i * 4, false);
    }
  } else throw new Error('缺少 stco/co64');

  // stsc: chunk -> 每 chunk 样本数
  const stsc = findBox(buf, st.start, st.end, 'stsc');
  if (stsc < 0) throw new Error('缺少 stsc');
  const stscP = boxPayload(buf, stsc);
  const stscCount = dv.getUint32(stscP.start + 4, false);
  const firstChunk           = [];
  const perChunk           = [];
  for (let i = 0; i < stscCount; i++) {
    firstChunk.push(dv.getUint32(stscP.start + 8 + i * 12, false));
    perChunk.push(dv.getUint32(stscP.start + 8 + i * 12 + 4, false));
  }

  // 展开为逐样本偏移
  const offsets = new Float64Array(sampleCount);
  let sample = 0;
  let entry2 = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length && sample < sampleCount; chunk++) {
    while (entry2 + 1 < stscCount && firstChunk[entry2 + 1] <= chunk) entry2++;
    let off = chunkOffsets[chunk - 1];
    for (let k = 0; k < perChunk[entry2] && sample < sampleCount; k++) {
      offsets[sample] = off;
      off += sizes[sample];
      sample++;
    }
  }

  const codec = codec4 === 'mp4a'
    ? `mp4a.40.${description && description.length ? description[0] >> 3 : 2}`
    : codec4;
  return { codec, description, sampleRate, channels, offsets, sizes };
}
