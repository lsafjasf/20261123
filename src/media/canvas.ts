import { Rational } from "../time/rational.ts";
import { ExactTimeline } from "../time/timeline.ts";

export interface CanvasFrameInfo {
  displayFrame: bigint;
  editTime: Rational;
  sourceFrame: bigint;
  sourceFrameResidual: Rational;
  audioSample: bigint;
}

export type CanvasFramePainter = (
  context: CanvasRenderingContext2D,
  info: CanvasFrameInfo,
) => void;

/**
 * Canvas presentation uses the integer display frame as its primary key.
 * The decimal clock overlay is derived from that frame for display only.
 */
export class ExactCanvasPresenter {
  readonly canvas: HTMLCanvasElement;
  readonly timeline: ExactTimeline;
  currentFrame = 0n;

  constructor(canvas: HTMLCanvasElement, timeline: ExactTimeline) {
    this.canvas = canvas;
    this.timeline = timeline;
  }

  context2d(): CanvasRenderingContext2D {
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context is unavailable");
    return context;
  }

  resizeToDisplay(width: number, height: number, devicePixelRatio = 1): void {
    const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  present(displayFrame: bigint | number, paint: CanvasFramePainter): CanvasFrameInfo {
    const frame = BigInt(displayFrame);
    if (frame < 0n) throw new RangeError("displayFrame cannot be negative");
    const editTime = this.timeline.displayFrameTime(frame);
    const sourceExact = editTime.mul(this.timeline.sourceFps);
    const sourceFrame = sourceExact.floor();
    const audioSample = this.timeline.timeToAudioSample(editTime, "half-even").integer;
    const info: CanvasFrameInfo = {
      displayFrame: frame,
      editTime,
      sourceFrame,
      sourceFrameResidual: Rational.integer(sourceFrame).sub(sourceExact),
      audioSample,
    };
    this.currentFrame = frame;
    paint(this.context2d(), info);
    return info;
  }

  drawSourceFrame(
    source: CanvasImageSource,
    displayFrame: bigint | number,
    deadline?: VideoFrameCallbackMetadata,
  ): CanvasFrameInfo {
    return this.present(displayFrame, (context, info) => {
      context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      context.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
      context.fillStyle = "rgba(0, 0, 0, 0.72)";
      context.fillRect(0, 0, this.canvas.width, 42);
      context.fillStyle = "#fff";
      context.font = "14px monospace";
      const callback = deadline ? ` callback=${deadline.presentedFrames}` : "";
      context.fillText(
        `display=${info.displayFrame} source=${info.sourceFrame} ` +
          `t=${info.editTime.toString()}s sample=${info.audioSample}${callback}`,
        10,
        26,
      );
    });
  }
}
