// Browser File/Blob implementation of the shared Reader interface.
import type { Reader } from '../src/io.ts';

export class FileReader implements Reader {
  readonly size: number;

  constructor(private readonly file: File) {
    this.size = file.size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    const slice = this.file.slice(start, end);
    const buffer = await slice.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
