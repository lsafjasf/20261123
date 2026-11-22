             
                     
                      
                     
           
                          
                                               

                                                                      

                                   
                    
                    
                                
                            
                            
                    
                
                         
                              
                      
                    
 

                                    
                   
                                 
                
                              
 

function frameCanvas(frame           , canvas                   )                    {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height),
    0,
    0
  );
  return canvas;
}

function roundedRect(
  context                          ,
  x        ,
  y        ,
  width        ,
  height        ,
  radius        
)       {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export class PreviewRenderer {
          canvas                   ;
          context                          ;
          sourceCanvas = document.createElement("canvas");
          outputCanvas = document.createElement("canvas");
          overlayCanvas = document.createElement("canvas");
          differenceCanvas = document.createElement("canvas");
          lastSource                   = null;
          lastOutput                   = null;

  constructor(canvas                   ) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D 不可用");
    this.context = context;
  }

  framePixelWidth()         {
    return this.canvas.width;
  }

  setFrameAspect(frame           )       {
    const width = Math.max(640, Math.min(960, frame.width * 2));
    const height = Math.round(width * frame.height / frame.width);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.style.aspectRatio = `${width} / ${height}`;
    }
  }

  draw(state                  )       {
    this.setFrameAspect(state.before);
    const { width, height } = this.canvas;
    const context = this.context;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#0b0c0b";
    context.fillRect(0, 0, width, height);

    const sourceCanvas = frameCanvas(state.before, this.sourceCanvas);
    const outputCanvas = frameCanvas(state.output, this.outputCanvas);
    this.lastSource = state.before;
    this.lastOutput = state.output;
    if (state.mode === "source") {
      context.drawImage(sourceCanvas, 0, 0, width, height);
    } else if (state.mode === "output") {
      context.drawImage(outputCanvas, 0, 0, width, height);
      if (state.showOcclusion) this.drawOcclusion(state, 0, width);
    } else if (state.mode === "difference") {
      context.drawImage(this.buildDifference(state), 0, 0, width, height);
    } else {
      const splitX = Math.round(state.split * width);
      context.drawImage(sourceCanvas, 0, 0, width, height);
      context.save();
      context.beginPath();
      context.rect(splitX, 0, width - splitX, height);
      context.clip();
      context.drawImage(outputCanvas, 0, 0, width, height);
      if (state.showOcclusion) this.drawOcclusion(state, splitX, width);
      context.restore();
      this.drawSplit(splitX, height, state.split);
    }

    this.drawLabels(state, width, height);
    if (state.region.enabled) this.drawRegion(state.region, width, height);
  }

          drawOcclusion(state                  , clipStart        , canvasWidth        )       {
    const frame = state.output;
    if (
      this.overlayCanvas.width !== frame.width ||
      this.overlayCanvas.height !== frame.height
    ) {
      this.overlayCanvas.width = frame.width;
      this.overlayCanvas.height = frame.height;
    }
    const overlay = this.overlayCanvas.getContext("2d");
    if (!overlay) return;
    const image = overlay.createImageData(frame.width, frame.height);
    for (let index = 0; index < state.occlusionEdgeMask.length; index += 1) {
      if (!state.occlusionEdgeMask[index]) continue;
      const offset = index * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 103;
      image.data[offset + 2] = 54;
      image.data[offset + 3] = 230;
    }
    overlay.putImageData(image, 0, 0);
    this.context.save();
    this.context.beginPath();
    this.context.rect(clipStart, 0, canvasWidth - clipStart, this.canvas.height);
    this.context.clip();
    this.context.globalCompositeOperation = "screen";
    this.context.drawImage(this.overlayCanvas, 0, 0, this.canvas.width, this.canvas.height);
    this.context.restore();
  }

          buildDifference(state                  )                    {
    const before = state.before;
    const after = state.output;
    const width = before.width;
    const height = before.height;
    if (this.differenceCanvas.width !== width || this.differenceCanvas.height !== height) {
      this.differenceCanvas.width = width;
      this.differenceCanvas.height = height;
    }
    const context = this.differenceCanvas.getContext("2d");
    if (!context) return this.differenceCanvas;
    const image = context.createImageData(width, height);
    for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += 4) {
      const aLuma =
        (before.data[offset] * 77 +
          before.data[offset + 1] * 150 +
          before.data[offset + 2] * 29) >>
        8;
      const bLuma =
        (after.data[offset] * 77 +
          after.data[offset + 1] * 150 +
          after.data[offset + 2] * 29) >>
        8;
      const difference = Math.min(255, Math.abs(aLuma - bLuma) * 3);
      image.data[offset] = Math.min(255, difference * 1.35);
      image.data[offset + 1] = difference * 0.45;
      image.data[offset + 2] = difference * 0.18;
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return this.differenceCanvas;
  }

          drawSplit(x        , height        , split        )       {
    const context = this.context;
    context.save();
    context.strokeStyle = "rgba(244, 241, 228, 0.92)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x + 0.5, 0);
    context.lineTo(x + 0.5, height);
    context.stroke();
    context.fillStyle = "#f4f1e4";
    context.beginPath();
    context.arc(x, height * 0.5, 15, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#151716";
    context.font = "600 13px ui-monospace, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("↔", x, height * 0.5 - 0.5);
    context.font = "10px ui-monospace, monospace";
    context.fillStyle = "rgba(11,12,11,0.78)";
    context.fillText(`${Math.round(split * 100)}%`, x, height * 0.5 + 31);
    context.restore();
  }

          drawLabels(state                  , width        , height        )       {
    const context = this.context;
    const splitX = Math.round(state.split * width);
    const pill = (text        , x        , y        , accent        )       => {
      context.font = "600 11px ui-monospace, SFMono-Regular, monospace";
      const textWidth = context.measureText(text).width;
      context.fillStyle = "rgba(9, 11, 10, 0.76)";
      roundedRect(context, x, y, textWidth + 22, 28, 14);
      context.fill();
      context.fillStyle = accent;
      context.beginPath();
      context.arc(x + 11, y + 14, 3, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#f1eddf";
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(text, x + 19, y + 14);
    };

    if (state.mode === "source") {
      pill("SOURCE · 24P", 20, 20, "#f2ba5b");
    } else if (state.mode === "output" || state.mode === "difference") {
      pill(state.mode === "difference" ? "DIFFERENCE" : "OUTPUT · 60P", 20, 20, "#d8ff5f");
    } else {
      pill("HOLD · 24P", 20, 20, "#f2ba5b");
      const label = "MOTION · 60P";
      context.font = "600 11px ui-monospace, SFMono-Regular, monospace";
      const labelWidth = context.measureText(label).width + 22;
      pill(label, Math.max(splitX + 18, width - labelWidth - 20), 20, "#d8ff5f");
    }

    if (state.showOcclusion && state.mode !== "source") {
      const x = width - 132;
      const y = height - 52;
      context.fillStyle = "rgba(9, 11, 10, 0.76)";
      roundedRect(context, x, y, 112, 18, 9);
      context.fill();
      context.fillStyle = "#ff6736";
      context.fillRect(x + 10, y + 7, 6, 4);
      context.fillStyle = "#d9d4c5";
      context.font = "10px ui-monospace, monospace";
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText("OCCLUSION EDGE", x + 22, y + 9);
    }

    const timeLabel = `OUT ${String(state.entry.index).padStart(4, "0")}  ${state.entry.timeSec.toFixed(4)}s  t=${state.entry.sourcePhase.toFixed(3)}`;
    context.font = "10px ui-monospace, monospace";
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillStyle = "rgba(244, 241, 228, 0.72)";
    context.fillText(timeLabel, 20, height - 16);
    context.textAlign = "right";
    context.fillStyle = "rgba(244, 241, 228, 0.5)";
    context.fillText(
      `${state.stats.interpolatedPixels.toLocaleString()} interp · ${state.stats.occludedPixels.toLocaleString()} guarded`,
      width - 20,
      height - 16
    );
  }

          drawRegion(region                     , width        , height        )       {
    const context = this.context;
    const x = region.x * width;
    const y = region.y * height;
    const w = region.width * width;
    const h = region.height * height;
    context.save();
    context.strokeStyle = "#d8ff5f";
    context.fillStyle = "rgba(216, 255, 95, 0.055)";
    context.lineWidth = 1.5;
    context.setLineDash([7, 5]);
    context.fillRect(x, y, w, h);
    context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    context.setLineDash([]);
    const handles = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ];
    for (const [hx, hy] of handles) {
      context.fillStyle = "#d8ff5f";
      context.fillRect(hx - 3.5, hy - 3.5, 7, 7);
    }
    context.font = "600 10px ui-monospace, monospace";
    const label = `LOCAL ${Math.round(region.strength * 100)}%`;
    const labelWidth = context.measureText(label).width + 16;
    context.fillStyle = "#d8ff5f";
    context.fillRect(x, Math.max(0, y - 20), labelWidth, 18);
    context.fillStyle = "#111410";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(label, x + 8, Math.max(0, y - 20) + 9);
    context.restore();
  }
}

