import { Rational, rational } from "../time/rational.ts";
import { ExactTimeline } from "../time/timeline.ts";

export type ExactInput = string | number | { n: string | number; d: string | number };

export interface RawTimelineManifest {
  sourceFps: ExactInput;
  displayFps: ExactInput;
  audioSampleRate: ExactInput;
  events: RawEvent[];
  globalOffset?: never;
  [key: string]: unknown;
}

export interface RawCutEvent {
  id: string;
  kind: "cut";
  at: ExactInput;
  sourceFrame?: string | number;
}

export interface RawSubtitleEvent {
  id: string;
  kind: "subtitle";
  start: ExactInput;
  end: ExactInput;
}

export interface RawAudioEvent {
  id: string;
  kind: "audio";
  at: ExactInput;
  end?: ExactInput;
}

export type RawEvent = RawCutEvent | RawSubtitleEvent | RawAudioEvent;

export interface ParsedCutEvent {
  id: string;
  kind: "cut";
  at: Rational;
  sourceFrame?: bigint;
}

export interface ParsedSubtitleEvent {
  id: string;
  kind: "subtitle";
  start: Rational;
  end: Rational;
}

export interface ParsedAudioEvent {
  id: string;
  kind: "audio";
  at: Rational;
  end?: Rational;
}

export type ParsedEvent = ParsedCutEvent | ParsedSubtitleEvent | ParsedAudioEvent;

export interface ParsedManifest {
  timeline: ExactTimeline;
  events: ParsedEvent[];
}

export function parseExact(value: ExactInput, label: string): Rational {
  try {
    if (typeof value === "object" && value !== null && "n" in value && "d" in value) {
      return rational(`${value.n}/${value.d}`);
    }
    return rational(value);
  } catch (error) {
    throw new TypeError(`${label} is not exact: ${(error as Error).message}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function parseNonNegative(value: ExactInput, label: string): Rational {
  const parsed = parseExact(value, label);
  if (parsed.compare(Rational.zero()) < 0) throw new RangeError(`${label} cannot be negative`);
  return parsed;
}

function parseFrame(value: string | number, label: string): bigint {
  try {
    const frame = typeof value === "number" ? BigInt(value) : BigInt(value);
    if (frame < 0n) throw new RangeError("negative");
    return frame;
  } catch {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

function parseEvent(raw: unknown, index: number): ParsedEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError(`events[${index}] must be an object`);
  }
  const event = raw as Record<string, unknown>;
  const id = requireString(event.id, `events[${index}].id`);
  const kind = requireString(event.kind, `events[${index}].kind`);

  if (kind === "cut") {
    const sourceFrame =
      event.sourceFrame === undefined
        ? undefined
        : parseFrame(event.sourceFrame as string | number, `${id}.sourceFrame`);
    return {
      id,
      kind,
      at: parseNonNegative(event.at as ExactInput, `${id}.at`),
      sourceFrame,
    };
  }
  if (kind === "subtitle") {
    const start = parseNonNegative(event.start as ExactInput, `${id}.start`);
    const end = parseNonNegative(event.end as ExactInput, `${id}.end`);
    if (end.compare(start) <= 0) throw new RangeError(`${id}.end must be after start`);
    return { id, kind, start, end };
  }
  if (kind === "audio") {
    const at = parseNonNegative(event.at as ExactInput, `${id}.at`);
    const end =
      event.end === undefined ? undefined : parseNonNegative(event.end as ExactInput, `${id}.end`);
    if (end && end.compare(at) <= 0) throw new RangeError(`${id}.end must be after at`);
    return { id, kind, at, end };
  }
  throw new TypeError(`${id}.kind must be cut, subtitle or audio`);
}

export function parseManifest(input: unknown): ParsedManifest {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("manifest must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const forbidden of ["globalOffset", "globalOffsetMs", "manualOffset", "syncOffset"]) {
    if (forbidden in raw) {
      throw new RangeError(`${forbidden} is not accepted; fix the mapping instead of shifting it`);
    }
  }
  if (!Array.isArray(raw.events)) throw new TypeError("manifest.events must be an array");

  const timeline = new ExactTimeline({
    sourceFps: parseExact(raw.sourceFps as ExactInput, "sourceFps"),
    displayFps: parseExact(raw.displayFps as ExactInput, "displayFps"),
    audioSampleRate: parseExact(raw.audioSampleRate as ExactInput, "audioSampleRate"),
  });
  const events = raw.events.map((event, index) => parseEvent(event, index));
  return { timeline, events };
}
