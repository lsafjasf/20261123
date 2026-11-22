export interface ClosableFrame {
  close(): void;
}

interface CachedFrame<T extends ClosableFrame> {
  value: T;
  frameNumber: number;
  bytes: number;
}

interface GopEntry<T extends ClosableFrame> {
  id: number;
  frames: Map<number, CachedFrame<T>>;
  bytes: number;
  touched: number;
}

export interface CacheStats {
  gops: number;
  frames: number;
  bytes: number;
  maxGops: number;
  maxBytes: number;
}

export interface PinnedFrame<T extends ClosableFrame> {
  gopId: number;
  frameNumber: number;
  value: T;
}

export class GopFrameCache<T extends ClosableFrame> {
  private gops = new Map<number, GopEntry<T>>();
  private clock = 0;
  private pinned: { gopId: number; frameNumber: number } | null = null;
  readonly maxGops: number;
  readonly maxBytes: number;

  constructor(maxGops = 3, maxBytes = 512 * 1024 * 1024) {
    this.maxGops = maxGops;
    this.maxBytes = maxBytes;
  }

  put(gopId: number, frameNumber: number, value: T, bytes: number): void {
    let gop = this.gops.get(gopId);
    if (!gop) {
      gop = { id: gopId, frames: new Map(), bytes: 0, touched: ++this.clock };
      this.gops.set(gopId, gop);
    }
    const existing = gop.frames.get(frameNumber);
    if (existing) {
      if (existing.value !== value) value.close();
      return;
    }
    const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 1;
    gop.frames.set(frameNumber, { value, frameNumber, bytes: safeBytes });
    gop.bytes += safeBytes;
    gop.touched = ++this.clock;
    this.enforceLimits();
  }

  get(gopId: number, frameNumber: number): T | undefined {
    const gop = this.gops.get(gopId);
    const frame = gop?.frames.get(frameNumber);
    if (!gop || !frame) return undefined;
    gop.touched = ++this.clock;
    return frame.value;
  }

  pin(gopId: number, frameNumber: number): PinnedFrame<T> | null {
    const frame = this.gops.get(gopId)?.frames.get(frameNumber);
    if (!frame) return null;
    this.pinned = { gopId, frameNumber };
    this.enforceLimits();
    return { gopId, frameNumber, value: frame.value };
  }

  unpin(): void {
    this.pinned = null;
  }

  get pinnedFrame(): PinnedFrame<T> | null {
    if (!this.pinned) return null;
    const value = this.gops.get(this.pinned.gopId)?.frames.get(this.pinned.frameNumber)?.value;
    return value ? { ...this.pinned, value } : null;
  }

  has(gopId: number, frameNumber: number): boolean {
    return this.gops.get(gopId)?.frames.has(frameNumber) ?? false;
  }

  get stats(): CacheStats {
    let frames = 0;
    let bytes = 0;
    for (const gop of this.gops.values()) {
      frames += gop.frames.size;
      bytes += gop.bytes;
    }
    return {
      gops: this.gops.size,
      frames,
      bytes,
      maxGops: this.maxGops,
      maxBytes: this.maxBytes
    };
  }

  clear(): void {
    for (const gop of this.gops.values()) {
      for (const frame of gop.frames.values()) frame.value.close();
    }
    this.gops.clear();
    this.pinned = null;
  }

  private enforceLimits(): void {
    while (this.gops.size > this.maxGops) {
      const victim = [...this.gops.values()]
        .filter((gop) => gop.id !== this.pinned?.gopId)
        .sort((left, right) => left.touched - right.touched)[0];
      if (!victim) break;
      this.dropGop(victim);
    }
    while (this.stats.bytes > this.maxBytes) {
      const candidate = [...this.gops.values()]
        .flatMap((gop) => [...gop.frames.values()].map((frame) => ({ gop, frame })))
        .filter(({ gop, frame }) =>
          gop.id !== this.pinned?.gopId || frame.frameNumber !== this.pinned?.frameNumber
        )
        .sort((left, right) => left.gop.touched - right.gop.touched)[0];
      if (!candidate) break;
      candidate.gop.frames.delete(candidate.frame.frameNumber);
      candidate.gop.bytes -= candidate.frame.bytes;
      candidate.frame.value.close();
      if (candidate.gop.frames.size === 0) this.gops.delete(candidate.gop.id);
    }
  }

  private dropGop(gop: GopEntry<T>): void {
    for (const frame of gop.frames.values()) frame.value.close();
    this.gops.delete(gop.id);
  }
}
