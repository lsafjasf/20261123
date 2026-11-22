import {
  amplitudeFromDb,
  clamp,
  cosineFadeIn,
  cosineFadeOut,
  dbFromAmplitude,
  measurePeak,
  measureRmsDb,
} from "./dsp.ts";
import type {
  AnalysisResult,
  BreathEvent,
  EditAction,
  EventMap,
  MapSpan,
  PcmAudio,
  ProcessedAudio,
  RoomWindow,
  SeamAudit,
} from "./types.ts";

export interface EditOptions {
  shortenRatio?: number;
  seamMs?: number;
  fadeMs?: number;
  attenuationDb?: number;
}

interface OutputChunk {
  channels: Float32Array[];
  sourceStart: number;
  sourceEnd: number;
  mode: MapSpan["mode"];
  eventId: string | null;
}

const DEFAULTS: Required<EditOptions> = {
  shortenRatio: 0.42,
  seamMs: 32,
  fadeMs: 24,
  attenuationDb: -12,
};

function sliceChannels(pcm: PcmAudio, start: number, end: number): Float32Array[] {
  return pcm.channels.map((channel) => channel.slice(start, end));
}

function makeNoiseSeed(event: BreathEvent, channel: number): number {
  return ((event.start * 1103515245 + channel * 12345 + 67891) >>> 0) || 1;
}

function randomNoise(seed: number, length: number): Float32Array {
  let state = seed >>> 0;
  const noise = new Float32Array(length);
  let previous = 0;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const white = (state / 4294967296) * 2 - 1;
    previous = previous * 0.62 + white * 0.38;
    noise[index] = previous;
  }
  return noise;
}

function normalizeRms(channels: Float32Array[], targetDb: number): void {
  let square = 0;
  let count = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      square += channel[index] * channel[index];
      count += 1;
    }
  }
  const current = Math.sqrt(square / Math.max(1, count));
  const target = amplitudeFromDb(targetDb);
  const gain = clamp(target / Math.max(1e-8, current), 0.04, 4);
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) channel[index] *= gain;
  }
}

function buildNoiseBed(
  pcm: PcmAudio,
  analysis: AnalysisResult,
  event: BreathEvent,
  length: number,
): { channels: Float32Array[]; window: RoomWindow | null; sourceStart: number; sourceEnd: number } {
  const window = analysis.roomWindows[event.roomWindowIndex] || nearestQuietWindow(pcm, analysis, event);
  const channels: Float32Array[] = [];
  if (window && window.end - window.start >= 64) {
    const start = Math.round(clamp(window.start, 0, pcm.length - 1));
    const end = Math.round(clamp(window.end, start + 1, pcm.length));
    const available = end - start;
    for (let channelIndex = 0; channelIndex < pcm.channels.length; channelIndex += 1) {
      const channel = new Float32Array(length);
      const source = pcm.channels[channelIndex];
      const phase = (channelIndex * 977 + event.start) % Math.max(1, available);
      for (let index = 0; index < length; index += 1) {
        channel[index] = source[start + ((phase + index) % available)] || 0;
      }
      channels.push(channel);
    }
    normalizeRms(channels, event.evidence.localFloorDb);
    return { channels, window, sourceStart: start, sourceEnd: Math.min(end, start + length) };
  }

  for (let channelIndex = 0; channelIndex < pcm.channels.length; channelIndex += 1) {
    channels.push(randomNoise(makeNoiseSeed(event, channelIndex), length));
  }
  normalizeRms(channels, event.evidence.localFloorDb);
  return {
    channels,
    window: null,
    sourceStart: event.start,
    sourceEnd: event.start + length,
  };
}

function nearestQuietWindow(pcm: PcmAudio, analysis: AnalysisResult, event: BreathEvent): RoomWindow | null {
  const radius = Math.round(pcm.sampleRate * 1.5);
  const candidates = analysis.roomWindows.filter(
    (window) => Math.abs((window.start + window.end) / 2 - event.start) < radius,
  );
  if (candidates.length) return candidates.sort((a, b) => b.score - a.score)[0];
  return analysis.roomWindows[0] || null;
}

function copyProcessed(
  pcm: PcmAudio,
  start: number,
  end: number,
  eventId: string,
  transform: (channel: Float32Array, channelIndex: number) => void,
): OutputChunk {
  const channels = sliceChannels(pcm, start, end);
  channels.forEach((channel, index) => transform(channel, index));
  return { channels, sourceStart: start, sourceEnd: end, mode: "edited", eventId };
}

