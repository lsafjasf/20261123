                                                                         

               
               
                
                  
              
 

                        

function viewOf(data       )           {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function u16(data       , offset        )         {
  return viewOf(data).getUint16(offset, false);
}

function u32(data       , offset        )         {
  return viewOf(data).getUint32(offset, false);
}

function i32(data       , offset        )         {
  return viewOf(data).getInt32(offset, false);
}

function u64(data       , offset        )         {
  return Number(viewOf(data).getBigUint64(offset, false));
}

function ascii(data       , offset        , length        )         {
  let value = "";
  for (let i = offset; i < Math.min(offset + length, data.length); i++) value += String.fromCharCode(data[i]);
  return value;
}

function boxes(data       , start        , end        )        {
  const result        = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = u32(data, cursor);
    const type = ascii(data, cursor + 4, 4);
    let header = 8;
    if (size === 1 && cursor + 16 <= end) {
      size = u64(data, cursor + 8);
      header = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < header || cursor + size > end) break;
    result.push({ type, start: cursor, payload: cursor + header, end: cursor + size });
    cursor += size;
  }
  return result;
}

function child(data       , parent            , type        )             {
  if (!parent) return null;
  return boxes(data, parent.payload, parent.end).find((box) => box.type === type) || null;
}

function descendants(data       , parent     , type        )        {
  const found        = [];
  for (const box of boxes(data, parent.payload, parent.end)) {
    if (box.type === type) found.push(box);
    if (["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "meta", "ilst"].includes(box.type)) {
      const offset = box.type === "meta" ? 4 : 0;
      const nested      = { ...box, payload: box.payload + offset };
      found.push(...descendants(data, nested, type));
    }
  }
  return found;
}

function parseMvhdTimescale(data       , box     )         {
  return data[box.payload] === 1 ? u32(data, box.payload + 20) : u32(data, box.payload + 12);
}

function parseMdhd(data       , box     )                                          {
  if (data[box.payload] === 1) {
    return { timescale: u32(data, box.payload + 20), duration: u64(data, box.payload + 24) };
  }
  return { timescale: u32(data, box.payload + 12), duration: u32(data, box.payload + 16) };
}

function parseStts(data       , box     )                                          {
  const count = u32(data, box.payload + 4);
  const entries                                          = [];
  for (let i = 0; i < count; i++) {
    const at = box.payload + 8 + i * 8;
    if (at + 8 > box.end) break;
    entries.push({ count: u32(data, at), delta: u32(data, at + 4) });
  }
  return entries;
}

function parseStsz(data       , box     )           {
  const uniform = u32(data, box.payload + 4);
  const count = u32(data, box.payload + 8);
  if (uniform > 0) return Array.from({ length: count }, () => uniform);
  const sizes           = [];
  for (let i = 0; i < count; i++) {
    const at = box.payload + 12 + i * 4;
    if (at + 4 > box.end) break;
    sizes.push(u32(data, at));
  }
  return sizes;
}

function parseStsc(data       , box     )                                                  {
  const count = u32(data, box.payload + 4);
  const entries                                                  = [];
  for (let i = 0; i < count; i++) {
    const at = box.payload + 8 + i * 12;
    if (at + 12 > box.end) break;
    entries.push({ firstChunk: u32(data, at), perChunk: u32(data, at + 4) });
  }
  return entries;
}

function parseChunkOffsets(data       , box            )           {
  if (!box) return [];
  const count = u32(data, box.payload + 4);
  const offsets           = [];
  for (let i = 0; i < count; i++) {
    const at = box.payload + 8 + i * (box.type === "co64" ? 8 : 4);
    if (at + (box.type === "co64" ? 8 : 4) > box.end) break;
    offsets.push(box.type === "co64" ? u64(data, at) : u32(data, at));
  }
  return offsets;
}

function parseEdit(data       , box            )                   {
  if (!box) return null;
  const version = data[box.payload];
  const count = u32(data, box.payload + 4);
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      const at = box.payload + 8 + i * 20;
      if (at + 20 > box.end) break;
      const entry = { segmentDuration: u64(data, at), mediaTime: Number(viewOf(data).getBigInt64(at + 8, false)), mediaRate: i32(data, at + 16) };
      if (entry.segmentDuration > 0 && entry.mediaTime >= 0) return entry;
    } else {
      const at = box.payload + 8 + i * 12;
      if (at + 12 > box.end) break;
      const entry = { segmentDuration: u32(data, at), mediaTime: i32(data, at + 4), mediaRate: i32(data, at + 8) };
      if (entry.segmentDuration > 0 && entry.mediaTime >= 0) return entry;
    }
  }
  return null;
}

