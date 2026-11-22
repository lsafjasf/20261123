// Builds synthetic but structurally valid ISO-BMFF files with privacy-bearing
// boxes, so the whole pipeline can be tested without third-party tooling.

import { Buffer } from 'node:buffer';

export function box(type: string, payload: Buffer, large = false): Buffer {
  if (large || payload.length + 8 > 0xffffffff) {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(1, 0);
    head.write(type, 4, 'ascii');
    head.writeBigUInt64BE(BigInt(payload.length + 16), 8);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

export function fullBox(type: string, payload: Buffer, version = 0, flags = 0): Buffer {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE((version << 24) | flags, 0);
  return box(type, Buffer.concat([vf, payload]));
}

export function uuidBox(uuidHex: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(payload.length + 24, 0);
  head.write('uuid', 4, 'ascii');
  Buffer.from(uuidHex, 'hex').copy(head, 8);
  return Buffer.concat([head, payload]);
}

export function textFourcc(type: string, text: string): Buffer {
  return box(type, Buffer.from(text, 'utf8'));
}

// iTunes-style data box: type=1 (utf8), locale=0
function dataBox(text: string): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(1, 0);
  const payload = Buffer.from(text, 'utf8');
  return box('data', Buffer.concat([head, payload]));
}

function imageDataBox(bytes: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(13, 0); // JPEG
  return box('data', Buffer.concat([head, bytes]));
}

export function ilstItem(indexedType: string, payload: Buffer): Buffer {
  return box(indexedType, payload);
}

function keyEntry(namespace: number, key: string): Buffer {
  const ns = Buffer.alloc(4);
  ns.writeUInt32BE(namespace, 0);
  const value = Buffer.concat([Buffer.from(`com.${key}`, 'utf8'), Buffer.from([0])]);
  return box('mdta', Buffer.concat([ns, value]));
}

function modernMeta(entries: { key: string; data: Buffer }[]): Buffer {
  const keyList = entries.map((entry) => keyEntry(1, entry.key));
  const keys = fullBox('keys', Buffer.concat(keyList));
  const ilstPayload = Buffer.concat(entries.map((entry) => ilstItem('mdta', entry.data)));
  const ilst = fullBox('ilst', ilstPayload);
  const hdlr = fullBox(
    'hdlr',
    Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('mdirappl', 'ascii'),
      Buffer.alloc(12),
      Buffer.from([0]),
    ]),
  );
  return fullBox('meta', Buffer.concat([hdlr, keys, ilst]));
}

function legacyUdta(): Buffer {
  const gps = box('\u00A9xyz', dataBox('+31.2304+121.4737/'));
  const make = box('make', dataBox('TestPhone'));
  const model = box('modl', dataBox('Pixel-Test 9'));
  return box('udta', Buffer.concat([gps, make, model]));
}

function xmpPacket(): Buffer {
  const xml = `<?xpacket begin="\uFEFF"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/"
      exif:Make="TestPhone" exif:Model="Pixel-Test 9"
      exif:GPSLatitude="31.2304" exif:GPSLongitude="121.4737"
      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
      <xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved"/></rdf:Seq></xmpMM:History>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  return Buffer.from(xml, 'utf8');
}

// Minimal mvhd (v0, standard 100-byte payload).
function mvhd(): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(0, 0); // creation
  payload.writeUInt32BE(0, 4); // modification
  payload.writeUInt32BE(1000, 8); // timescale
  payload.writeUInt32BE(5000, 12); // duration
  return fullBox('mvhd', payload);
}

function tkhd(trackId: number): Buffer {
  const payload = Buffer.alloc(84);
  // tkhd v0 payload: creation(4) modification(4) track_ID(4) at offset 8.
  payload.writeUInt32BE(trackId, 8);
  return fullBox('tkhd', payload);
}

function hdlr(handler: string): Buffer {
  const payload = Buffer.alloc(25);
  payload.write(handler.padEnd(4, '\0'), 4, 'ascii');
  return fullBox('hdlr', payload);
}

function stsd(codec: string): Buffer {
  const sampleEntry = box(codec, Buffer.alloc(8));
  // stsd is a FullBox (version+flags then entry_count).
  return fullBox('stsd', Buffer.concat([u32(1), sampleEntry]));
}

export function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

/**
 * Build a video track whose sample bytes are deterministic fake NAL-ish data.
 * Chunk offsets point into the provided mdat payload region.
 */
function videoTrak(mdatStart: number, codedBytes: Buffer): Buffer {
  const sampleSize = codedBytes.length;
  const stsz = box('stsz', Buffer.concat([u32(0), u32(1), u32(sampleSize)]));
  const stsc = box('stsc', Buffer.concat([u32(1), u32(1), u32(1)]));
  const stco = box('stco', Buffer.concat([u32(1), u32(mdatStart)]));
  const stts = box('stts', Buffer.concat([u32(1), u32(1), u32(5000)]));
  const stbl = box('stbl', Buffer.concat([stsd('avc1'), stts, stsc, stsz, stco]));
  const minf = box('minf', stbl);
  const mdia = box('mdia', Buffer.concat([tkhd(1), hdlr('vide'), minf]));
  return box('trak', mdia);
}

export interface SyntheticFile {
  bytes: Buffer;
  codedStart: number;
  codedBytes: Buffer;
}

export function buildSyntheticMp4(): SyntheticFile {
  const ftyp = box('ftyp', Buffer.concat([
    Buffer.from('isom', 'ascii'),
    u32(0x200),
    Buffer.from('isommp42', 'ascii'),
  ]));

  const codedBytes = Buffer.from('FAKE-CODED-SAMPLE-' + 'X'.repeat(48), 'utf8');
  const mdatHeaderSize = 8;
  const mdat = box('mdat', codedBytes);
  const codedStart = ftyp.length + mdatHeaderSize;

  const meta = modernMeta([
    { key: 'com.apple.quicktime.location.ISO6709', data: dataBox('+31.2304+121.4737/') },
    { key: 'com.apple.quicktime.model', data: dataBox('Pixel-Test 9') },
    { key: 'com.apple.quicktime.make', data: dataBox('TestPhone') },
    { key: 'covr', data: imageDataBox(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3])) },
    { key: 'com.example.chat.preview', data: imageDataBox(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 9])) },
  ]);
  const xmp = uuidBox('be7acfcb97a942e89c71999491e3afac', xmpPacket());
  const c2pa = uuidBox('d8fec3d61b0e481c886093c89faae879', Buffer.from('JUMBF-C2PA-TEST', 'utf8'));
  const trak = videoTrak(codedStart, codedBytes);
  const moov = box('moov', Buffer.concat([
    mvhd(), trak, legacyUdta(), meta, xmp, c2pa,
  ]));

  const bytes = Buffer.concat([ftyp, mdat, moov]);

  return { bytes, codedStart, codedBytes };
}

/** A second file with a large (>4 GiB style) 64-bit largesize box header. */
export function buildLargeHeaderFile(): Buffer {
  const payload = Buffer.from('payload', 'utf8');
  return box('mdat', payload, true);
}
