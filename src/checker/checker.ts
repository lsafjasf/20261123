import { Rational } from "../time/rational.ts";
import { type QuantizedPosition } from "../time/timeline.ts";
import {
  type ParsedAudioEvent,
  type ParsedCutEvent,
  type ParsedEvent,
  type ParsedManifest,
  type ParsedSubtitleEvent,
  parseManifest,
} from "./manifest.ts";

export interface TimeMarker {
  role: "cut" | "subtitle-start" | "subtitle-end" | "audio-start" | "audio-end";
  editTime: Rational;
  displayFrame: bigint;
  exactDisplayFrame: Rational;
  frameResidual: Rational;
  audioSample: bigint;
  exactAudioSample: Rational;
  sampleResidual: Rational;
}

export interface EventCheck {
  id: string;
  kind: ParsedEvent["kind"];
  sourceFrame?: bigint;
  markers: TimeMarker[];
  ok: boolean;
  failures: string[];
}

export interface CheckReport {
  sourceFps: Rational;
  displayFps: Rational;
  audioSampleRate: Rational;
  eventCount: number;
  passed: number;
  failed: number;
  ok: boolean;
  maxFrameResidual: Rational;
  maxSampleResidual: Rational;
  events: EventCheck[];
}

function marker(
  manifest: ParsedManifest,
  role: TimeMarker["role"],
  editTime: Rational,
): TimeMarker {
  const display = manifest.timeline.timeToDisplayFrame(editTime);
  const audio = manifest.timeline.timeToAudioSample(editTime);
  return {
    role,
    editTime,
    displayFrame: display.integer,
    exactDisplayFrame: display.exact,
    frameResidual: display.residual,
    audioSample: audio.integer,
    exactAudioSample: audio.exact,
    sampleResidual: audio.residual,
  };
}

function withinHalfTick(exact: Rational, integer: bigint): boolean {
  return Rational.integer(integer).sub(exact).abs().compare(Rational.of(1n, 2n)) <= 0;
}

function checkMarker(markerValue: TimeMarker, failures: string[]): void {
  if (!withinHalfTick(markerValue.exactDisplayFrame, markerValue.displayFrame)) {
    failures.push(`${markerValue.role}: display residual exceeds half a frame`);
  }
  if (!withinHalfTick(markerValue.exactAudioSample, markerValue.audioSample)) {
    failures.push(`${markerValue.role}: audio residual exceeds half a sample`);
  }
}

function checkCut(manifest: ParsedManifest, event: ParsedCutEvent): EventCheck {
  const failures: string[] = [];
  const start = marker(manifest, "cut", event.at);
  checkMarker(start, failures);
  if (event.sourceFrame !== undefined) {
    const sourceTime = manifest.timeline.sourceFrameTime(event.sourceFrame);
    const residual = event.at.sub(sourceTime);
    if (residual.compare(Rational.zero()) !== 0) {
      failures.push(
        `cut edit time ${event.at.toString()} is not source frame ${event.sourceFrame} ` +
          `(${sourceTime.toString()}s); residual ${residual.toString()}s, no offset applied`,
      );
    }
  }
  return {
    id: event.id,
    kind: event.kind,
    sourceFrame: event.sourceFrame,
    markers: [start],
    ok: failures.length === 0,
    failures,
  };
}

function checkSubtitle(
  manifest: ParsedManifest,
  event: ParsedSubtitleEvent,
): EventCheck {
  const failures: string[] = [];
  const start = marker(manifest, "subtitle-start", event.start);
  const end = marker(manifest, "subtitle-end", event.end);
  checkMarker(start, failures);
  checkMarker(end, failures);
  if (end.displayFrame <= start.displayFrame) {
    failures.push("subtitle occupies no display frame after exact quantization");
  }
  return {
    id: event.id,
    kind: event.kind,
    markers: [start, end],
    ok: failures.length === 0,
    failures,
  };
}

function checkAudio(manifest: ParsedManifest, event: ParsedAudioEvent): EventCheck {
  const failures: string[] = [];
  const start = marker(manifest, "audio-start", event.at);
  checkMarker(start, failures);
  const markers = [start];
  if (event.end) {
    const end = marker(manifest, "audio-end", event.end);
    checkMarker(end, failures);
    markers.push(end);
    if (end.audioSample <= start.audioSample) {
      failures.push("audio cue occupies no samples after exact quantization");
    }
  }
  return { id: event.id, kind: event.kind, markers, ok: failures.length === 0, failures };
}

export function checkManifestInput(input: unknown): CheckReport {
  const manifest = parseManifest(input);
  const events = manifest.events.map((event) => {
    if (event.kind === "cut") return checkCut(manifest, event);
    if (event.kind === "subtitle") return checkSubtitle(manifest, event);
    return checkAudio(manifest, event);
  });
  const passed = events.filter((event) => event.ok).length;
  let maxFrameResidual = Rational.zero();
  let maxSampleResidual = Rational.zero();
  for (const event of events) {
    for (const point of event.markers) {
      if (point.frameResidual.abs().compare(maxFrameResidual.abs()) > 0) {
        maxFrameResidual = point.frameResidual;
      }
      if (point.sampleResidual.abs().compare(maxSampleResidual.abs()) > 0) {
        maxSampleResidual = point.sampleResidual;
      }
    }
  }
  return {
    sourceFps: manifest.timeline.sourceFps,
    displayFps: manifest.timeline.displayFps,
    audioSampleRate: manifest.timeline.audioSampleRate,
    eventCount: events.length,
    passed,
    failed: events.length - passed,
    ok: passed === events.length,
    maxFrameResidual,
    maxSampleResidual,
    events,
  };
}

function formatResidual(value: Rational): string {
  if (value.compare(Rational.zero()) === 0) return "0";
  return `${value.toString()} (${value.toDecimal(9)})`;
}

export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [
    `sourceFps=${report.sourceFps.toString()} ` +
      `displayFps=${report.displayFps.toString()} ` +
      `audioSampleRate=${report.audioSampleRate.toString()}`,
  ];
  for (const event of report.events) {
    for (const point of event.markers) {
      const source = event.sourceFrame === undefined ? "" : ` sourceFrame=${event.sourceFrame}`;
      lines.push(
        `${event.id} ${point.role}${source} ` +
          `edit=${point.editTime.toString()}s ` +
          `displayFrame=${point.displayFrame} ` +
          `frameResidual=${formatResidual(point.frameResidual)} ` +
          `audioSample=${point.audioSample} ` +
          `sampleResidual=${formatResidual(point.sampleResidual)}`,
      );
    }
    for (const failure of event.failures) lines.push(`  FAIL ${failure}`);
  }
  lines.push(
    `${report.ok ? "PASS" : "FAIL"}: ${report.passed}/${report.eventCount} events; ` +
      `maxFrameResidual=${report.maxFrameResidual.toString()} frame; ` +
      `maxSampleResidual=${report.maxSampleResidual.toString()} sample; ` +
      "zero global offset accepted",
  );
  return lines.join("\n");
}
