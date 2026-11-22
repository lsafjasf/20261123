import type {
  AlgorithmState,
  AudioPacket,
  ConcealmentInterval,
  ConcealmentOptions,
  RepairEvent,
  RepairReport,
  RepairStats
} from "./types.ts";
import { analyzeGap, classifyGap } from "./analyze.ts";
import { concealGap } from "./conceal.ts";
import { resampleChannels, resolveOptions } from "./dsp.ts";
import { inspectPacket, type PacketIntegrity } from "./integrity.ts";

interface ValidPacket {
  index: number;
  integrity: PacketIntegrity;
  sequence: number;
  sampleRate: number;
  frames: number;
  timestampUs: number | null;
  corruptBefore: number;
  repairedChannels: number;
  rejectedBefore: Array<{ sequence: number | null; reason: string }>;
}

function initialState(): AlgorithmState {
  return {
    revision: 0,
    status: "idle",
    lastSequence: null,
    lastSampleRate: null,
    lastPacketFrames: null,
    packetsAccepted: 0,
    packetsRejected: 0,
    packetsConcealed: 0,
    gapsRepaired: 0,
    framesEmitted: 0,
    framesConcealed: 0,
    framesMuted: 0,
    corruptChannelsRepaired: 0,
    rateTransitions: 0,
    lastClassification: null,
    lastMethod: null,
    lastEvent: "idle"
  };
}

function cloneState(state: AlgorithmState): AlgorithmState {
  return { ...state };
}

function frameCount(packet: AudioPacket): number {
  return packet.channels.length > 0 ? packet.channels[0].length : 0;
}

function packetDurationUs(valid: ValidPacket): number {
  return valid.sampleRate > 0 ? valid.frames / valid.sampleRate * 1_000_000 : 0;
}

function nominalGapFrames(
  previous: ValidPacket,
  current: ValidPacket,
  units: number
): number {
  const durationSec = previous.sampleRate > 0
    ? previous.frames / previous.sampleRate
    : 0;
  return Math.max(0, Math.round(units * durationSec * current.sampleRate));
}

function timelineGapFrames(previous: ValidPacket, current: ValidPacket): number | null {
  if (previous.timestampUs === null || current.timestampUs === null) return null;
  const gapUs = current.timestampUs - (previous.timestampUs + packetDurationUs(previous));
  if (gapUs <= 0) return null;
  return Math.max(0, Math.round(gapUs * current.sampleRate / 1_000_000));
}

