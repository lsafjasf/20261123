/**
 * Minimal ISO-BMFF (MP4) demultiplexer feeding a MediaSource.
 * Pure browser code using only native APIs: fetch/File -> ArrayBuffer,
 * manual box parsing, then SourceBuffer.appendBuffer. No third-party demuxer.
 * Designed for fragmented or single-mdat MP4 files produced for web delivery.
 */

export interface Mp4TrackInfo {
  codec: string;
  type: 'video' | 'audio';
}

interface Box {
  type: string;
  start: number;
  size: number;
  headerSize: number;
}

const CONTAINER_TYPES = [
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4; codecs="avc1.4D401E, mp4a.40.2"',
  'video/mp4',
  'audio/mp4; codecs="mp4a.40.2"',
];

/** Walk top-level and nested MP4 boxes without copying payloads. */
export function parseBoxes(buffer: ArrayBuffer): Box[] {
  const view = new DataView(buffer);
  const boxes: Box[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.byteLength) {
    let size = view.getUint32(offset, false);
    const type = String.fromCharCode(...new Uint8Array(buffer, offset + 4, 4));
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8, false));
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.byteLength - offset;
    }
    if (size < headerSize) break;
    boxes.push({ type, start: offset, size, headerSize });
    offset += size;
  }
  return boxes;
}

/** Read codec strings from stsd/sample entries (best-effort, ASCII scan). */
export function detectCodecs(buffer: ArrayBuffer): string[] {
  const bytes = new Uint8Array(buffer);
  const ascii = (start: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  const codecs = new Set<string>();
  for (const tag of ['avc1', 'avc3', 'hev1', 'mp4a', 'opus', 'vp09']) {
    let position = 0;
    const marker = tag.split('').map((c) => c.charCodeAt(0));
    while (position < bytes.length - marker.length) {
      let matched = true;
      for (let i = 0; i < marker.length; i++) {
        if (bytes[position + i] !== marker[i]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        codecs.add(ascii(position, 4));
        break;
      }
      position++;
    }
  }
  return [...codecs];
}

function pickSupportedType(codecs: string[]): string {
  if (typeof MediaSource === 'undefined') {
    throw new Error('当前浏览器不支持 MediaSource Extensions');
  }
  const candidates = codecs.length
    ? [`video/mp4; codecs="${codecs.join(', ')}"`, ...CONTAINER_TYPES]
    : CONTAINER_TYPES;
  for (const candidate of candidates) {
    if (MediaSource.isTypeSupported(candidate)) return candidate;
  }
  throw new Error('没有可被 MediaSource 接受的 MP4 编码组合');
}

/**
 * Stream an MP4 ArrayBuffer into a MediaSource attached to a video element.
 * Appends initialization (moov) first, then media data (mdat), so playback
 * stays inside the native MSE pipeline and remains fully offline.
 */
export async function loadMp4ViaMediaSource(
  video: HTMLVideoElement,
  buffer: ArrayBuffer,
): Promise<void> {
  const boxes = parseBoxes(buffer);
  const codecs = detectCodecs(buffer);
  const mimeType = pickSupportedType(codecs);

  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  await new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
    mediaSource.addEventListener('sourceerror', () => reject(new Error('MediaSource 打开失败')), { once: true });
  });

  const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
  const moov = boxes.find((box) => box.type === 'moov');
  const mdats = boxes.filter((box) => box.type === 'mdat');

  const append = (data: ArrayBuffer): Promise<void> =>
    new Promise((resolve, reject) => {
      sourceBuffer.addEventListener('updateend', () => resolve(), { once: true });
      sourceBuffer.addEventListener('error', () => reject(new Error('SourceBuffer 写入失败')), { once: true });
      sourceBuffer.appendBuffer(data);
    });

  if (moov) {
    await append(buffer.slice(moov.start, moov.start + moov.size));
  }
  for (const mdat of mdats) {
    if (sourceBuffer.updating) {
      await new Promise((resolve) => sourceBuffer.addEventListener('updateend', resolve, { once: true }));
    }
    await append(buffer.slice(mdat.start, mdat.start + mdat.size));
  }
  mediaSource.endOfStream();
}

/**
 * WebCodecs video decode probe: confirms the browser can decode the detected
 * codec entirely on-device. Returns the configured VideoDecoderConfig.
 */
export async function buildVideoDecoderConfig(codecs: string[]): Promise<VideoDecoderConfig | null> {
  if (typeof VideoDecoder === 'undefined') return null;
  const codec = codecs.find((candidate) => candidate.startsWith('avc1') || candidate.startsWith('avc3'));
  if (!codec) return null;
  const config: VideoDecoderConfig = {
    codec,
    codedWidth: 1920,
    codedHeight: 1080,
    optimizeForLatency: false,
  };
  const support = await VideoDecoder.isConfigSupported(config);
  return support.supported ? config : null;
}