function shortenEvent(
  pcm: PcmAudio,
  analysis: AnalysisResult,
  event: BreathEvent,
  options: Required<EditOptions>,
): { chunks: OutputChunk[]; seam: SeamAudit | null } {
  const eventLength = event.end - event.start;
  const seamLength = Math.min(Math.round((options.seamMs / 1000) * pcm.sampleRate), eventLength);
  const contentLength = Math.max(
    Math.round(pcm.sampleRate * 0.025),
    Math.min(eventLength, Math.round(eventLength * options.shortenRatio)),
  );
  const fadeLength = Math.min(
    Math.round((options.fadeMs / 1000) * pcm.sampleRate),
    Math.floor(contentLength * 0.45),
  );
  const contentEnd = event.start + contentLength;
  const content = copyProcessed(pcm, event.start, contentEnd, event.id, (channel) => {
    for (let index = 0; index < channel.length; index += 1) {
      if (index >= channel.length - fadeLength) {
        channel[index] *= cosineFadeOut(index - (channel.length - fadeLength), fadeLength);
      }
    }
  });
  const bed = buildNoiseBed(pcm, analysis, event, seamLength);
  bed.channels.forEach((channel) => {
    const ramp = Math.min(Math.round(pcm.sampleRate * 0.008), channel.length);
    for (let index = 0; index < ramp; index += 1) channel[index] *= cosineFadeIn(index, ramp);
  });
  const seamChunk: OutputChunk = {
    channels: bed.channels,
    sourceStart: bed.sourceStart,
    sourceEnd: bed.sourceEnd,
    mode: "synthetic",
    eventId: event.id,
  };
  return {
    chunks: [content, seamChunk],
    seam: {
      eventId: event.id,
      outputStart: -1,
      outputEnd: -1,
      lengthSamples: seamLength,
      sourceStart: bed.sourceStart,
      sourceEnd: bed.sourceEnd,
      noiseFloorDb: event.evidence.localFloorDb,
      seamRmsDb: measureRmsDb({ ...pcm, channels: bed.channels }, 0, seamLength),
      fadeSamples: fadeLength,
      faded: true,
    },
  };
}

function fadeEvent(
  pcm: PcmAudio,
  analysis: AnalysisResult,
  event: BreathEvent,
  options: Required<EditOptions>,
): { chunk: OutputChunk; seam: SeamAudit | null } {
  const eventLength = event.end - event.start;
  const seamLength = Math.min(Math.round((options.seamMs / 1000) * pcm.sampleRate), eventLength);
  const bed = buildNoiseBed(pcm, analysis, event, seamLength);
  const fadeStart = Math.floor(eventLength * 0.2);
  const fadeEnd = Math.max(fadeStart + 1, Math.floor(eventLength * 0.94));
  const fadeLength = fadeEnd - fadeStart;
  const seamStart = eventLength - seamLength;
  const chunk = copyProcessed(pcm, event.start, event.end, event.id, (channel, channelIndex) => {
    for (let index = 0; index < channel.length; index += 1) {
      if (index >= fadeEnd) channel[index] = 0;
      else if (index >= fadeStart) channel[index] *= cosineFadeOut(index - fadeStart, fadeLength);
      if (index >= seamStart) {
        const seamIndex = index - seamStart;
        const mix = cosineFadeIn(seamIndex, seamLength);
        channel[index] = channel[index] * (1 - mix) + bed.channels[channelIndex][seamIndex] * mix;
      }
    }
  });
  return {
    chunk,
    seam: {
      eventId: event.id,
      outputStart: -1,
      outputEnd: -1,
      lengthSamples: seamLength,
      sourceStart: bed.sourceStart,
      sourceEnd: bed.sourceEnd,
      noiseFloorDb: event.evidence.localFloorDb,
      seamRmsDb: measureRmsDb({ ...pcm, channels: bed.channels }, 0, seamLength),
      fadeSamples: fadeLength,
      faded: true,
    },
  };
}

function attenuateEvent(
  pcm: PcmAudio,
  event: BreathEvent,
  options: Required<EditOptions>,
): OutputChunk {
  const gain = amplitudeFromDb(options.attenuationDb);
  const ramp = Math.min(Math.round(pcm.sampleRate * 0.006), Math.floor((event.end - event.start) / 3));
  return copyProcessed(pcm, event.start, event.end, event.id, (channel) => {
    for (let index = 0; index < channel.length; index += 1) {
      let envelope = gain;
      if (ramp > 0 && index < ramp) envelope *= 0.5 - 0.5 * Math.cos((Math.PI * index) / ramp);
      if (ramp > 0 && index >= channel.length - ramp) {
        const release = index - (channel.length - ramp);
        envelope = gain + (1 - gain) * (0.5 - 0.5 * Math.cos((Math.PI * release) / ramp));
      }
      channel[index] *= envelope;
    }
  });
}

function appendChunk(
  chunks: OutputChunk[],
  chunk: OutputChunk,
  maps: EventMap[],
  event: BreathEvent,
  outputCursor: number,
): number {
  const length = chunk.channels[0]?.length || 0;
  chunks.push(chunk);
  const existing = maps.find((map) => map.eventId === event.id);
  if (existing) {
    existing.outputEnd += length;
    existing.removedSamples = existing.sourceEnd - existing.sourceStart - (existing.outputEnd - existing.outputStart);
  } else {
    maps.push({
      eventId: event.id,
      sourceStart: event.start,
      sourceEnd: event.end,
      outputStart: outputCursor,
      outputEnd: outputCursor + length,
      removedSamples: 0,
    });
  }
  return outputCursor + length;
}

