// Minimal fragmented-MP4 muxer for the MediaSource playback check.
// Supports avc1 / hev1 / vp09 / av01 video in a single-fragment fMP4.
// No external dependencies; byte layout follows ISO BMFF.

export interface MuxInit {
  codecId: 'avc1' | 'hev1' | 'vp09' | 'av01';
  codecString: string;
  width: number;
  height: number;
  timescale: number; // e.g. 90000
  // Codec-specific decoder config record (avcC / hvcC payload) when the
  // encoder provided one via VideoDecoderConfig.description.
  description?: Uint8Array | null;
}

export interface MuxSample {
  data: Uint8Array;
  duration: number; // in timescale units
  keyframe: boolean;
  ctsOffset: number; // presentation - decode time, in timescale units
}

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function u16(value: number): Uint8Array {
  return u8((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  return u8(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function u64(value: number): Uint8Array {
  const hi = Math.floor(value / 4294967296);
  const lo = value >>> 0;
  return concat(u32(hi), u32(lo));
}

function str(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payload = concat(...payloads);
  return concat(u32(8 + payload.length), str(type), payload);
}

function fullBox(type: string, version: number, flags: number, ...payloads: Uint8Array[]): Uint8Array {
  return box(
    type,
    u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff),
    ...payloads,
  );
}

const IDENTITY_MATRIX = concat(
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
);

function ftyp(): Uint8Array {
  return box('ftyp', str('isom'), u32(1), str('isom'), str('iso5'), str('mp41'));
}

function mvhd(timescale: number): Uint8Array {
  return fullBox(
    'mvhd', 0, 0,
    u32(0), u32(0), u32(timescale), u32(0),
    u32(0x00010000), u16(0x0100), u16(0),
    u32(0), u32(0),
    IDENTITY_MATRIX,
    new Uint8Array(24),
    u32(2),
  );
}

function tkhd(width: number, height: number): Uint8Array {
  return fullBox(
    'tkhd', 0, 0x000003,
    u32(0), u32(0), u32(1), u32(0), u32(0),
    u32(0), u32(0),
    u16(0), u16(0), u16(0), u16(0),
    IDENTITY_MATRIX,
    u32(width << 16), u32(height << 16),
  );
}

function mdhd(timescale: number): Uint8Array {
  return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
}

function hdlr(): Uint8Array {
  return fullBox('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler'), u8(0));
}

function vmhd(): Uint8Array {
  return fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
}

function dinf(): Uint8Array {
  return box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
}

function codecConfigBox(init: MuxInit): Uint8Array {
  switch (init.codecId) {
    case 'avc1':
      if (!init.description) throw new Error('avc1 muxing requires avcC description');
      return box('avcC', init.description);
    case 'hev1':
      if (!init.description) throw new Error('hev1 muxing requires hvcC description');
      return box('hvcC', init.description);
    case 'vp09':
      // vpcC: profile 0, level 10, 8-bit, 4:2:0, limited range, BT.709.
      return fullBox('vpcC', 1, 0, u8(0, 10, (8 << 4) | (1 << 1), 1, 1, 1), u16(0));
    case 'av01':
      // av1C: marker+version, profile 0, level idx 4, 8-bit 4:2:0.
      return box('av1C', u8(0x81, 0x04, 0x0c, 0x00));
  }
}

function sampleEntry(init: MuxInit): Uint8Array {
  const compressor = new Uint8Array(32);
  const name = str('WebCodecsBench');
  compressor[0] = name.length;
  compressor.set(name, 1);
  const visual = concat(
    new Uint8Array(6), u16(1), // reserved + data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined / reserved
    u16(init.width), u16(init.height),
    u32(0x00480000), u32(0x00480000),
    u32(0),
    u16(1),
    compressor,
    u16(0x0018), u16(0xffff),
  );
  return box(init.codecId, visual, codecConfigBox(init));
}

function stbl(init: MuxInit): Uint8Array {
  return box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry(init)),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  );
}

function moov(init: MuxInit): Uint8Array {
  const minf = box('minf', vmhd(), dinf(), stbl(init));
  const mdia = box('mdia', mdhd(init.timescale), hdlr(), minf);
  const trak = box('trak', tkhd(init.width, init.height), mdia);
  const trex = fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0));
  return box('moov', mvhd(init.timescale), trak, box('mvex', trex));
}

function moofAndMdat(init: MuxInit, samples: MuxSample[], sequence: number, baseTime: number): Uint8Array {
  const buildMoof = (dataOffset: number): Uint8Array => {
    const trunEntries: Uint8Array[] = [];
    for (const sample of samples) {
      const flags = sample.keyframe ? 2 << 24 : (1 << 24) | 0x00010000;
      trunEntries.push(u32(sample.duration), u32(sample.data.length), u32(flags), u32(sample.ctsOffset));
    }
    const trun = fullBox(
      'trun', 1, 0x000f01,
      u32(samples.length),
      u32(dataOffset),
      ...trunEntries,
    );
    const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
    const tfdt = fullBox('tfdt', 1, 0, u64(baseTime));
    const traf = box('traf', tfhd, tfdt, trun);
    return box('moof', fullBox('mfhd', 0, 0, u32(sequence)), traf);
  };

  let moof = buildMoof(0);
  const dataOffset = moof.length + 8; // moof + mdat header
  moof = buildMoof(dataOffset);
  const mdatPayload = concat(...samples.map((s) => s.data));
  const mdat = concat(u32(8 + mdatPayload.length), str('mdat'), mdatPayload);
  return concat(moof, mdat);
}

export function muxFmp4(init: MuxInit, samples: MuxSample[]): Uint8Array {
  if (samples.length === 0) throw new Error('no samples to mux');
  return concat(ftyp(), moov(init), moofAndMdat(init, samples, 1, 0));
}

// Minimal box walker used by tests and by the harness sanity checks.
export interface BoxInfo {
  type: string;
  offset: number;
  size: number;
}

export function listBoxes(data: Uint8Array, start = 0, end = data.length): BoxInfo[] {
  const out: BoxInfo[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size =
      (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    if (size < 8 || offset + size > end) throw new Error(`bad box ${type} at ${offset} size ${size}`);
    out.push({ type, offset, size });
    offset += size;
  }
  if (offset !== end) throw new Error('trailing bytes after last box');
  return out;
}
