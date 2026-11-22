import { Rational } from "../time/rational.ts";
import { ExactTimeline } from "../time/timeline.ts";

export interface MediaElementLike {
  currentTime: number;
  duration: number;
}

export interface MediaSourceSeek {
  displayFrame: bigint;
  exactTime: Rational;
  platformSeconds: number;
}

export interface CurrentFrameMeasurement {
  displayFrame: bigint;
  exactTime: Rational;
  residual: Rational;
}

/**
 * MediaSource remains the playback transport, but seeks are requested from an
 * exact display-frame index. `currentTime` is only read back for measurement;
 * it never becomes the timeline's source of truth.
 */
export class ExactMediaSourceController {
  readonly mediaSource: MediaSource;
  readonly element: MediaElementLike;
  readonly timeline: ExactTimeline;
  readonly appendedSegments: { start: Rational; end?: Rational }[] = [];

  constructor(mediaSource: MediaSource, element: MediaElementLike, timeline: ExactTimeline) {
    this.mediaSource = mediaSource;
    this.element = element;
    this.timeline = timeline;
  }

  seekToDisplayFrame(displayFrame: bigint | number): MediaSourceSeek {
    const exactTime = this.timeline.displayFrameTime(displayFrame);
    const platformSeconds = exactTime.toPlatformNumber();
    this.element.currentTime = platformSeconds;
    return {
      displayFrame: BigInt(displayFrame),
      exactTime,
      platformSeconds,
    };
  }

  seekToEditTime(exactTime: Rational): MediaSourceSeek {
    const frame = this.timeline.timeToDisplayFrame(exactTime).integer;
    return this.seekToDisplayFrame(frame);
  }

  measureCurrentFrame(): CurrentFrameMeasurement {
    const sampled = Rational.fromDecimal(this.element.currentTime.toString());
    const framePosition = sampled.mul(this.timeline.displayFps);
    const displayFrame = framePosition.round("half-even");
    return {
      displayFrame,
      exactTime: sampled,
      residual: Rational.integer(displayFrame).sub(framePosition),
    };
  }

  async appendSourceBuffer(data: BufferSource, mimeType: string): Promise<void> {
    if (this.mediaSource.readyState !== "open") {
      throw new Error(`MediaSource is not open (${this.mediaSource.readyState})`);
    }
    const buffer = this.mediaSource.addSourceBuffer(mimeType);
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        resolve();
      };
      const failed = (): void => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        reject(new Error("MediaSource append failed"));
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", failed);
      buffer.appendBuffer(data);
    });
  }
}