function readDescriptorLength(data       , offset        , end        )                                          {
  let length = 0;
  let cursor = offset;
  for (let i = 0; i < 4 && cursor < end; i++) {
    const byte = data[cursor++];
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return { length, next: cursor };
  }
  return null;
}

function findDecoderSpecific(data       , start        , end        , depth = 0)                    {
  if (depth > 8) return null;
  let cursor = start;
  while (cursor + 2 <= end) {
    const tag = data[cursor++];
    const parsed = readDescriptorLength(data, cursor, end);
    if (!parsed || parsed.length < 0) return null;
    cursor = parsed.next;
    const contentEnd = Math.min(end, cursor + parsed.length);
    if (tag === 0x05) return data.slice(cursor, contentEnd);
    if (tag === 0x03 && cursor + 3 <= contentEnd) {
      const flags = data[cursor + 2];
      let childStart = cursor + 3;
      if (flags & 0x80) childStart += 2;
      if (flags & 0x40) childStart += 1 + (data[childStart] || 0);
      if (flags & 0x20) childStart += 2;
      const found = findDecoderSpecific(data, childStart, contentEnd, depth + 1);
      if (found) return found;
    } else if (tag === 0x04 && cursor + 13 <= contentEnd) {
      const found = findDecoderSpecific(data, cursor + 13, contentEnd, depth + 1);
      if (found) return found;
    }
    cursor = contentEnd;
  }
  return null;
}

