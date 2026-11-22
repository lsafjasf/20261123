// 用与 Node 端完全一致的纯 JS SHA-256 做文件内容寻址，分块读取避免撑爆内存。
import { Sha256 } from '/shared/sha256.js';

export async function hashFile(file, onProgress) {
  const digest = new Sha256();
  const chunkSize = 8 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const buffer = await file
      .slice(offset, Math.min(offset + chunkSize, file.size))
      .arrayBuffer();
    digest.update(new Uint8Array(buffer));
    offset += buffer.byteLength;
    onProgress?.(offset / file.size);
  }
  return digest.hex();
}
