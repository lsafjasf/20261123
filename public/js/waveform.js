import { clamp, downmix } from "./dsp.js";
                                                                                        

const COLORS = {
  clean: "#63e5c0",
  emotional: "#f3bc6b",
  impulse: "#ff7d70",
};

                
            
                 
 

function niceStep(span        )         {
  const options = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const target = span / 7;
  return options.find((value) => value >= target) || 600;
}

function formatTime(seconds        , precise = false)         {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  if (precise) return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
  return rest < 10 && minutes === 0 ? `${rest.toFixed(1)}s` : `${minutes}:${rest.toFixed(0).padStart(2, "0")}`;
}

export class WaveformView {
          canvas                   ;
          context                          ;
          source                  = null;
          sourceMono                      = null;
          processed                        = null;
          processedMono                      = null;
          analysis                        = null;
          selectedId                = null;
          viewStart = 0;
          viewEnd = 1;
          playhead = 0;
          hoverTime                = null;
          width = 1;
          height = 1;

  constructor(canvas                   ) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D unavailable");
    this.context = context;
  }

  setData(
    source          ,
    processed                       ,
    analysis                       ,
  )       {
    this.source = source;
    this.sourceMono = downmix(source);
    this.processed = processed;
    this.processedMono = processed ? downmix(processed.pcm) : null;
    this.analysis = analysis;
    this.viewStart = 0;
    this.viewEnd = source.length / source.sampleRate;
    this.resize();
  }

  setProcessed(processed                       )       {
    this.processed = processed;
    this.processedMono = processed ? downmix(processed.pcm) : null;
    this.draw();
  }

  setSelected(id               )       {
    this.selectedId = id;
    this.draw();
  }

  setPlayhead(seconds        )       {
    this.playhead = seconds;
    this.draw();
  }

  setHoverTime(seconds               )       {
    this.hoverTime = seconds;
    this.draw();
  }

  resetView()       {
    if (!this.source) return;
    this.viewStart = 0;
    this.viewEnd = this.source.length / this.source.sampleRate;
    this.draw();
  }

  getRange()                                               {
    const duration = this.source ? this.source.length / this.source.sampleRate : 1;
    return { start: this.viewStart, end: this.viewEnd, zoom: duration / (this.viewEnd - this.viewStart) };
  }

  timeAtRatio(ratio        )         {
    return this.viewStart + clamp(ratio, 0, 1) * (this.viewEnd - this.viewStart);
  }

  ratioAtTime(time        )         {
    return (time - this.viewStart) / Math.max(1e-9, this.viewEnd - this.viewStart);
  }

  eventAt(time        )                     {
    if (!this.analysis) return null;
    return (
      this.analysis.events.find(
        (event) => time >= event.start / this.source .sampleRate && time <= event.end / this.source .sampleRate,
      ) || null
    );
  }

  zoomAt(factor        , anchorRatio        )       {
    if (!this.source) return;
    const duration = this.source.length / this.source.sampleRate;
    const current = this.viewEnd - this.viewStart;
    const next = clamp(current / factor, Math.min(duration, 0.08), duration);
    const anchorTime = this.timeAtRatio(anchorRatio);
    const start = clamp(anchorTime - next * anchorRatio, 0, Math.max(0, duration - next));
    this.viewStart = start;
    this.viewEnd = start + next;
    this.draw();
  }

  panBy(seconds        )       {
    if (!this.source) return;
    const duration = this.source.length / this.source.sampleRate;
    const span = this.viewEnd - this.viewStart;
    const start = clamp(this.viewStart + seconds, 0, Math.max(0, duration - span));
    this.viewStart = start;
    this.viewEnd = start + span;
    this.draw();
  }

  resize()       {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw()       {
    const context = this.context;
    context.clearRect(0, 0, this.width, this.height);
    if (!this.source || !this.analysis) return;
    const rulerHeight = 22;
    const gap = 7;
    const usable = this.height - rulerHeight - 12;
    const sourceLane       = { y: rulerHeight + 3, height: usable * 0.55 };
    const processedLane       = {
      y: sourceLane.y + sourceLane.height + gap,
      height: usable * 0.3,
    };

    this.drawRuler(rulerHeight);
    this.drawEvents(sourceLane, processedLane);
    this.drawLane(
      this.sourceMono,
      this.source.sampleRate,
      sourceLane,
      "rgba(109, 127, 143, 0.48)",
      "rgba(164, 181, 194, 0.58)",
      1,
    );
    if (this.processedMono && this.processed) {
      this.drawLane(
        this.processedMono,
        this.processed.pcm.sampleRate,
        processedLane,
        "rgba(99, 229, 192, 0.42)",
        "rgba(99, 229, 192, 0.82)",
        0.9,
      );
    } else {
      this.drawLane(this.sourceMono, this.source.sampleRate, processedLane, "rgba(84, 98, 110, 0.25)", "rgba(84, 98, 110, 0.34)", 0.6);
    }
    this.drawLaneLabels(sourceLane, processedLane);
    this.drawSeams();
    this.drawHover();
    this.drawPlayhead();
  }

          timeToX(seconds        )         {
    return this.ratioAtTime(seconds) * this.width;
  }

          drawRuler(rulerHeight        )       {
    const context = this.context;
    const span = this.viewEnd - this.viewStart;
    const step = niceStep(span);
    const first = Math.ceil(this.viewStart / step) * step;
    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.035)";
    context.fillStyle = "rgba(125, 140, 152, 0.7)";
    context.font = "8px SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.lineWidth = 1;
    for (let time = first; time <= this.viewEnd; time += step) {
      const x = Math.round(this.timeToX(time)) + 0.5;
      if (x < 25 || x > this.width - 25) continue;
      context.beginPath();
      context.moveTo(x, rulerHeight - 5);
      context.lineTo(x, this.height);
      context.stroke();
      context.fillText(formatTime(time), x, 11);
    }
    context.restore();
  }

          drawEvents(sourceLane      , processedLane      )       {
    if (!this.analysis || !this.source) return;
    const context = this.context;
    const sourceTop = sourceLane.y;
    const sourceBottom = sourceLane.y + sourceLane.height;
    const processedTop = processedLane.y;
    const processedBottom = processedLane.y + processedLane.height;
    const outputRate = this.processed?.pcm.sampleRate || this.source.sampleRate;
    const outputMaps = new Map(this.processed?.eventMaps.map((map) => [map.eventId, map]) || []);
    for (const event of this.analysis.events) {
      const start = event.start / this.source.sampleRate;
      const end = event.end / this.source.sampleRate;
      const color = COLORS[event.kind];
      const selected = event.id === this.selectedId;
      if (end >= this.viewStart && start <= this.viewEnd) {
        this.drawEventBand(
          this.timeToX(start),
          this.timeToX(end),
          sourceTop,
          sourceBottom,
          color,
          selected,
          event.id,
        );
      }
      const output = outputMaps.get(event.id);
      if (!output) continue;
      const outputStart = output.outputStart / outputRate;
      const outputEnd = output.outputEnd / outputRate;
      if (outputEnd < this.viewStart || outputStart > this.viewEnd) continue;
      this.drawEventBand(
        this.timeToX(outputStart),
        this.timeToX(outputEnd),
        processedTop,
        processedBottom,
        color,
        selected,
        selected ? event.id : "",
      );
    }
  }

          drawEventBand(
    x1Raw        ,
    x2Raw        ,
    top        ,
    bottom        ,
    color        ,
    selected         ,
    label        ,
  )       {
    const context = this.context;
    const x1 = Math.max(0, Math.min(this.width, x1Raw));
    const x2 = Math.max(0, Math.min(this.width, x2Raw));
    const width = Math.max(1.5, x2 - x1);
    if (width < 1.5) return;
    context.save();
    context.globalAlpha = selected ? 0.18 : 0.08;
    context.fillStyle = color;
    context.fillRect(x1, top, width, bottom - top);
    context.globalAlpha = selected ? 0.95 : 0.48;
    context.strokeStyle = color;
    context.lineWidth = selected ? 1.3 : 0.75;
    context.strokeRect(Math.round(x1) + 0.5, Math.round(top) + 0.5, Math.max(1, width - 1), bottom - top - 1);
    context.globalAlpha = 0.92;
    context.fillStyle = color;
    context.fillRect(x1, top, width, 2);
    if (width > 40 && label) {
      context.font = "8px SFMono-Regular, Consolas, monospace";
      context.textAlign = "left";
      context.fillText(label, x1 + 5, top + 11);
    }
    context.restore();
  }

          drawLane(
    mono                     ,
    sampleRate        ,
    lane      ,
    fill        ,
    stroke        ,
    opacity        ,
  )       {
    if (!mono) return;
    const context = this.context;
    const center = lane.y + lane.height / 2;
    const amplitude = lane.height * 0.47;
    const spanSamples = (this.viewEnd - this.viewStart) * sampleRate;
    const startSample = this.viewStart * sampleRate;
    context.save();
    context.globalAlpha = opacity;
    context.strokeStyle = "rgba(255,255,255,0.045)";
    context.beginPath();
    context.moveTo(0, center + 0.5);
    context.lineTo(this.width, center + 0.5);
    context.stroke();

    if (spanSamples / Math.max(1, this.width) < 1.6) {
      context.beginPath();
      for (let x = 0; x < this.width; x += 1) {
        const sampleIndex = Math.floor(startSample + (x / this.width) * spanSamples);
        const value = mono[clamp(sampleIndex, 0, mono.length - 1)] || 0;
        const y = center - value * amplitude;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = stroke;
      context.lineWidth = 1;
      context.stroke();
    } else {
      context.fillStyle = fill;
      for (let x = 0; x < this.width; x += 1) {
        const from = Math.floor(startSample + (x / this.width) * spanSamples);
        const to = Math.floor(startSample + ((x + 1) / this.width) * spanSamples);
        let min = 1;
        let max = -1;
        let rms = 0;
        const stride = Math.max(1, Math.floor((to - from) / 60));
        let count = 0;
        for (let index = from; index < to; index += stride) {
          if (index < 0 || index >= mono.length) continue;
          const value = mono[index];
          min = Math.min(min, value);
          max = Math.max(max, value);
          rms += value * value;
          count += 1;
        }
        if (count === 0) continue;
        rms = Math.sqrt(rms / count);
        const y1 = center - max * amplitude;
        const y2 = center - min * amplitude;
        context.globalAlpha = opacity * 0.72;
        context.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        context.globalAlpha = opacity;
        context.fillStyle = stroke;
        context.fillRect(x, center - rms * amplitude, 1, Math.max(1, rms * amplitude * 2));
        context.fillStyle = fill;
      }
    }
    context.restore();
  }

          drawLaneLabels(sourceLane      , processedLane      )       {
    const context = this.context;
    context.save();
    context.font = "8px SFMono-Regular, Consolas, monospace";
    context.textAlign = "left";
    context.fillStyle = "rgba(103, 117, 127, 0.75)";
    context.fillText("SOURCE", 8, sourceLane.y + 10);
    context.fillStyle = "rgba(83, 191, 161, 0.8)";
    context.fillText("RENDER", 8, processedLane.y + 10);
    context.restore();
  }

          drawSeams()       {
    if (!this.processed || !this.analysis) return;
    const context = this.context;
    context.save();
    context.fillStyle = "rgba(243, 188, 107, 0.9)";
    for (const seam of this.processed.seams) {
      const seconds = seam.outputStart / this.processed.pcm.sampleRate;
      if (seconds < this.viewStart || seconds > this.viewEnd) continue;
      const x = this.timeToX(seconds);
      context.beginPath();
      context.moveTo(x, this.height - 12);
      context.lineTo(x - 3, this.height - 6);
      context.lineTo(x + 3, this.height - 6);
      context.closePath();
      context.fill();
    }
    context.restore();
  }

          drawHover()       {
    if (this.hoverTime === null || this.hoverTime < this.viewStart || this.hoverTime > this.viewEnd) return;
    const context = this.context;
    const x = Math.round(this.timeToX(this.hoverTime)) + 0.5;
    context.save();
    context.strokeStyle = "rgba(200, 215, 223, 0.18)";
    context.setLineDash([2, 3]);
    context.beginPath();
    context.moveTo(x, 22);
    context.lineTo(x, this.height);
    context.stroke();
    context.restore();
  }

          drawPlayhead()       {
    if (this.playhead < this.viewStart || this.playhead > this.viewEnd) return;
    const context = this.context;
    const x = Math.round(this.timeToX(this.playhead)) + 0.5;
    context.save();
    context.strokeStyle = "rgba(238, 248, 245, 0.82)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, 22);
    context.lineTo(x, this.height);
    context.stroke();
    context.fillStyle = "#eaf7f3";
    context.beginPath();
    context.moveTo(x - 3, 22);
    context.lineTo(x + 3, 22);
    context.lineTo(x, 27);
    context.closePath();
    context.fill();
    context.restore();
  }
}
