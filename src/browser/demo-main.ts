import { CompositeLogSink, EventLog, MemoryLogSink } from '../core/event-log.ts';
import { MediaClock } from '../core/media-clock.ts';
import { PerformanceClock } from '../core/virtual-clock.ts';
import { SyntheticSource } from '../media/synthetic-source.ts';
import type { MediaFrame } from '../media/media-types.ts';
import { LiveSession } from './live-session.ts';
import { WebAudioRenderer } from './web-audio-renderer.ts';
import { CanvasVideoRenderer } from './canvas-video-renderer.ts';

/** 演示用画布渲染器：把合成视频帧的 PTS 画成时间码。 */
class DemoCanvasRenderer extends CanvasVideoRenderer {
  render(frame: MediaFrame): void {
    const canvas = document.getElementById('screen') as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    const pts = frame.ptsMs;
    context.fillStyle = '#0b1020';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#1f6feb';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, wave);
    for (let x = 0; x <= canvas.width; x += 12) {
      context.lineTo(x, 40 + 30 * Math.sin((pts + x) / 180));
    }
    context.stroke();
    context.fillStyle = '#7ee787';
    context.font = '28px monospace';
    context.fillText(formatTimecode(pts), 24, 150);
    context.fillStyle = '#8b949e';
    context.font = '14px monospace';
    context.fillText('synthetic video frame · unified media clock', 24, 185);
  }
}

function formatTimecode(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.floor(ms % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

class DomLogSink extends MemoryLogSink {
  private readonly domContainer: HTMLElement;

  constructor(container: HTMLElement, capacity = 500) {
    super(capacity);
    this.domContainer = container;
  }

  write(entry: Parameters<MemoryLogSink['write']>[0]): void {
    super.write(entry);
    const line = document.createElement('div');
    line.className = `log-line log-${entry.phase}`;
    line.textContent = `#${String(entry.seq).padStart(3, '0')} t=${entry.perfMs.toFixed(0)}ms `
      + `${entry.event}:${entry.phase} state=${entry.state} pts=${entry.mediaMs.toFixed(1)} `
      + `lat=${entry.outputLatencyMs.toFixed(1)} err=${entry.errorMs.toFixed(1)} ${JSON.stringify(entry.detail)}`;
    this.domContainer.appendChild(line);
    this.domContainer.scrollTop = this.domContainer.scrollHeight;
    while (this.domContainer.childElementCount > 500) {
      this.domContainer.firstElementChild?.remove();
    }
  }
}

function main(): void {
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const logContainer = document.getElementById('log') as HTMLElement;
  const domSink = new DomLogSink(logContainer);
  const log = new EventLog(new CompositeLogSink(domSink));
  const clock = new PerformanceClock(performance);
  const mediaClock = new MediaClock({ clock, log });
  const source = new SyntheticSource({ clock, jitterMs: 120 });

  const audioContext = new AudioContext();
  const audioRenderer = new WebAudioRenderer({
    context: audioContext,
    workletUrl: new URL('./audio-worklet.ts', import.meta.url).href,
    clock,
  });
  const videoRenderer = new DemoCanvasRenderer({ canvas });

  const session = new LiveSession({
    clock,
    log,
    mediaClock,
    audioRenderer,
    videoRenderer,
    transport: source,
    pullFrames: () => source.pull(),
    tickIntervalMs: 20,
  });

  document.getElementById('btn-start')?.addEventListener('click', async () => {
    await audioRenderer.init();
    audioRenderer.onLatencyChange((info) => session.reportLatency(info));
    session.start();
    mediaClock.updateBufferedRange(0, 60_000, 60_000);
    session.reportDataAvailable();
    startStatsTicker();
  });
  document.getElementById('btn-pause')?.addEventListener('click', () => session.pause());
  document.getElementById('btn-resume')?.addEventListener('click', () => session.resume());
  document.getElementById('btn-hidden')?.addEventListener('click', () => session.getEngine().onHidden());
  document.getElementById('btn-visible')?.addEventListener('click', () => {
    mediaClock.updateBufferedRange(0, 60_000, source.liveEdgeMs());
    session.getEngine().onVisible();
  });
  document.getElementById('btn-bt')?.addEventListener('click', () => {
    session.reportLatency({ baseLatencyMs: 40, outputLatencyMs: 210, perfMs: clock.now() });
  });
  document.getElementById('btn-wired')?.addEventListener('click', () => {
    session.reportLatency({ baseLatencyMs: 12, outputLatencyMs: 30, perfMs: clock.now() });
  });
  document.getElementById('btn-seek')?.addEventListener('click', () => {
    const input = document.getElementById('seek-input') as HTMLInputElement;
    const target = Number(input.value);
    mediaClock.updateBufferedRange(0, 60_000, source.liveEdgeMs());
    session.seek(target);
    session.reportDataAvailable();
  });
  document.getElementById('btn-catchup')?.addEventListener('click', () => {
    const target = Math.min(source.liveEdgeMs() - 200, mediaClock.getMediaMs() + 1500);
    mediaClock.catchUp(target);
  });
  document.getElementById('btn-conflict')?.addEventListener('click', () => {
    // 缓冲中先排队追直播，再用用户拖动抢占，验证确定性仲裁。
    mediaClock.beginBuffering('underrun');
    mediaClock.catchUp(source.liveEdgeMs() - 200);
    session.seek(3000);
    mediaClock.updateBufferedRange(0, 60_000, source.liveEdgeMs());
    session.reportDataAvailable();
  });

  function startStatsTicker(): void {
    const tick = () => {
      const snapshot = mediaClock.snapshot();
      setText('stat-state', snapshot.state);
      setText('stat-media', `${snapshot.mediaMs.toFixed(1)} ms`);
      setText('stat-edge', `${source.liveEdgeMs().toFixed(0)} ms`);
      setText('stat-latency', `${snapshot.outputLatencyMs.toFixed(1)} ms`);
      setText('stat-lag', `${snapshot.liveEdgeLagMs.toFixed(1)} ms`);
      const stats = session.getEngine().getJitterBuffer().stats();
      setText('stat-depth', `${stats.depthMs.toFixed(0)} ms (a${stats.audioFrames}/v${stats.videoFrames})`);
      setTimeout(tick, 200);
    };
    tick();
  }
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

if (typeof document !== 'undefined') {
  main();
}
