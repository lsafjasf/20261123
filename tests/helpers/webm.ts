// 测试辅助：最小 EBML 写入器，构造合成 WebM 供解封装器往返测试。

export function vint(value: number): Uint8Array {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  // 长度位放在首字节最高位起的第 length 位上。
  bytes[0] = bytes[0] | (0x80 >>> Math.max(0, bytes.length - 1));
  return Uint8Array.from(bytes);
}

export function element(idBytes: number[], ...bodies: ArrayBufferView[]): Uint8Array {
  const body = concat(
    bodies.map((part) => new Uint8Array(part.buffer, part.byteOffset, part.byteLength))
  );
  return concat([Uint8Array.from(idBytes), vint(body.length), body]);
}

export function uint(id: number[], value: number, bytes = 1): Uint8Array {
  const body = new Uint8Array(bytes);
  let rest = value;
  for (let index = bytes - 1; index >= 0; index -= 1) {
    body[index] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return element(id, body);
}

export function stringElement(id: number[], value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function simpleBlock(track: number, relativeTime: number, keyframe: boolean, payload: Uint8Array): Uint8Array {
  const header = concat([
    vint(track),
    Uint8Array.from([(relativeTime >> 8) & 0xff, relativeTime & 0xff]),
    Uint8Array.from([keyframe ? 0x80 : 0])
  ]);
  return element([0xa3], header, payload);
}

export function buildMinimalWebm(): Uint8Array {
  const float64BE = (value: number): Uint8Array => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, false);
    return bytes;
  };
  const ebmlHeader = element(
    [0x1a, 0x45, 0xdf, 0xa3],
    uint([0x42, 0x82], 1),
    stringElement([0x42, 0x87], "webm"),
    uint([0x42, 0x85], 2)
  );
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    uint([0x2a, 0xd7, 0xb1], 1_000_000, 4),
    element([0x44, 0x89], float64BE(1000))
  );
  const videoTrack = element(
    [0xae],
    element([0xd7], vint(1)),
    uint([0x83], 1),
    stringElement([0x86], "V_VP9"),
    element([0x63, 0xa2], Uint8Array.from([1, 2, 3, 4]))
  );
  const audioTrack = element(
    [0xae],
    element([0xd7], vint(2)),
    uint([0x83], 2),
    stringElement([0x86], "A_OPUS")
  );
  const tracks = element([0x16, 0x54, 0xae, 0x6b], videoTrack, audioTrack);
  const cluster = element(
    [0x1f, 0x43, 0xb6, 0x75],
    uint([0xe7], 0, 2),
    simpleBlock(1, 0, true, Uint8Array.from([0x99, 0x10, 0x20])),
    simpleBlock(1, 33, false, Uint8Array.from([0x99, 0x11, 0x21])),
    simpleBlock(2, 0, true, Uint8Array.from([0x4f, 0x70, 0x75]))
  );
  const segment = element([0x18, 0x53, 0x80, 0x67], info, tracks, cluster);
  return concat([ebmlHeader, segment]);
}
