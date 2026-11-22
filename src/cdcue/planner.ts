import type { CueSheet, Marker, PlannedRegion, SplitPlan, WavInfo } from "./types.ts";
import { fail } from "./errors.ts";

export function msfFramesToSamples(frame: number, sampleRate: number, context: string): number {
  const numerator = frame * sampleRate;
  if (!Number.isSafeInteger(numerator)) {
    fail("CUE_INDEX_INVALID", `${context}: index position exceeds safe integer range.`);
  }
  if (numerator % 75 !== 0) {
    fail(
      "CUE_INDEX_INVALID",
      `${context}: ${frame} CD frames cannot map to whole samples at ${sampleRate} Hz (sampleRate must be divisible by 75).`,
    );
  }
  return numerator / 75;
}

export function buildPlan(cue: CueSheet, wav: WavInfo, offsetSamples: number): SplitPlan {
  if (!Number.isSafeInteger(offsetSamples)) {
    fail("OFFSET_INVALID", `offset ${offsetSamples} is not a safe integer number of samples.`);
  }
  const { sampleRate, frameCount } = wav;
  const markers: Marker[] = [];

  for (const track of cue.tracks) {
    for (const index of track.indexes) {
      const sample = msfFramesToSamples(index.frame, sampleRate, `TRACK ${track.number} INDEX ${index.number}`);
      if (sample >= frameCount) {
        fail(
          "LENGTH_INSUFFICIENT",
          `TRACK ${track.number} INDEX ${String(index.number).padStart(2, "0")} at ${index.msf} (sample ${sample}) leaves no PCM frames in a WAV of length ${frameCount}.`,
        );
      }
      markers.push({
        kind: "index",
        trackNumber: track.number,
        indexNumber: index.number,
        msf: index.msf,
        sample,
        originalSample: sample,
      });
    }
  }

  const ordered = [...markers].sort((a, b) => a.sample - b.sample || (a.indexNumber ?? 0) - (b.indexNumber ?? 0));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.sample <= ordered[index - 1]!.sample) {
      const current = ordered[index]!;
      fail(
        "CUE_INDEX_INVALID",
        `TRACK ${current.trackNumber} INDEX ${current.indexNumber} resolves to the same/earlier sample as a preceding index.`,
      );
    }
  }

  const firstIndex = ordered[0]!;
  if (firstIndex.sample > 0) {
    markers.push({ kind: "hidden-start", sample: 0, originalSample: 0 });
  }
  markers.push({ kind: "source-end", sample: frameCount, originalSample: frameCount });

  const corrected = markers.map((marker) => ({
    ...marker,
    sample:
      marker.kind === "source-end" || marker.kind === "hidden-start"
        ? marker.sample
        : marker.sample + offsetSamples,
  }));

  validateCorrected(corrected, frameCount, offsetSamples);

  const regions = buildRegions(cue, corrected, frameCount);
  return {
    regions,
    markers: corrected.sort((a, b) => a.sample - b.sample),
    totalSamples: frameCount,
    offsetSamples,
  };
}

function validateCorrected(markers: Marker[], frameCount: number, offsetSamples: number): void {
  const ordered = [...markers].sort((a, b) => a.sample - b.sample);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;

  if (first.sample < 0) {
    fail(
      "OFFSET_INVALID",
      `offset ${offsetSamples} pushes the first boundary to sample ${first.sample}; negative samples do not exist. Use a smaller |negative| offset.`,
    );
  }
  if (last.sample > frameCount) {
    fail(
      "LENGTH_INSUFFICIENT",
      `offset ${offsetSamples} pushes a boundary to sample ${last.sample}, beyond WAV length ${frameCount}.`,
    );
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.sample <= ordered[index - 1]!.sample) {
      fail("OFFSET_INVALID", `offset ${offsetSamples} collapses or reorders boundaries near sample ${ordered[index]!.sample}.`);
    }
  }
}

function buildRegions(cue: CueSheet, markers: Marker[], frameCount: number): PlannedRegion[] {
  const sorted = [...markers].sort((a, b) => a.sample - b.sample);
  const regions: PlannedRegion[] = [];
  const firstTrackStart = sorted.find((marker) => marker.kind === "index") ?? fail("CUE_INDEX_INVALID", "no TRACK index boundary found.");

  if (firstTrackStart.sample > 0) {
    const hiddenMarkers = sorted.filter((marker) => marker.sample < firstTrackStart.sample);
    regions.push({
      id: "hidden-leadin",
      kind: "hidden",
      startSample: 0,
      endSample: firstTrackStart.sample,
      frameCount: firstTrackStart.sample,
      markers: hiddenMarkers,
    });
  }

  for (let trackOrdinal = 0; trackOrdinal < cue.tracks.length; trackOrdinal += 1) {
    const track = cue.tracks[trackOrdinal]!;
    const startMarker = sorted.find((marker) => marker.kind === "index" && marker.trackNumber === track.number);
    if (!startMarker) {
      fail("CUE_INDEX_INVALID", `TRACK ${track.number} has no INDEX 00/01 start.`);
    }
    const nextTrack = cue.tracks[trackOrdinal + 1];
    const endSample = nextTrack
      ? (sorted.find((marker) => marker.kind === "index" && marker.trackNumber === nextTrack.number)?.sample ??
        fail("CUE_INDEX_INVALID", `TRACK ${nextTrack.number} has no start marker.`))
      : frameCount;
    const trackMarkers = sorted.filter(
      (marker) =>
        marker.kind === "index" &&
        marker.trackNumber === track.number &&
        marker.sample >= startMarker.sample &&
        marker.sample < endSample,
    );
    regions.push({
      id: `track-${String(track.number).padStart(2, "0")}`,
      kind: "track",
      trackNumber: track.number,
      startSample: startMarker.sample,
      endSample,
      frameCount: endSample - startMarker.sample,
      markers: trackMarkers,
    });
    if (endSample <= startMarker.sample) {
      fail("CUE_INDEX_INVALID", `TRACK ${track.number} resolves to a zero-length region after offset correction.`);
    }
  }

  const covered = regions.reduce((sum, region) => sum + region.frameCount, 0);
  if (covered !== frameCount) {
    fail("LENGTH_INSUFFICIENT", `planner covered ${covered} of ${frameCount} samples; this is an internal planning error.`);
  }
  return regions;
}
