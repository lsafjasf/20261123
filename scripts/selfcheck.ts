import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StreamAnalyzer } from '../src/shared/analyzer.ts';
import { amplitudeToDb } from '../src/shared/loudness.ts';
import { DEFAULT_SETTINGS } from '../src/shared/types.ts';
import { decodeWav, type ByteSource } from '../src/shared/wav.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fileSource(path: string): Promise<ByteSource> {
  const info = await stat(path);
  const handle = await open(path, 'r');
  return {
    size: info.size,
    fileName: path.split('/').pop() || 'audio.wav',
    async read(offset: number, length: number): Promise<ArrayBuffer> {
      const buffer = new Uint8Array(Math.max(0, Math.min(length, info.size - offset)));
      if (buffer.byteLength > 0) await handle.read(buffer, 0, buffer.byteLength, offset);
      return buffer.buffer;
    },
    close: () => handle.close()
  };
}

function synthetic(sampleRate: number, frames: number, channels: number): Float32Array[] {
  return Array.from({ length: channels }, (_, channel) => {
    const data = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const time = frame / sampleRate;
      data[frame] = (channel === 0 ? 0.82 : 0.62) * (
        Math.sin(2 * Math.PI * 997 * time) +
        0.22 * Math.sin(2 * Math.PI * 12100 * time)
      );
    }
    return data;
  });
}

async function analyzeDemo(): Promise<void> {
  const path = resolve(import.meta.dirname, '../artifacts/demo.wav');
  const source = await fileSource(path);
  try {
    let analyzer: StreamAnalyzer | null = null;
    let metadata = null;
    let frames = 0;
    for await (const part of decodeWav(source)) {
      if ('kind' in part && part.kind === 'frames') {
        if (!analyzer) throw new Error('missing metadata');
        analyzer.push(part.channels, part.frameCount);
        frames += part.frameCount;
      } else if ('metadata' in part) {
        metadata = part.metadata;
        analyzer = new StreamAnalyzer(part.metadata.sampleRate, part.metadata.channels);
      }
    }
    assert(analyzer && metadata, 'WAV did not produce metadata');
    assert(frames === 4_320_000, `unexpected frame count ${frames}`);
    const ads = [{ id: 'demo-ad', label: '示例广告段', start: 30, end: 45 }];
    const result = analyzer.finish(metadata, ads, DEFAULT_SETTINGS, ['selfcheck']);
    assert(result.seconds.length === 90, 'expected 90 one-second rows');
    assert(result.ads.length === 1, 'expected one ad segment');
    assert(result.intervals.some((item) => item.kind === 'silence'), 'expected silence interval');
    assert(result.intervals.some((item) => item.kind === 'sample-peak'), 'expected sample peak interval');
    assert(result.truePeak >= result.samplePeak, 'true peak must cover sample peak');
    console.log(JSON.stringify({
      duration: result.metadata.duration,
      integrated: Number(result.integrated.toFixed(2)),
      programIntegrated: Number(result.program.integrated.toFixed(2)),
      adIntegrated: Number(result.ads[0].integrated.toFixed(2)),
      samplePeak: Number(result.samplePeak.toFixed(2)),
      truePeak: Number(result.truePeak.toFixed(2)),
      intervals: result.intervals.map((item) => `${item.kind}@${item.start}-${item.end}`)
    }, null, 2));
  } finally {
    await source.close?.();
  }
}

function checkChunkEquivalence(): void {
  const sampleRate = 48_000;
  const frames = 96_000;
  const channels = synthetic(sampleRate, frames, 2);
  const whole = new StreamAnalyzer(sampleRate, 2);
  whole.push(channels, frames);
  const wholeResult = whole.finish({
    fileName: 'synthetic.wav', fileSize: 0, format: 'synthetic', sampleRate, channels: 2,
    bitsPerSample: 32, duration: frames / sampleRate, decoder: 'wav-stream', streaming: true
  }, [], DEFAULT_SETTINGS);

  const split = new StreamAnalyzer(sampleRate, 2);
  const cuts = [1, 17, 2_147, 4_800, 4_801, 20_003, 47_999, 48_000, 48_007];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut > frames) break;
    const slice = channels.map((channel) => channel.slice(cursor, cut));
    split.push(slice, cut - cursor);
    cursor = cut;
  }
  if (cursor < frames) split.push(channels.map((channel) => channel.slice(cursor)), frames - cursor);
  const splitResult = split.finish({
    fileName: 'synthetic.wav', fileSize: 0, format: 'synthetic', sampleRate, channels: 2,
    bitsPerSample: 32, duration: frames / sampleRate, decoder: 'wav-stream', streaming: true
  }, [], DEFAULT_SETTINGS);

  assert(Math.abs(wholeResult.integrated - splitResult.integrated) < 0.001, 'split integrated differs');
  assert(Math.abs(wholeResult.truePeak - splitResult.truePeak) < 0.001, 'split true peak differs');
  assert(wholeResult.seconds.length === splitResult.seconds.length, 'split seconds differ');
  assert(wholeResult.truePeak > -1, 'synthetic peak should exercise limiter warning');
  console.log(`Chunk equivalence: I=${wholeResult.integrated.toFixed(4)} LUFS, TP=${wholeResult.truePeak.toFixed(3)} dBTP`);
}

checkChunkEquivalence();
await analyzeDemo();
