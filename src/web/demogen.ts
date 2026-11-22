// 演示视频生成：用与 Node 端完全相同的帧表/日志，在 Canvas 上画出
// 帧号、PTS、以及"输入可见"闪烁，编码为 WebM 供回灌测试。
import { demoFramePts, demoLog, demoTruthVideoT } from '../shared/demo.ts';
import { encodeFrames } from './exporter.ts';

export async function generateDemoVideo(onProgress?: (frac: number) => void): Promise<Blob> {
  const pts = demoFramePts();
  const log = demoLog();
  // 预计算每个事件的真值视频时间
  const flashes = log.events
    .filter((e) => e.state === 'down')
    .map((e) => ({ btn: e.btn, videoT: demoTruthVideoT(e.t) }));

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;

  return encodeFrames({
    canvas,
    framePts: pts,
    bitrate: 2_000_000,
    onProgress,
    draw: (i) => {
      const t = pts[i];
      const dur = i < pts.length - 1 ? pts[i + 1] - pts[i] : 16.7;
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, 640, 360);
      // 移动方块便于肉眼观察掉帧
      ctx.fillStyle = '#2f6fed';
      ctx.fillRect((t / 20) % 600, 300, 40, 40);
      ctx.fillStyle = '#fff';
      ctx.font = '28px ui-monospace, monospace';
      ctx.fillText(`frame ${i}`, 24, 60);
      ctx.fillText(`pts ${t.toFixed(1)} ms`, 24, 100);
      // 输入可见闪烁：该帧区间内有点按事件则画按键块
      let x = 24;
      for (const f of flashes) {
        if (f.videoT >= t && f.videoT < t + dur) {
          ctx.fillStyle = '#e8c15a';
          ctx.fillRect(x, 140, 90, 60);
          ctx.fillStyle = '#000';
          ctx.fillText(f.btn, x + 30, 175);
          x += 100;
        }
      }
    },
  });
}
