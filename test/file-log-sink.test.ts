import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/core/event-log.ts';
import { FileLogSink } from '../src/core/file-log-sink.ts';

test('FileLogSink 按 seq 顺序写出可解析的 JSONL 事件日志', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-clock-log-'));
  const filePath = join(directory, 'events.jsonl');
  try {
    const sink = new FileLogSink(filePath);
    const log = new EventLog(sink);
    log.record({
      perfMs: 0,
      event: 'start',
      phase: 'applied',
      state: 'idle',
      mediaMs: 0,
      outputLatencyMs: 0,
    });
    log.record({
      perfMs: 5,
      event: 'latencyChange',
      phase: 'applied',
      state: 'playing',
      mediaMs: 10,
      outputLatencyMs: 210,
      errorMs: 210,
      detail: { baseLatencyMs: 40 },
    });
    sink.close();

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const entries = lines.map((line) => JSON.parse(line) as { seq: number; event: string });
    assert.deepEqual(entries.map((entry) => entry.event), ['start', 'latencyChange']);
    assert.equal(entries[1]?.seq, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
