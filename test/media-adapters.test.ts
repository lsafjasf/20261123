import assert from "node:assert/strict";
import test from "node:test";
import { ExactCanvasPresenter } from "../src/media/canvas.ts";
import { ExactMediaSourceController } from "../src/media/mediasource.ts";
import { ExactAudioScheduler } from "../src/media/webaudio.ts";
import { ExactWebCodecsClock } from "../src/media/webcodecs.ts";
import { Rational } from "../src/time/rational.ts";
import { ExactTimeline } from "../src/time/timeline.ts";

const timeline = new ExactTimeline({
  sourceFps: "30000/1001",
  displayFps: "30000/1001",
  audioSampleRate: "48000",
});

test("WebCodecs timestamps are absolute and frame duration never accumulates", () => {
  const clock = new ExactWebCodecsClock(timeline);
  assert.equal(clock.sourceFrameTimestamp(0n), 0);
  assert.equal(clock.sourceFrameTimestamp(1_000_000n), 33_366_666_667);
  const start = BigInt(clock.sourceFrameTimestamp(9_000_000n));
  const end = BigInt(clock.sourceFrameTimestamp(9_000_001n));
  assert.equal(
    end - start,
    BigInt(clock.sourceFrameDuration(9_000_000n)),
  );
  const alignment = clock.alignDecodedTimestamp({
    timestamp: clock.sourceFrameTimestamp(1_000_000n),
  });
  assert.equal(alignment.sourceFrame, 1_000_000n);
  assert.equal(alignment.aligned, true);
  assert.ok(alignment.residualUs.abs().compare(Rational.of(1n, 2n)) <= 0);
});

test("WebAudio start times come from absolute sample indices", () => {
  const starts: number[][] = [];
  const context = {
    currentTime: 12.5,
    destination: {},
    createBufferSource() {
      return {
        buffer: null as AudioBuffer | null,
        connect() {},
        start(when: number, offset: number, duration: number) {
          starts.push([when, offset, duration]);
        },
      };
    },
  };
  const scheduler = new ExactAudioScheduler(context as never, timeline);
  const buffer = { length: 96_000, sampleRate: 48_000 } as AudioBuffer;
  const first = scheduler.scheduleBuffer({
    id: "first",
    buffer,
    startSample: 48_000n,
    bufferOffsetSample: 24_000n,
    sampleCount: 48_000n,
  });
  assert.equal(first.platformContextTime, 13.5);
  assert.equal(first.platformOffsetSeconds, 0.5);
  assert.equal(first.platformDurationSeconds, 1);
  assert.deepEqual(starts[0], [13.5, 0.5, 1]);

  const late = scheduler.scheduleBuffer({
    id: "late",
    buffer,
    startSample: 1_601_600_000n,
    bufferOffsetSample: 0n,
    sampleCount: 1n,
  });
  assert.equal(late.exactContextTime.toString(), "200275/6");
  assert.throws(
    () =>
      scheduler.scheduleBuffer({
        id: "bad-rate",
        buffer: { length: 10, sampleRate: 44_100 } as AudioBuffer,
        startSample: 0n,
      }),
    /does not match/,
  );
});

test("MediaSource seeks by display frame and measures read-back residual", () => {
  const element = { currentTime: 0, duration: 1001 };
  const controller = new ExactMediaSourceController({} as MediaSource, element, timeline);
  const seek = controller.seekToDisplayFrame(1_000_000n);
  assert.equal(seek.exactTime.toString(), "100100/3");
  assert.equal(seek.platformSeconds, element.currentTime);
  const measured = controller.measureCurrentFrame();
  assert.equal(measured.displayFrame, 1_000_000n);
  assert.ok(measured.residual.abs().compare(Rational.of(1n, 2n)) <= 0);
});

test("Canvas presentation is keyed by the integer display frame", () => {
  const drawing: string[] = [];
  const context = {
    clearRect() {},
    drawImage() {},
    fillRect() {},
    fillText(text: string) {
      drawing.push(text);
    },
    set fillStyle(_value: string) {},
    set font(_value: string) {},
  };
  const canvas = {
    width: 640,
    height: 360,
    style: {},
    getContext() {
      return context;
    },
  };
  const presenter = new ExactCanvasPresenter(canvas as never, timeline);
  const info = presenter.drawSourceFrame({} as CanvasImageSource, 1_000_000n);
  assert.equal(info.displayFrame, 1_000_000n);
  assert.equal(info.sourceFrame, 1_000_000n);
  assert.equal(info.audioSample, 1_601_600_000n);
  assert.match(drawing[0], /display=1000000 source=1000000/);
});