export function repairPackets(
  packets: readonly AudioPacket[],
  overrides: Partial<ConcealmentOptions> = {}
): RepairReport {
  const options = resolveOptions(overrides);
  const state = initialState();
  const events: RepairEvent[] = [];
  const intervals: ConcealmentInterval[] = [];
  const output: AudioPacket[] = [];
  const valid: ValidPacket[] = [];
  let elapsedSec = 0;
  let pendingRejected: Array<{ sequence: number | null; reason: string }> = [];

  const pushEvent = (
    event: Omit<RepairEvent, "state">,
    patch: Partial<AlgorithmState> = {}
  ): void => {
    Object.assign(state, patch);
    state.revision += 1;
    state.lastEvent = event.message;
    events.push({ ...event, state: cloneState(state) });
  };

  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index];
    const integrity = inspectPacket(packet, options);
    const repairedChannels = integrity.diagnostics.filter(
      (diagnostic) => diagnostic.status === "copied" || diagnostic.status === "rebuilt"
    ).length;
    if (!integrity.usable) {
      pendingRejected.push({
        sequence: Number.isFinite(packet.sequence) ? packet.sequence : null,
        reason: integrity.reason
      });
      continue;
    }
    valid.push({
      index,
      integrity,
      sequence: packet.sequence,
      sampleRate: packet.sampleRate,
      frames: integrity.channels[0]?.length ?? frameCount(packet),
      timestampUs: Number.isFinite(packet.timestampUs) ? packet.timestampUs ?? null : null,
      corruptBefore: pendingRejected.length,
      repairedChannels,
      rejectedBefore: pendingRejected
    });
    pendingRejected = [];
  }

  let previousValid: ValidPacket | null = null;
  for (const current of valid) {
    const currentFrameCount = current.frames;
    if (current.sampleRate <= 0 || currentFrameCount <= 0) continue;
    for (const rejected of current.rejectedBefore) {
      pushEvent({
        atSec: elapsedSec,
        kind: "corrupt-packet",
        sequence: rejected.sequence,
        message: `Packet ${rejected.sequence ?? "?"} rejected: ${rejected.reason}`
      }, { status: "resyncing", packetsRejected: state.packetsRejected + 1 });
    }
    if (current.repairedChannels > 0) {
      pushEvent({
        atSec: elapsedSec,
        kind: "channel-repaired",
        sequence: current.sequence,
        message: `Packet ${current.sequence}: ${current.repairedChannels} channel(s) repaired`
      }, {
        corruptChannelsRepaired:
          state.corruptChannelsRepaired + current.repairedChannels
      });
    }

    if (previousValid && current.sequence <= previousValid.sequence) {
      pushEvent({
        atSec: elapsedSec,
        kind: "resync",
        sequence: current.sequence,
        message: `Out-of-order packet ${current.sequence} ignored`
      }, { status: "resyncing", packetsRejected: state.packetsRejected + 1 });
      continue;
    }

    if (previousValid) {
      const rateChanged = current.sampleRate !== previousValid.sampleRate;
      const sequenceGap = Math.max(0, current.sequence - previousValid.sequence - 1);
      const units = Math.max(sequenceGap, current.corruptBefore);
      const nominal = nominalGapFrames(previousValid, current, Math.max(1, units));
      const timeline = timelineGapFrames(previousValid, current);
      const threshold = Math.max(1, Math.round(nominal * 0.35));
      let gapFrames = 0;
      if (units > 0) {
        gapFrames = timeline !== null && Math.abs(timeline - nominal) <= threshold
          ? timeline
          : nominal;
      } else if (timeline !== null && timeline > threshold) {
        gapFrames = timeline;
      }

      if (rateChanged && gapFrames === 0) {
        pushEvent({
          atSec: elapsedSec,
          kind: "rate-change",
          sequence: current.sequence,
          message: `Sample rate ${previousValid.sampleRate} -> ${current.sampleRate} Hz`
        }, { rateTransitions: state.rateTransitions + 1, lastSampleRate: current.sampleRate });
      }

      if (gapFrames > 0) {
        const stateBefore = cloneState(state);
        const preChannels = rateChanged
          ? resampleChannels(previousValid.integrity.channels,
              previousValid.sampleRate, current.sampleRate)
          : previousValid.integrity.channels;
        const analysis = analyzeGap({
          preChannels,
          postChannels: current.integrity.channels,
          sampleRate: current.sampleRate,
          options,
          rateChanged
        });
        const classification = classifyGap(analysis, options, rateChanged);
        const concealed = concealGap({
          preChannels,
          postChannels: current.integrity.channels,
          frames: gapFrames,
          sampleRate: current.sampleRate,
          classification,
          analysis,
          options
        });
        const missingPackets = Math.max(
          sequenceGap,
          current.corruptBefore,
          Math.max(1, Math.ceil(gapFrames / Math.max(1, currentFrameCount)))
        );
        const startSequence = previousValid.sequence + 1;
        const endSequence = Math.max(startSequence, current.sequence - 1);
        const interval: ConcealmentInterval = {
          id: `gap-${startSequence}-${endSequence}`,
          startSequence,
          endSequence,
          missingPackets,
          outputSequence: previousValid.sequence + 0.5,
          sampleRate: current.sampleRate,
          frames: gapFrames,
          startTimeSec: elapsedSec,
          endTimeSec: elapsedSec + gapFrames / current.sampleRate,
          classification,
          method: concealed.method,
          analysis,
          transitions: concealed.transitions,
          channels: current.integrity.diagnostics,
          corruptPackets: current.corruptBefore,
          sampleRateChange: rateChanged,
          stateBefore,
          stateAfter: cloneState(state)
        };
        output.push({
          sequence: previousValid.sequence + 0.5,
          sampleRate: current.sampleRate,
          channels: concealed.channels,
          origin: "concealed"
        });
        elapsedSec += gapFrames / current.sampleRate;
        Object.assign(state, {
          status: "concealing",
          lastClassification: classification,
          lastMethod: concealed.method,
          packetsConcealed: state.packetsConcealed + 1,
          gapsRepaired: state.gapsRepaired + 1,
          framesEmitted: state.framesEmitted + gapFrames,
          framesConcealed: state.framesConcealed + gapFrames,
          framesMuted: state.framesMuted + concealed.transitions.mutedFrames,
          rateTransitions: state.rateTransitions + (rateChanged ? 1 : 0),
          lastSampleRate: current.sampleRate,
          lastPacketFrames: currentFrameCount
        });
        intervals.push(interval);
        pushEvent({
          atSec: interval.startTimeSec,
          kind: "gap-repaired",
          sequence: previousValid.sequence + 0.5,
          message: `Gap ${interval.id}: ${classification} via ${concealed.method}`
        });
        interval.stateAfter = cloneState(state);
      } else if (units > 0) {
        pushEvent({
          atSec: elapsedSec,
          kind: "resync",
          sequence: current.sequence,
          message: `Gap before ${current.sequence} could not be timed`
        }, { status: "resyncing" });
      }
    }

    output.push({
      sequence: current.sequence,
      sampleRate: current.sampleRate,
      channels: current.integrity.channels.map((channel) => channel.slice()),
      timestampUs: current.timestampUs ?? undefined,
      origin: "received"
    });
    elapsedSec += currentFrameCount / current.sampleRate;
    Object.assign(state, {
      status: "tracking",
      lastSequence: current.sequence,
      lastSampleRate: current.sampleRate,
      lastPacketFrames: currentFrameCount,
      packetsAccepted: state.packetsAccepted + 1,
      framesEmitted: state.framesEmitted + currentFrameCount,
      lastEvent: `Accepted packet ${current.sequence}`
    });
    state.revision += 1;
    events.push({
      atSec: elapsedSec,
      kind: "packet",
      sequence: current.sequence,
      message: `Accepted packet ${current.sequence}`,
      state: cloneState(state)
    });
    previousValid = current;
  }

  for (const rejected of pendingRejected) {
    pushEvent({
      atSec: elapsedSec,
      kind: "corrupt-packet",
      sequence: rejected.sequence,
      message: `Packet ${rejected.sequence ?? "?"} rejected: ${rejected.reason}`
    }, { status: "resyncing", packetsRejected: state.packetsRejected + 1 });
  }

  state.status = "complete";
  state.lastEvent = "complete";
  state.revision += 1;
  events.push({
    atSec: elapsedSec,
    kind: "complete",
    sequence: state.lastSequence,
    message: `Complete: ${intervals.length} gap(s), ${state.framesConcealed} concealed frame(s)`,
    state: cloneState(state)
  });

  const stats: RepairStats = {
    inputPackets: packets.length,
    outputPackets: output.length,
    acceptedPackets: state.packetsAccepted,
    rejectedPackets: state.packetsRejected,
    gaps: intervals.length,
    consecutiveLossGaps: intervals.filter((interval) => interval.missingPackets > 1).length,
    missingPackets: intervals.reduce((sum, interval) => sum + interval.missingPackets, 0),
    repairedFrames: state.framesConcealed,
    mutedFrames: state.framesMuted,
    rateTransitions: state.rateTransitions,
    corruptChannels: state.corruptChannelsRepaired,
    durationSec: elapsedSec
  };

  return {
    packets: output,
    intervals,
    events,
    state: cloneState(state),
    stats
  };
}