export function processAudio(
  pcm: PcmAudio,
  analysis: AnalysisResult,
  partialOptions: EditOptions = {},
): ProcessedAudio {
  const options: Required<EditOptions> = { ...DEFAULTS, ...partialOptions };
  const events = analysis.events.slice().sort((a, b) => a.start - b.start);
  const chunks: OutputChunk[] = [];
  const seams: SeamAudit[] = [];
  const eventMaps: EventMap[] = [];
  let outputCursor = 0;
  let sourceCursor = 0;

  for (const event of events) {
    const start = clamp(Math.round(event.start), 0, pcm.length);
    const end = clamp(Math.round(event.end), start, pcm.length);
    if (start < sourceCursor || end <= start) continue;
    if (start > sourceCursor) {
      const exact = sliceChannels(pcm, sourceCursor, start);
      chunks.push({ channels: exact, sourceStart: sourceCursor, sourceEnd: start, mode: "exact", eventId: null });
      outputCursor += start - sourceCursor;
    }

    if (event.action === "shorten") {
      const result = shortenEvent(pcm, analysis, event, options);
      for (const chunk of result.chunks) outputCursor = appendChunk(chunks, chunk, eventMaps, event, outputCursor);
      if (result.seam) {
        result.seam.outputStart = outputCursor - result.chunks.at(-1)!.channels[0].length;
        result.seam.outputEnd = outputCursor;
        seams.push(result.seam);
      }
    } else if (event.action === "fade") {
      const chunkStart = outputCursor;
      const result = fadeEvent(pcm, analysis, event, options);
      outputCursor = appendChunk(chunks, result.chunk, eventMaps, event, outputCursor);
      if (result.seam) {
        result.seam.outputStart = chunkStart + result.chunk.channels[0].length - result.seam.lengthSamples;
        result.seam.outputEnd = outputCursor;
        seams.push(result.seam);
      }
    } else if (event.action === "attenuate") {
      outputCursor = appendChunk(chunks, attenuateEvent(pcm, event, options), eventMaps, event, outputCursor);
    } else {
      const exact = sliceChannels(pcm, start, end);
      outputCursor = appendChunk(
        chunks,
        { channels: exact, sourceStart: start, sourceEnd: end, mode: "exact", eventId: event.id },
        eventMaps,
        event,
        outputCursor,
      );
    }
    sourceCursor = end;
  }

  if (sourceCursor < pcm.length) {
    chunks.push({
      channels: sliceChannels(pcm, sourceCursor, pcm.length),
      sourceStart: sourceCursor,
      sourceEnd: pcm.length,
      mode: "exact",
      eventId: null,
    });
  }

  const outputLength = chunks.reduce((sum, chunk) => sum + (chunk.channels[0]?.length || 0), 0);
  const output: PcmAudio = {
    sampleRate: pcm.sampleRate,
    length: outputLength,
    channels: Array.from({ length: pcm.channels.length }, () => new Float32Array(outputLength)),
  };
  const spans: MapSpan[] = [];
  let writeCursor = 0;
  for (const chunk of chunks) {
    const length = chunk.channels[0]?.length || 0;
    if (length === 0) continue;
    chunk.channels.forEach((channel, index) => output.channels[index].set(channel, writeCursor));
    spans.push({
      sourceStart: chunk.sourceStart,
      sourceEnd: chunk.sourceEnd,
      outputStart: writeCursor,
      outputEnd: writeCursor + length,
      mode: chunk.mode,
      eventId: chunk.eventId,
    });
    writeCursor += length;
  }

  const exactSourceFrames = spans
    .filter((span) => span.mode === "exact")
    .reduce((sum, span) => sum + (span.sourceEnd - span.sourceStart), 0);
  const removedFrames = Math.max(0, pcm.length - outputLength);
  const modifiedOutputFrames = Math.max(0, outputLength - exactSourceFrames);
  return {
    pcm: output,
    spans,
    seams,
    eventMaps,
    eventsUsed: events,
    removedSamples: removedFrames * pcm.channels.length,
    modifiedOutputSamples: modifiedOutputFrames * pcm.channels.length,
    exactSourceSamples: exactSourceFrames * pcm.channels.length,
    removedFrames,
    modifiedOutputFrames,
    exactSourceFrames,
    expectedDuration: outputLength / pcm.sampleRate,
    shortenRatio: options.shortenRatio,
  };
}

export function setEventAction(event: BreathEvent, action: EditAction): void {
  event.action = action;
}

export function resetAllAutoActions(events: BreathEvent[]): void {
  for (const event of events) {
    event.kind = event.autoKind;
    event.action = event.autoAction;
    event.manualKind = null;
  }
}

export function cleanAllBreaths(events: BreathEvent[]): void {
  for (const event of events) {
    if (event.kind === "clean") event.action = "shorten";
  }
}

export function dbPeak(pcm: PcmAudio): number {
  return dbFromAmplitude(measurePeak(pcm));
}
