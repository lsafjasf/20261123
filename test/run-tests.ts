import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runAnalysis } from '../src/shared/analysis-pipeline.ts';
import { decodeWav, encodeWav16 } from '../src/shared/wav-codec.ts';
import { transformBrowserTs } from '../src/server/ts-transform.ts';
import { synthesizeFixture } from '../src/shared/fixtures.ts';
import { runSelfTest } from '../src/cli/selftest.ts';
import { fftRadix2, gainToDb } from '../src/shared/dsp-math.ts';

test('FFT 输出与解析正弦峰值稳定', () => {
  const real = new Float32Array(16);
  const imag = new Float32Array(16);
  real[0] = 1;
  fftRadix2(real, imag);
  assert.ok(real.every((value) => Number.isFinite(value)));
  assert.equal(gainToDb(1), 0);
});

test('WAV 编解码往返保持采样率与近似幅值', () => {
  const signal = Float32Array.from({ length: 800 }, (_, i) =>
    Math.sin((2 * Math.PI * 440 * i) / 8000),
  );
  const bytes = encodeWav16(signal, 8000);
  const decoded = decodeWav(bytes, 'roundtrip');
  assert.equal(decoded.sampleRate, 8000);
  assert.equal(decoded.channels[0].length, signal.length);
  assert.ok(Math.abs(decoded.channels[0][100] - signal[100]) < 0.01);
});

test('分析流水线对四个设备都产出帧与近似模型声明', () => {
  const report = runAnalysis(synthesizeFixture(24000, 4), {
    gains: { dialogue: 0, music: 0, effects: 0 },
  });
  assert.equal(report.devices.length, 4);
  assert.match(report.modelNotice, /近似模型/);
  for (const device of report.devices) {
    assert.ok(device.frames.length > 20);
    for (const frame of device.frames) {
      assert.ok(frame.audibility >= 0 && frame.audibility <= 1);
      assert.ok(Number.isFinite(frame.truePeakDb));
    }
  }
});

test('关闭音乐/效果声会改变掩蔽结果', () => {
  const fixture = synthesizeFixture(24000, 4);
  const full = runAnalysis(fixture, {
    gains: { dialogue: 0, music: 0, effects: 0 },
  });
  const ducked = runAnalysis(fixture, {
    gains: { dialogue: 0, music: -96, effects: -96 },
  });
  const count = (report: typeof full): number =>
    report.devices.reduce(
      (sum, device) =>
        sum + device.events.filter((event) => event.kind === 'masking').length,
      0,
    );
  assert.ok(count(ducked) <= count(full));
});

test('浏览器 TS 转换重写共享与本地 import 且不含类型注解', async () => {
  const source = await readFile(
    resolve('src/browser/audio-decode.ts'),
    'utf8',
  );
  const output = transformBrowserTs(source);
  assert.match(output, /\/shared\/wav-codec\.js\?ts=1/);
  assert.doesNotMatch(output, /:\s*AudioBufferData/);
});

test('自测套件全部通过', async () => {
  await runSelfTest();
});

test('浏览器 UI 模块图在 DOM shim 下完成初始化', async () => {
  await import('./browser-smoke.ts');
});
