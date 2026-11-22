import { simulateRoundedDurationAccumulation } from "../diagnostics/rounding.ts";
import { Rational } from "../time/rational.ts";
import { ExactTimeline } from "../time/timeline.ts";

const timeline = new ExactTimeline({
  sourceFps: "30000/1001",
  displayFps: "30000/1001",
  audioSampleRate: "48000",
});
const spanFrames = 100_000_000n;
const eventCount = 12_000;
let maxFrameResidual = Rational.zero();
let maxSampleResidual = Rational.zero();
let cuts = 0;
let subtitles = 0;
let audio = 0;

for (let index = 0; index < eventCount; index += 1) {
  const frame = (spanFrames * BigInt(index + 1)) / BigInt(eventCount + 1);
  const time = timeline.sourceFrameTime(frame);
  const display = timeline.timeToDisplayFrame(time);
  const sample = timeline.timeToAudioSample(time);
  if (display.residual.abs().compare(maxFrameResidual.abs()) > 0) {
    maxFrameResidual = display.residual;
  }
  if (sample.residual.abs().compare(maxSampleResidual.abs()) > 0) {
    maxSampleResidual = sample.residual;
  }
  if (index % 3 === 0) {
    cuts += 1;
    if (display.integer !== frame) {
      throw new Error(`cut frame mismatch at ${frame}: ${display.integer}`);
    }
  } else if (index % 3 === 1) {
    subtitles += 1;
    const end = timeline.timeToDisplayFrame(timeline.sourceFrameTime(frame + 120n));
    if (end.integer <= display.integer) throw new Error(`subtitle vanished at frame ${frame}`);
  } else {
    audio += 1;
    if (sample.residual.abs().compare(Rational.of(1n, 2n)) > 0) {
      throw new Error(`audio residual exceeds half a sample at frame ${frame}`);
    }
  }
}

const probeFrame = 1_000_000n;
const probeTime = timeline.sourceFrameTime(probeFrame);
const probeDisplay = timeline.timeToDisplayFrame(probeTime);
const probeAudio = timeline.timeToAudioSample(probeTime);
const legacy = simulateRoundedDurationAccumulation(timeline.sourceFps, probeFrame);
const legacySeconds = legacy.driftMs.div(Rational.of(1000n));

if (maxFrameResidual.compare(Rational.zero()) !== 0) {
  throw new Error(`frame residual is not zero: ${maxFrameResidual.toString()}`);
}

process.stdout.write(
  [
    `PASS long sequence over ${spanFrames} frames`,
    `sourceFps=${timeline.sourceFps} displayFps=${timeline.displayFps} ` +
      `audioSampleRate=${timeline.audioSampleRate}`,
    `events=${eventCount} cuts=${cuts} subtitles=${subtitles} audio=${audio}`,
    `maxFrameResidual=${maxFrameResidual} frame`,
    `maxSampleResidual=${maxSampleResidual} sample`,
    `frame ${probeFrame}: edit=${probeTime}s display=${probeDisplay.integer} ` +
      `(residual=${probeDisplay.residual}) sample=${probeAudio.integer} ` +
      `(residual=${probeAudio.residual})`,
    `legacy rounded frame duration=${legacy.frameDurationMs}ms; ` +
      `drift at frame ${probeFrame}=${legacySeconds.toDecimal(3)}s`,
    "global offset: none",
  ].join("\n") + "\n",
);
