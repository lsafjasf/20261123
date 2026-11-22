// Container-only rewrite.
//
// Each removed box is replaced in place by a 'free' box of exactly the same
// byte length. Because every other byte stays where it was, chunk offsets
// (stco/co64), sample tables and mdat content remain byte-identical. The free
// payload is zeroed so deleted text cannot be recovered from slack space.

import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Finding } from './types.ts';

const FREE = 0x66726565; // 'free'

export interface RewritePlan {
  ranges: { start: number; end: number; finding: Finding }[];
  freeBytes: number;
}

export function planRewrite(findings: Finding[]): RewritePlan {
  const sorted = [...findings].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      throw new Error(
        `删除区间重叠: ${sorted[i - 1]!.path} 与 ${sorted[i]!.path}`,
      );
    }
  }
  for (const finding of sorted) {
    if (finding.size < 8) {
      throw new Error(
        `盒子 ${finding.path} 仅 ${finding.size} 字节，无法构造合法 free 盒`,
      );
    }
  }
  return {
    ranges: sorted.map((finding) => ({
      start: finding.start,
      end: finding.end,
      finding,
    })),
    freeBytes: sorted.reduce((sum, f) => sum + f.size, 0),
  };
}

export async function rewriteContainer(
  inputPath: string,
  outputPath: string,
  plan: RewritePlan,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const input = await open(inputPath, 'r');
  const output = createWriteStream(outputPath, { mode: 0o600 });
  const readStream = createReadStream(inputPath, { highWaterMark: 4 * 1024 * 1024 });

  let fileCursor = 0;
  let rangeIndex = 0;

  const write = async (chunk: Buffer | Uint8Array): Promise<void> => {
    if (!output.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        output.once('drain', resolve);
        output.once('error', reject);
      });
    }
  };

  for await (const rawChunk of readStream) {
    const chunk = rawChunk as Buffer;
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      const absolute = fileCursor + chunkOffset;
      const range = plan.ranges[rangeIndex];
      if (range && absolute >= range.start && absolute < range.end) {
        const localStart = chunkOffset;
        const localEnd = Math.min(chunk.length, range.end - fileCursor);
        const spanLength = localEnd - localStart;
        const replacement = Buffer.alloc(spanLength, 0);
        if (absolute === range.start) {
          replacement.writeUInt32BE(range.end - range.start, 0);
          replacement.writeUInt32BE(FREE, 4);
        }
        await write(replacement);
        chunkOffset = localEnd;
        if (fileCursor + chunkOffset >= range.end) rangeIndex++;
      } else {
        const nextBoundary = range ? range.start : chunk.length + fileCursor;
        const take = Math.min(
          chunk.length - chunkOffset,
          nextBoundary - absolute,
        );
        await write(chunk.subarray(chunkOffset, chunkOffset + take));
        chunkOffset += take;
      }
    }
    fileCursor += chunk.length;
  }

  await new Promise<void>((resolve, reject) => {
    output.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  await input.close();
}
