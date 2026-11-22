import { open, type FileHandle } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import type { Reader } from './io.ts';

export class NodeFileReader implements Reader {
  private handle: FileHandle;
  readonly size: number;

  private constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  static async create(path: string): Promise<NodeFileReader> {
    const handle = await open(path, 'r');
    const info = await stat(path);
    return new NodeFileReader(handle, info.size);
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    const length = end - start;
    const buffer = Buffer.allocUnsafe(length);
    const result = await this.handle.read(buffer, 0, length, start);
    if (result.bytesRead !== length) {
      throw new Error(`短读: 请求 ${length} 字节，实际 ${result.bytesRead}`);
    }
    return buffer;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