export class TimelineView {
          canvas                   ;
          context                          ;
          state                           = null;

  constructor(canvas                   ) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Timeline canvas 2D 不可用");
    this.context = context;
  }

  timeAt(clientX        )                {
    if (!this.state) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * this.state.info.durationSec;
  }

  draw(state                   )       {
    this.state = state;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const context = this.context;
    const left = 12;
    const right = width - 12;
    const trackWidth = right - left;
    const duration = state.info.durationSec;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#111311";
    context.fillRect(0, 0, width, height);

    context.strokeStyle = "rgba(244, 241, 228, 0.12)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left, 38.5);
    context.lineTo(right, 38.5);
    context.stroke();

    const sourcePixelsPerFrame = trackWidth / (state.info.frameCount * 1.0);
    for (let index = 0; index < state.info.frameCount; index += 1) {
      const x = left + (index / state.info.frameCount) * trackWidth;
      const major = index % 6 === 0;
      context.fillStyle = major
        ? "rgba(242, 186, 91, 0.78)"
        : "rgba(242, 186, 91, 0.24)";
      context.fillRect(x, major ? 25 : 30, 1, major ? 25 : 16);
      if (index % 12 === 0 && sourcePixelsPerFrame > 4) {
        context.fillStyle = "rgba(244, 241, 228, 0.45)";
        context.font = "9px ui-monospace, monospace";
        context.textAlign = "center";
        context.textBaseline = "top";
        context.fillText(`${(index / state.info.fps).toFixed(1)}s`, x, 8);
      }
    }

    const outputCount = state.schedule.length;
    for (let index = 0; index < outputCount; index += 3) {
      const x = left + (index / outputCount) * trackWidth;
      context.fillStyle = "rgba(216, 255, 95, 0.18)";
      context.fillRect(x, 46, 1, 9);
    }

    const entry = state.schedule[state.index];
    if (entry) {
      const pairStart = left + (entry.sourceIndex / state.info.frameCount) * trackWidth;
      const pairEnd =
        left + ((entry.nextSourceIndex + 1) / state.info.frameCount) * trackWidth;
      context.fillStyle = "rgba(242, 186, 91, 0.2)";
      context.fillRect(pairStart, 35, Math.max(2, pairEnd - pairStart), 7);
      const playX = left + (entry.timeSec / duration) * trackWidth;
      context.fillStyle = "#d8ff5f";
      context.fillRect(playX - 1, 15, 2, 47);
      context.beginPath();
      context.arc(playX, 15, 4, 0, Math.PI * 2);
      context.fill();
    }

    if (state.region.enabled) {
      const rx = left + (state.region.x + state.region.width * 0.5) * trackWidth;
      context.strokeStyle = "rgba(216, 255, 95, 0.7)";
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(rx, 54);
      context.lineTo(rx, 62);
      context.stroke();
      context.setLineDash([]);
    }

    context.fillStyle = "rgba(244, 241, 228, 0.45)";
    context.font = "9px ui-monospace, monospace";
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillText("24P SOURCE", left, height - 3);
    context.textAlign = "right";
    context.fillText(
      `${duration.toFixed(2)}s  ·  ${outputCount} OUT`,
      right,
      height - 3
    );
  }
}
