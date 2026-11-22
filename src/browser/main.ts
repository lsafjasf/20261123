import { simulateRoundedDurationAccumulation } from "../diagnostics/rounding.ts";
import { ExactCanvasPresenter } from "../media/canvas.ts";
import { ExactMediaSourceController } from "../media/mediasource.ts";
import { ExactAudioScheduler } from "../media/webaudio.ts";
import { ExactWebCodecsClock } from "../media/webcodecs.ts";
import { Rational } from "../time/rational.ts";
import { ExactTimeline } from "../time/timeline.ts";

type EventKind = "cut" | "subtitle" | "audio";

interface DemoEvent {
  id: string;
  kind: EventKind;
  sourceFrame: bigint;
  editTime: Rational;
  displayFrame: bigint;
  frameResidual: Rational;
  audioSample: bigint;
  sampleResidual: Rational;
  endFrame?: bigint;
}

interface DemoState {
  timeline: ExactTimeline;
  events: DemoEvent[];
  spanFrame: bigint;
  maxFrameResidual: Rational;
  maxSampleResidual: Rational;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const sourceFpsInput = element<HTMLInputElement>("source-fps");
const displayFpsInput = element<HTMLInputElement>("display-fps");
const audioRateInput = element<HTMLInputElement>("audio-rate");
const spanFramesInput = element<HTMLInputElement>("span-frames");
const eventCountInput = element<HTMLInputElement>("event-count");
const report = element<HTMLPreElement>("report");
const canvas = element<HTMLCanvasElement>("ruler");
const frameResidual = element<HTMLSpanElement>("frame-residual");
const sampleResidual = element<HTMLSpanElement>("sample-residual");
const legacyDrift = element<HTMLSpanElement>("legacy-drift");
const webCodecsTimestamp = element<HTMLSpanElement>("webcodecs-ts");

let state: DemoState | undefined;

function maxAbs(left: Rational, right: Rational): Rational {
  return right.abs().compare(left.abs()) > 0 ? right : left;
}

function makeTimeline(): ExactTimeline {
  return new ExactTimeline({
    sourceFps: Rational.parse(sourceFpsInput.value),
    displayFps: Rational.parse(displayFpsInput.value),
    audioSampleRate: Rational.parse(audioRateInput.value),
  });
}

function buildState(): DemoState {
  const timeline = makeTimeline();
  const spanFrame = BigInt(spanFramesInput.value);
  const eventCount = Number(eventCountInput.value);
  if (spanFrame <= 0n || !Number.isSafeInteger(eventCount) || eventCount < 1 || eventCount > 5000) {
    throw new RangeError("序列末帧必须大于 0，事件数必须在 1 到 5000 之间");
  }
  const events: DemoEvent[] = [];
  let maxFrame = Rational.zero();
  let maxSample = Rational.zero();
  for (let index = 0; index < eventCount; index += 1) {
    const sourceFrame = (spanFrame * BigInt(index + 1)) / BigInt(eventCount);
    const editTime = timeline.sourceFrameTime(sourceFrame);
    const display = timeline.timeToDisplayFrame(editTime);
    const audio = timeline.timeToAudioSample(editTime);
    maxFrame = maxAbs(maxFrame, display.residual);
    maxSample = maxAbs(maxSample, audio.residual);
    const kinds: EventKind[] = ["cut", "subtitle", "audio"];
    const kind = kinds[index % kinds.length];
    events.push({
      id: `${kind}-${index + 1}`,
      kind,
      sourceFrame,
      editTime,
      displayFrame: display.integer,
      frameResidual: display.residual,
      audioSample: audio.integer,
      sampleResidual: audio.residual,
      endFrame: kind === "subtitle" ? sourceFrame + 120n : undefined,
    });
  }
  return { timeline, events, spanFrame, maxFrameResidual: maxFrame, maxSampleResidual: maxSample };
}

function frameX(frame: bigint, width: number, span: bigint): number {
  if (span === 0n) return 0;
  return Number((frame * BigInt(width)) / span);
}

function drawRuler(current: DemoState): void {
  const presenter = new ExactCanvasPresenter(canvas, current.timeline);
  canvas.width = 1200;
  canvas.height = 280;
  const context = presenter.context2d();
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.font = "13px monospace";
  context.fillStyle = "#8b949e";
  for (let index = 0; index <= 10; index += 1) {
    const x = Math.round((width - 1) * (index / 10));
    context.fillRect(x, 34, 1, height - 54);
    const frame = (current.spanFrame * BigInt(index)) / 10n;
    context.fillText(`frame ${frame}`, Math.min(x + 4, width - 140), 22);
  }
  context.fillText("cut", 8, 68);
  context.fillText("subtitle", 8, 143);
  context.fillText("audio", 8, 218);

  for (const event of current.events) {
    const x = frameX(event.displayFrame, width, current.spanFrame);
    if (event.kind === "cut") {
      context.fillStyle = "#f0883e";
      context.fillRect(x, 55, 1, 44);
    } else if (event.kind === "subtitle") {
      context.fillStyle = "#3fb950";
      const endX = event.endFrame
        ? Math.max(x + 4, frameX(event.endFrame, width, current.spanFrame))
        : x + 4;
      context.fillRect(x, 130, Math.min(endX - x, 12), 42);
    } else {
      context.fillStyle = "#58a6ff";
      context.beginPath();
      context.arc(x, 196, 2.4, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function lastEvent(current: DemoState): DemoEvent {
  return current.events[current.events.length - 1];
}

function render(current: DemoState): void {
  const last = lastEvent(current);
  frameResidual.textContent = `${current.maxFrameResidual.toString()} frame`;
  sampleResidual.textContent = `${current.maxSampleResidual.toString()} sample`;
  const legacy = simulateRoundedDurationAccumulation(
    current.timeline.sourceFps,
    current.spanFrame,
  );
  const driftSeconds = legacy.driftMs.div(Rational.of(1000n));
  legacyDrift.textContent =
    `${legacy.frameDurationMs.toString()}ms x ${current.spanFrame} = ` +
    `${driftSeconds.toDecimal(3)}s`;
  const clock = new ExactWebCodecsClock(current.timeline);
  const timestamp = clock.sourceFrameTimestampBigInt(last.sourceFrame);
  webCodecsTimestamp.textContent = `${timestamp}us`;

  const counts = { cut: 0, subtitle: 0, audio: 0 };
  for (const event of current.events) counts[event.kind] += 1;
  report.textContent = [
    `PASS  ${current.events.length} events over frame ${current.spanFrame}`,
    `sourceFps=${current.timeline.sourceFps.toString()}  ` +
      `displayFps=${current.timeline.displayFps.toString()}  ` +
      `audioSampleRate=${current.timeline.audioSampleRate.toString()}`,
    `cuts=${counts.cut} subtitles=${counts.subtitle} audio=${counts.audio}`,
    `maxFrameResidual=${current.maxFrameResidual.toString()} frame`,
    `maxSampleResidual=${current.maxSampleResidual.toString()} sample`,
    `last sourceFrame=${last.sourceFrame} displayFrame=${last.displayFrame} ` +
      `audioSample=${last.audioSample} editTime=${last.editTime.toString()}s`,
    `last WebCodecs timestamp=${timestamp}us`,
    `legacy rounded duration=${legacy.frameDurationMs.toString()}ms; ` +
      `accumulated drift=${driftSeconds.toDecimal(6)}s`,
    "global offset: none",
  ].join("\n");
}

function run(): void {
  try {
    state = buildState();
    drawRuler(state);
    render(state);
  } catch (error) {
    state = undefined;
    report.textContent = `FAIL\n${(error as Error).message}`;
  }
}

async function playClicks(): Promise<void> {
  if (!state) run();
  if (!state) return;
  if (!state.timeline.audioSampleRate.isInteger()) {
    report.textContent += "\nFAIL AudioContext 需要整数采样率";
    return;
  }
  const requestedRate = Number(state.timeline.audioSampleRate.n);
  const context = new AudioContext({ sampleRate: requestedRate });
  await context.resume();
  const actualRate = Rational.fromDecimal(context.sampleRate.toString());
  const timeline = new ExactTimeline({
    sourceFps: state.timeline.sourceFps,
    displayFps: state.timeline.displayFps,
    audioSampleRate: actualRate,
  });
  const length = Math.round(context.sampleRate * 0.035);
  const buffer = context.createBuffer(1, Math.max(1, length), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.sin((index / context.sampleRate) * Math.PI * 2 * 880) * 0.18;
  }
  const scheduler = new ExactAudioScheduler(context, timeline);
  for (let index = 0; index < 8; index += 1) {
    const startSample = (actualRate.n * BigInt(index)) / (4n * actualRate.d);
    scheduler.scheduleBuffer({ id: `click-${index}`, buffer, startSample });
  }
  report.textContent +=
    `\nWebAudio: 8 clicks at absolute samples, contextRate=${actualRate.toString()}, ` +
    "no accumulated offset";
}

function inspectMediaSource(): void {
  if (!state) run();
  if (!state) return;
  try {
    const last = lastEvent(state);
    const mediaSource = new MediaSource();
    const elementLike = { currentTime: 0, duration: Number.NaN };
    const controller = new ExactMediaSourceController(mediaSource, elementLike, state.timeline);
    const seek = controller.seekToDisplayFrame(last.displayFrame);
    report.textContent +=
      `\nMediaSource seek: displayFrame=${seek.displayFrame} ` +
      `exactTime=${seek.exactTime.toString()}s ` +
      `platformSeconds=${seek.platformSeconds}; transport conversion only`;
  } catch (error) {
    report.textContent += `\nMediaSource unavailable: ${(error as Error).message}`;
  }
}

element<HTMLButtonElement>("run").addEventListener("click", run);
element<HTMLButtonElement>("clicks").addEventListener("click", () => {
  void playClicks().catch((error: unknown) => {
    report.textContent += `\nWebAudio failed: ${(error as Error).message}`;
  });
});
element<HTMLButtonElement>("mse").addEventListener("click", inspectMediaSource);

run();
