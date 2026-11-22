import { measurePeak } from "./dsp.js";
                                                                                         

export function createManifest(
  source          ,
  analysis                ,
  processed                ,
  sourceName        ,
  outputSha256        ,
)               {
  const peak = measurePeak(processed.pcm);
  const eventMap = new Map(processed.eventMaps.map((map) => [map.eventId, map]));
  return {
    schema: "breath-gate-edit-manifest/v1",
    generator: "Breath Gate Studio · 完全离线",
    createdAt: new Date().toISOString(),
    source: {
      name: sourceName,
      sampleRate: source.sampleRate,
      channels: source.channels.length,
      samplesPerChannel: source.length,
      durationSeconds: source.length / source.sampleRate,
    },
    output: {
      sampleRate: processed.pcm.sampleRate,
      channels: processed.pcm.channels.length,
      samplesPerChannel: processed.pcm.length,
      durationSeconds: processed.expectedDuration,
      peakDbfs: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      peakSample: peak,
      sha256: outputSha256,
    },
    policy: {
      shortenRatio: processed.shortenRatio,
      seamMs: 32,
      fadeMs: 24,
      attenuationDb: -12,
    },
    events: analysis.events.map((event) => {
      const map = eventMap.get(event.id);
      return {
        id: event.id,
        kind: event.kind,
        autoKind: event.autoKind,
        action: event.action,
        manualKind: event.manualKind,
        sourceStartSample: event.start,
        sourceEndSample: event.end,
        outputStartSample: map?.outputStart ?? -1,
        outputEndSample: map?.outputEnd ?? -1,
        removedSamples: map?.removedSamples ?? 0,
        note: event.note,
        evidence: event.evidence,
      };
    }),
    seams: processed.seams.map((seam) => ({
      eventId: seam.eventId,
      outputStartSample: seam.outputStart,
      outputEndSample: seam.outputEnd,
      sourceStartSample: seam.sourceStart,
      sourceEndSample: seam.sourceEnd,
      noiseFloorDb: seam.noiseFloorDb,
      seamRmsDb: seam.seamRmsDb,
      fadeSamples: seam.fadeSamples,
    })),
    exactSpans: processed.spans
      .filter((span) => span.mode === "exact")
      .map((span) => ({
        sourceStartSample: span.sourceStart,
        sourceEndSample: span.sourceEnd,
        outputStartSample: span.outputStart,
        outputEndSample: span.outputEnd,
      })),
    totals: {
      exactSourceSamples: processed.exactSourceSamples,
      modifiedOutputSamples: processed.modifiedOutputSamples,
      removedSamples: processed.removedSamples,
      exactSourceFrames: processed.exactSourceFrames,
      modifiedOutputFrames: processed.modifiedOutputFrames,
      removedFrames: processed.removedFrames,
      editCount: analysis.events.filter((event) => event.action !== "keep" && event.action !== "restore").length,
      seamCount: processed.seams.length,
    },
  };
}
