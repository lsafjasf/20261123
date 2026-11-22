export type AmfValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | AmfValue[]
  | { [key: string]: AmfValue };

interface Decoded {
  value: AmfValue;
  offset: number;
}

export function decodeAmf0(buffer: Uint8Array, start = 0): Decoded {
  let offset = start;

  const u8 = (): number => {
    if (offset >= buffer.length) throw new Error("AMF0 ended early");
    return buffer[offset++];
  };
  const u16 = (): number => (u8() << 8) | u8();
  const u32 = (): number => {
    const value = (u8() * 0x1000000 + (u8() << 16) + (u8() << 8) + u8()) >>> 0;
    return value;
  };
  const f64 = (): number => {
    if (offset + 8 > buffer.length) throw new Error("AMF0 number ended early");
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
    offset += 8;
    return view.getFloat64(0, false);
  };
  const text = (length: number): string => {
    if (offset + length > buffer.length) throw new Error("AMF0 string ended early");
    const value = Buffer.from(buffer.buffer, buffer.byteOffset + offset, length).toString("utf8");
    offset += length;
    return value;
  };
  const key = (): string => {
    if (offset + 2 > buffer.length) throw new Error("AMF0 key ended early");
    return text(u16());
  };

  const props = (): { [key: string]: AmfValue } => {
    const object: { [key: string]: AmfValue } = {};
    while (offset < buffer.length) {
      const name = key();
      if (!name && buffer[offset] === 0x09) {
        offset++;
        break;
      }
      object[name] = value();
    }
    return object;
  };

  const value = (): AmfValue => {
    const marker = u8();
    switch (marker) {
      case 0x00:
        return f64();
      case 0x01:
        return u8() !== 0;
      case 0x02:
        return text(u16());
      case 0x03:
        return props();
      case 0x05:
        return null;
      case 0x06:
        return undefined;
      case 0x07: {
        const target = decodeAmf0(buffer, offset);
        offset = target.offset;
        return target.value;
      }
      case 0x08: {
        u32();
        return props();
      }
      case 0x0a: {
        const count = u32();
        const array: AmfValue[] = [];
        for (let i = 0; i < count; i++) array.push(value());
        return array;
      }
      case 0x0b: {
        const date = f64();
        offset += 2;
        return date;
      }
      case 0x0c:
        return text(u32());
      case 0x0d:
        return null;
      default:
        throw new Error(`Unsupported AMF0 marker 0x${marker.toString(16)}`);
    }
  };

  const result = value();
  return { value: result, offset };
}

export function decodeAmf0All(buffer: Uint8Array): AmfValue[] {
  const values: AmfValue[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const decoded = decodeAmf0(buffer, offset);
    values.push(decoded.value);
    if (decoded.offset <= offset) break;
    offset = decoded.offset;
  }
  return values;
}

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const out = Buffer.allocUnsafe(3 + bytes.length);
  out[0] = 0x02;
  out.writeUInt16BE(bytes.length, 1);
  bytes.copy(out, 3);
  return out;
}

function encodeValue(value: AmfValue): Buffer {
  if (value === null) return Buffer.from([0x05]);
  if (value === undefined) return Buffer.from([0x06]);
  if (typeof value === "number") {
    const out = Buffer.allocUnsafe(9);
    out[0] = 0x00;
    out.writeDoubleBE(value, 1);
    return out;
  }
  if (typeof value === "boolean") return Buffer.from([0x01, value ? 1 : 0]);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) {
    const parts = value.map(encodeValue);
    const header = Buffer.allocUnsafe(5);
    header[0] = 0x0a;
    header.writeUInt32BE(value.length, 1);
    return Buffer.concat([header, ...parts]);
  }
  const entries: Buffer[] = [];
  for (const [key, child] of Object.entries(value)) {
    const name = Buffer.from(key, "utf8");
    const header = Buffer.allocUnsafe(2);
    header.writeUInt16BE(name.length, 0);
    entries.push(header, name, encodeValue(child));
  }
  return Buffer.concat([Buffer.from([0x03]), ...entries, Buffer.from([0, 0, 9])]);
}

export function encodeAmf0(values: AmfValue[]): Buffer {
  return Buffer.concat(values.map(encodeValue));
}
