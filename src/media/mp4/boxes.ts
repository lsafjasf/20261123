import { Rational } from "../../time/rational.ts";

export interface Mp4Box {
  type: string;
  start: number;
  payloadStart: number;
  end: number;
  view: DataView;
}

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readSize(view: DataView, offset: number, max: number): { size: number; header: number } {
  if (offset + 8 > max) throw new RangeError("truncated MP4 box header");
  const size32 = view.getUint32(offset);
  if (size32 === 0) return { size: max - offset, header: 8 };
  if (size32 === 1) {
    if (offset + 16 > max) throw new RangeError("truncated MP4 large box header");
    const size64 = view.getBigUint64(offset + 8);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("MP4 box is too large");
    return { size: Number(size64), header: 16 };
  }
  return { size: size32, header: 8 };
}

export function readBoxes(view: DataView, start = 0, end = view.byteLength): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    const { size, header } = readSize(view, offset, end);
    if (size < header || offset + size > end) {
      throw new RangeError(`invalid MP4 box size at byte ${offset}`);
    }
    const type = ascii(view, offset + 4);
    boxes.push({
      type,
      start: offset,
      payloadStart: offset + header,
      end: offset + size,
      view,
    });
    offset += size;
  }
  return boxes;
}

export function child(box: Mp4Box, type: string): Mp4Box | undefined {
  return readBoxes(box.view, box.payloadStart, box.end).find((candidate) => candidate.type === type);
}

export function children(box: Mp4Box, type: string): Mp4Box[] {
  return readBoxes(box.view, box.payloadStart, box.end).filter(
    (candidate) => candidate.type === type,
  );
}

export function path(box: Mp4Box, ...types: string[]): Mp4Box | undefined {
  let current: Mp4Box | undefined = box;
  for (const type of types) {
    if (!current) return undefined;
    current = child(current, type);
  }
  return current;
}

export function fullBoxVersion(box: Mp4Box): number {
  return box.view.getUint8(box.payloadStart);
}

export function readUint64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset);
}

export function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

export function durationAt(
  box: Mp4Box,
  version: number,
  valueOffset: number,
): { timescale: bigint; duration: bigint | null } {
  const offset = box.payloadStart + valueOffset;
  return {
    timescale: BigInt(box.view.getUint32(offset)),
    duration:
      version === 1
        ? readUint64(box.view, offset + 4)
        : BigInt(box.view.getUint32(offset + 4)),
  };
}

export function asSeconds(ticks: bigint, timescale: bigint): Rational {
  if (timescale <= 0n) throw new RangeError("MP4 timescale must be positive");
  return Rational.of(ticks, timescale);
}
