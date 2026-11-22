import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// 浏览器/Node 共享的纯 JS SHA-256，必须与 node:crypto 逐字节一致。
// @ts-ignore 无类型声明的 JS 模块
import { Sha256, sha256Hex } from '../src/shared/sha256.js';

test('SHA-256：与 node:crypto 对齐，覆盖块边界与流式分块', () => {
  const sizes = [0, 1, 2, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 4096, 99991];
  for (const size of sizes) {
    const data = new Uint8Array(size).map((_, index) => (index * 31 + 7) & 0xff);
    const expected = createHash('sha256').update(data).digest('hex');
    assert.equal(sha256Hex(data), expected, `单次哈希失败 size=${size}`);
    const stream = new Sha256();
    for (let offset = 0; offset < data.length; offset += 37) {
      stream.update(data.subarray(offset, Math.min(offset + 37, data.length)));
    }
    assert.equal(stream.hex(), expected, `流式哈希失败 size=${size}`);
  }
});