function audioSpecificConfig(data       , sampleRate        , channels        )             {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const rateIndex = Math.max(0, rates.indexOf(sampleRate));
  const objectType = 2;
  const value = (objectType << 11) | (rateIndex << 7) | (channels << 3);
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function sampleEntry(data       , stsd            ) {
  if (!stsd) return null;
  const entryStart = stsd.payload + 8;
  if (entryStart + 8 > stsd.end) return null;
  const entryEnd = Math.min(stsd.end, entryStart + u32(data, entryStart));
  const type = ascii(data, entryStart + 4, 4);
  const payload = entryStart + 8;
  const version = u16(data, payload + 8);
  const channels = u16(data, payload + 16);
  const sampleRate = u32(data, payload + 24) >>> 16;
  const childStart = payload + (version === 1 ? 44 : version === 2 ? 64 : 28);
  const children = boxes(data, childStart, entryEnd);
  const esds = children.find((box) => box.type === "esds") || null;
  let description                    = null;
  if (esds) {
    description = findDecoderSpecific(data, esds.payload + 4, esds.end);
  }
  return {
    type,
    channels,
    sampleRate,
    description: description || audioSpecificConfig(data, sampleRate, channels)
  };
}

function parseITunSmpb(data       )                                                                {
  const text = ascii(data, 0, data.length);
  const index = text.indexOf("iTunSMPB");
  if (index < 0) return null;
  const printable = text.slice(index, index + 320).replace(/[^\x20-\x7e]/g, " ");
  const match = printable.match(/([0-9a-fA-F]{8})\s+([0-9a-fA-F]{8})\s+([0-9a-fA-F]{8})\s+([0-9a-fA-F]{8})/);
  if (!match) return null;
  return {
    priming: parseInt(match[2], 16),
    padding: parseInt(match[3], 16),
    original: parseInt(match[4], 16)
  };
}

export function parseMp4Audio(data       )               {
  const root = boxes(data, 0, data.length);
  const moov = root.find((box) => box.type === "moov") || null;
  if (!moov) throw new Error("No moov box in MP4");
  const mvhd = child(data, moov, "mvhd");
  const movieTimescale = mvhd ? parseMvhdTimescale(data, mvhd) : 1000;
  const warnings           = [];
  let track             = null;
  let mediaTimescale = 0;
  let mediaDuration = 0;
  let edit                   = null;
  let stbl             = null;

  for (const trak of boxes(data, moov.payload, moov.end).filter((box) => box.type === "trak")) {
    const mdia = child(data, trak, "mdia");
    const hdlr = child(data, mdia, "hdlr");
    if (!hdlr || ascii(data, hdlr.payload + 8, 4) !== "soun") continue;
    track = trak;
    const mdhd = child(data, mdia, "mdhd");
    if (mdhd) {
      const timing = parseMdhd(data, mdhd);
      mediaTimescale = timing.timescale;
      mediaDuration = timing.duration;
    }
    edit = parseEdit(data, child(data, child(data, trak, "edts"), "elst"));
    stbl = child(data, child(data, mdia, "minf"), "stbl");
    break;
  }
  if (!track || !stbl) throw new Error("No audio track in MP4");

  const stsd = child(data, stbl, "stsd");
  const entry = sampleEntry(data, stsd);
  if (!entry) throw new Error("No audio sample entry");
  if (!mediaTimescale) throw new Error("No media timescale");
  if (!entry.sampleRate) throw new Error("No sample rate");
  if (!entry.channels) throw new Error("No channel count");

  const stts = parseStts(data, child(data, stbl, "stts")       );
  const sizes = parseStsz(data, child(data, stbl, "stsz")       );
  const chunkOffsets = parseChunkOffsets(data, child(data, stbl, "stco") || child(data, stbl, "co64"));
  const stsc = parseStsc(data, child(data, stbl, "stsc")       );
  if (chunkOffsets.length === 0) throw new Error("No chunk offsets");
  if (stsc.length === 0) throw new Error("No sample-to-chunk table");

  const timings                                          = [];
  for (const entryTime of stts) {
    for (let i = 0; i < entryTime.count; i++) timings.push({ count: 1, delta: entryTime.delta });
  }
  if (timings.length !== sizes.length) {
    warnings.push(`sample table count differs: ${timings.length} timings / ${sizes.length} sizes`);
  }

  const packets                  = [];
  let sampleIndex = 0;
  let cursorSample = 0;
  let stscIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex++) {
    while (stscIndex + 1 < stsc.length && stsc[stscIndex + 1].firstChunk <= chunkIndex + 1) stscIndex++;
    const perChunk = stsc[stscIndex].perChunk;
    let offset = chunkOffsets[chunkIndex];
    for (let inChunk = 0; inChunk < perChunk && sampleIndex < sizes.length; inChunk++) {
      const duration = timings[sampleIndex]?.delta || 1024;
      packets.push({
        index: sampleIndex,
        offset,
        size: sizes[sampleIndex],
        timestamp: (cursorSample * 1e6) / mediaTimescale,
        duration: (duration * 1e6) / mediaTimescale
      });
      offset += sizes[sampleIndex];
      cursorSample += duration;
      sampleIndex++;
    }
  }

  const smpb = parseITunSmpb(data);
  if (smpb) {
    warnings.push("iTunSMPB present as secondary gapless evidence");
  }
  if (!edit && !smpb) warnings.push("no edit list or iTunSMPB gapless metadata");

  const editDurationSamples = edit
    ? Math.round((edit.segmentDuration / movieTimescale) * entry.sampleRate)
    : null;
  const mediaTimeSamples = edit ? Math.round((edit.mediaTime / mediaTimescale) * entry.sampleRate) : null;
  const frameSamples = Math.round(((timings[0]?.delta || 1024) * entry.sampleRate) / mediaTimescale);
  const totalDecodedSamples = packets.length * frameSamples;

  return {
    codec: entry.type === "mp4a" ? "mp4a.40.2" : entry.type,
    sampleRate: entry.sampleRate,
    channels: entry.channels,
    description: entry.description,
    packets,
    mediaTimescale,
    movieTimescale,
    mediaDuration,
    frameSamples,
    totalDecodedSamples,
    edit,
    editDurationSamples,
    mediaTimeSamples,
    originalSamples: smpb?.original || null,
    primingSamples: smpb?.priming ?? mediaTimeSamples,
    paddingSamples: smpb?.padding ?? null,
    warnings
  };
}


//# sourceURL=mp4.ts