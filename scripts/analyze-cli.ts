import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { StreamAnalyzer } from '../src/shared/analyzer.ts';
import { reviewPackage, secondsCsv } from '../src/shared/export.ts';
import { DEFAULT_SETTINGS, type AdSegment, type LoudnessSettings } from '../src/shared/types.ts';
import { decodeWav, type ByteSource } from '../src/shared/wav.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseAds(value: string | undefined): AdSegment[] {
  if (!value) return [];
  return value.split(',').map((raw, index) => {
    const [startText, endText] = raw.split('-');
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`无效广告区间：${raw}`);
    }
    return { id: `ad-${index + 1}`, label: `广告 ${index + 1}`, start, end };
  });
}

async function fileSource(path: string): Promise<ByteSource> {
  const info = await stat(path);
  const handle = await open(path, 'r');
  return {
    size: info.size,
    fileName: basename(path),
    async read(offset: number, length: number): Promise<ArrayBuffer> {
      const buffer = new Uint8Array(Math.max(0, Math.min(length, info.size - offset)));
      if (buffer.byteLength > 0) await handle.read(buffer, 0, buffer.byteLength, offset);
      return buffer.buffer;
    },
    close: () => handle.close()
  };
}

const input = resolve(process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : resolve(import.meta.dirname, '../artifacts/demo.wav'));
const outputBase = resolve(argument('out') || `${input.replace(/\.[^.]+$/, '')}-review`);
const ads = parseAds(argument('ads'));
const settings: LoudnessSettings = {
  ...DEFAULT_SETTINGS,
  target: Number(argument('target') || DEFAULT_SETTINGS.target),
  truePeakLimit: Number(argument('true-peak') || DEFAULT_SETTINGS.truePeakLimit)
};

const source = await fileSource(input);
const first = new Uint8Array(await source.read(0, 12));
if (String.fromCharCode(...first.slice(0, 4)) !== 'RIFF') {
  throw new Error('CLI 仅支持 WAV；AAC/ADTS 请在支持 WebCodecs AAC 的浏览器工作台分析。');
}

let analyzer: StreamAnalyzer | null = null;
let metadata = null;
try {
  for await (const part of decodeWav(source)) {
    if ('metadata' in part) {
      metadata = part.metadata;
      analyzer = new StreamAnalyzer(part.metadata.sampleRate, part.metadata.channels);
    } else if (analyzer) {
      analyzer.push(part.channels, part.frameCount);
    }
  }
} finally {
  await source.close?.();
}
if (!analyzer || !metadata) throw new Error('WAV 解码失败');

const result = analyzer.finish(metadata, ads, settings);
await mkdir(dirname(outputBase), { recursive: true });
const jsonPath = `${outputBase}.json`;
const csvPath = `${outputBase}.csv`;
await writeFile(jsonPath, JSON.stringify(reviewPackage(result), null, 2), 'utf8');
await writeFile(csvPath, secondsCsv(result), 'utf8');

console.log(JSON.stringify({
  input,
  json: jsonPath,
  csv: csvPath,
  integrated: Number(result.integrated.toFixed(2)),
  truePeak: Number(result.truePeak.toFixed(2)),
  samplePeak: Number(result.samplePeak.toFixed(2)),
  seconds: result.seconds.length,
  intervals: result.intervals.length,
  ads: result.ads.length,
  status: result.intervals.some((item) => item.severity === 'critical') ? 'review' : result.intervals.length ? 'warn' : 'pass'
}, null, 2));
