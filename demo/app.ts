import { encodeAndStream, isPipelineSupported } from '../src/browser/encode-pipeline.ts';
import { MixVisualizer } from '../src/browser/visualizer.ts';
import { PcmPlayer } from '../src/browser/webaudio-player.ts';
import { CollisionMixer, type RenderResult } from '../src/core/mixer.ts';
import { generateScenario } from '../src/core/scenario.ts';
import { CEILING_DB, dbToGain } from '../src/core/types.ts';
import { encodeWavPcm16 } from '../src/core/wav.ts';

const $ = (id: string) => document.getElementById(id)!;
const status = (text: string) => {
  $('status').textContent = text;
};

let render: RenderResult | null = null;
let mixer: CollisionMixer | null = null;
let options = { seed: 20261123, duration: 12, rate: 14 };
let visualizer: MixVisualizer | null = null;
let player: PcmPlayer | null = null;
let raf = 0;
let webmBytes: Uint8Array | null = null;
let lastSignature = '';

$('render').addEventListener('click', async () => {
  options = {
    seed: Number(($('seed') as HTMLInputElement).value),
    duration: Number(($('duration') as HTMLInputElement).value),
    rate: Number(($('rate') as HTMLInputElement).value),
  };
  status('渲染中…');
  const events = generateScenario({
    seed: options.seed,
    duration: options.duration,
    collisionsPerSecond: options.rate,
  });
  mixer = new CollisionMixer(options.seed, events);
  render = mixer.renderAll();
  player = new PcmPlayer(render.pcm);
  visualizer = new MixVisualizer($('canvas') as HTMLCanvasElement, render.metrics);
  visualizer.draw(0);
  fillSummary();
  $('play').disabled = false;
  $('downloadWav').disabled = false;

  const signature = `${options.seed}:${options.duration}:${options.rate}:${render.pcm.length}`;
  status(`渲染完成，${render.totalSamples} 采样。WebCodecs 管线：${
    isPipelineSupported() ? '可用，播放时编码 WebM/Opus' : '不可用，回退 WebAudio PCM'
  }`);
  if (signature === lastSignature) {
    status('与上次参数完全一致：输出逐位相同（确定性已验证）。');
  }
  lastSignature = signature;
});

$('play').addEventListener('click', async () => {
  if (!render || !player) return;
  if (player.isPlaying) {
    player.pause();
    cancelAnimationFrame(raf);
    return;
  }
  await player.play();
  // 演示完整技术栈：支持时把同一份 PCM 编码成 WebM 并接入 MediaSource
  if (isPipelineSupported() && !webmBytes) {
    try {
      const handle = await encodeAndStream(
        render.pcm,
        $('audio') as HTMLAudioElement,
        (ratio) => status(`WebCodecs 编码 + MediaSource 流式封装中 ${(ratio * 100).toFixed(0)}%`),
      );
      webmBytes = handle.bytes;
      $('downloadWebm').disabled = false;
      status(`WebM/Opus 封装完成（${handle.bytes.length} 字节），MediaSource 已就绪。`);
    } catch (err) {
      status(`WebCodecs 路径失败，已保留 WebAudio 回退：${(err as Error).message}`);
    }
  }
  tick();
});

$('downloadWav').addEventListener('click', () => {
  if (!render) return;
  const bytes = encodeWavPcm16(render.pcm, render.sampleRate);
  download(bytes, 'collision-mix.wav', 'audio/wav');
});

$('downloadWebm').addEventListener('click', () => {
  if (!webmBytes) return;
  download(webmBytes, 'collision-mix.webm', 'audio/webm');
});

function tick(): void {
  if (!visualizer || !player) return;
  visualizer.draw(player.currentTime);
  if (player.isPlaying) raf = requestAnimationFrame(tick);
}

function fillSummary(): void {
  if (!mixer || !render) return;
  const records = mixer.scheduleRecords;
  const peak = Math.max(...render.metrics.map((m) => m.masterPeak));
  const rows = [
    records.length,
    records.filter((r) => r.accepted).length,
    records.filter((r) => r.reason === 'rotated').length,
    records.filter((r) => r.reason === 'stolen').length,
    records.filter((r) => r.reason === 'too_slow').length,
    `${peak.toFixed(4)} (ceiling ${dbToGain(CEILING_DB).toFixed(4)})`,
    isPipelineSupported() ? 'WebCodecs+MSE' : 'WebAudio',
  ];
  $('summary').querySelector('tbody')!.innerHTML =
    '<tr>' + rows.map((v) => `<td>${v}</td>`).join('') + '</tr>';
}

function download(bytes: Uint8Array, name: string, type: string): void {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
