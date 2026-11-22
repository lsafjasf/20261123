// Canvas 波形：全览（整段录音 + 异常标记带）与细节（帧级包络）。
// 数据来自每 10ms 帧的 peak/rms，2 小时也只有约 72 万帧，逐帧聚合无压力。
                                                                      

export const KIND_COLORS                              = {
  dropout: '#f5a623',
  pop: '#e94f4f',
  clip: '#b03060',
  silence: '#4f8fe9',
  noise: '#9b59b6',
  music: '#2ecc71',
  pause: '#5a6570',
};

export class Waveform {
          feats                       = null;
          segments            = [];
          playhead = 0;
          detailCenter = 0;
  detailSpanSec = 5;
          overview                   ;
          detail                   ;
          onSeek                       ;

  constructor(
    overview                   ,
    detail                   ,
    onSeek                       ,
  ) {
    this.overview = overview;
    this.detail = detail;
    this.onSeek = onSeek;
    overview.addEventListener('pointerdown', (e) => {
      if (!this.feats) return;
      const sec = this.xToSec(e, overview, this.duration);
      this.playhead = sec;
      this.detailCenter = sec;
      this.onSeek(sec);
      this.draw();
    });
    // 滚轮缩放细节视图
    detail.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.detailSpanSec = Math.max(0.2,
        Math.min(60, this.detailSpanSec * (e.deltaY > 0 ? 1.25 : 0.8)));
      this.drawDetail();
    }, { passive: false });
  }

  get duration()         {
    return this.feats ? this.feats.count * this.feats.hopSec : 0;
  }

  setData(feats               , segments           )       {
    this.feats = feats;
    this.segments = segments;
    this.draw();
  }

  setSegments(segments           )       {
    this.segments = segments;
    this.draw();
  }

  setPlayhead(sec        , follow = false)       {
    this.playhead = sec;
    if (follow) {
      const half = this.detailSpanSec / 2;
      if (sec < this.detailCenter - half || sec > this.detailCenter + half) {
        this.detailCenter = sec;
      }
    }
    this.draw();
  }

  centerOn(sec        )       {
    this.detailCenter = sec;
    this.playhead = sec;
    this.draw();
  }

          xToSec(e              , c                   , dur        )         {
    const r = c.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  }

          fitCanvas(c                   )                           {
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d')                            ;
    return ctx;
  }

  draw()       {
    this.drawOverview();
    this.drawDetail();
  }

          drawBands(
    ctx                          , w        , h        ,
    fromSec        , toSec        , alpha        ,
  )       {
    const span = toSec - fromSec;
    for (const s of this.segments) {
      if (s.end < fromSec || s.start > toSec) continue;
      const x0 = ((s.start - fromSec) / span) * w;
      const x1 = Math.max(x0 + 1, ((s.end - fromSec) / span) * w);
      ctx.fillStyle = KIND_COLORS[s.kind] + alpha;
      ctx.fillRect(x0, 0, x1 - x0, h);
    }
  }

          drawOverview()       {
    const c = this.overview;
    const ctx = this.fitCanvas(c);
    const { width: w, height: h } = c;
    ctx.clearRect(0, 0, w, h);
    const f = this.feats;
    if (!f) return;
    const dur = this.duration;
    this.drawBands(ctx, w, h, 0, dur, '33');
    // 每像素列聚合若干帧的 peak
    const mid = h * 0.55;
    const amp = h * 0.42;
    ctx.fillStyle = '#7fd4a8';
    const framesPerPx = f.count / w;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(x * framesPerPx);
      const i1 = Math.min(f.count, Math.max(i0 + 1, Math.ceil((x + 1) * framesPerPx)));
      let mx = 0;
      for (let i = i0; i < i1; i++) if (f.peak[i] > mx) mx = f.peak[i];
      const y = Math.max(1, mx * amp);
      ctx.fillRect(x, mid - y, 1, y * 2);
    }
    // 播放头
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((this.playhead / dur) * w, 0, 1.5, h);
    // 细节视图窗口指示
    const half = this.detailSpanSec / 2;
    ctx.strokeStyle = '#ffffff88';
    const wx = ((this.detailCenter - half) / dur) * w;
    const ww = (this.detailSpanSec / dur) * w;
    ctx.strokeRect(wx, 1, ww, h - 2);
  }

          drawDetail()       {
    const c = this.detail;
    const ctx = this.fitCanvas(c);
    const { width: w, height: h } = c;
    ctx.clearRect(0, 0, w, h);
    const f = this.feats;
    if (!f) return;
    const from = Math.max(0, this.detailCenter - this.detailSpanSec / 2);
    const to = Math.min(this.duration, from + this.detailSpanSec);
    this.drawBands(ctx, w, h, from, to, '2e');
    const span = to - from;
    const mid = h * 0.55;
    const amp = h * 0.45;
    // 帧级包络：每帧一条竖线（peak）+ rms 内条
    const i0 = Math.max(0, Math.floor(from / f.hopSec));
    const i1 = Math.min(f.count, Math.ceil(to / f.hopSec));
    for (let i = i0; i < i1; i++) {
      const x = ((i * f.hopSec - from) / span) * w;
      const bw = Math.max(1, (f.hopSec / span) * w);
      const py = Math.max(1, f.peak[i] * amp);
      ctx.fillStyle = '#7fd4a8';
      ctx.fillRect(x, mid - py, bw, py * 2);
      const ry = Math.max(1, f.rms[i] * amp);
      ctx.fillStyle = '#3d8b66';
      ctx.fillRect(x, mid - ry, bw, ry * 2);
    }
    // 秒刻度
    ctx.fillStyle = '#8a94a0';
    ctx.font = `${10 * (window.devicePixelRatio || 1)}px monospace`;
    const step = span > 20 ? 5 : span > 5 ? 1 : 0.5;
    for (let t = Math.ceil(from / step) * step; t < to; t += step) {
      const x = ((t - from) / span) * w;
      ctx.fillRect(x, h - 14, 1, 6);
      ctx.fillText(`${t.toFixed(step < 1 ? 1 : 0)}s`, x + 3, h - 4);
    }
    // 播放头
    if (this.playhead >= from && this.playhead <= to) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(((this.playhead - from) / span) * w, 0, 1.5, h);
    }
  }
}
