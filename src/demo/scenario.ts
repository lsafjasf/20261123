import type { AudioPacket } from "../core/types.ts";

export type DemoScenario =
  | "mixed"
  | "consecutive"
  | "pause"
  | "boundary"
  | "rate-change"
  | "mono-corruption";

export interface DemoStream {
  packets: AudioPacket[];
  scenario: DemoScenario;
  durationSec: number;
  rateChangeAtSec: number;
  droppedPackets: number;
  corruptedPackets: number;
}

function tone(time: number, frequencies: number[], phase = 0): number {
  let sample = 0;
  for (let index = 0; index < frequencies.length; index += 1) {
    const weight = 0.13 / (index + 1);
    sample += weight * Math.sin(2 * Math.PI * frequencies[index] * time + phase * (index + 1));
  }
  return sample;
}

function speech(time: number, fundamental: number, phase: number): number {
  const syllable = 0.55 + 0.45 * Math.pow(
    Math.max(0, Math.sin(2 * Math.PI * 3.1 * time + phase)),
    1.6
  );
  const glide = 1 + 0.035 * Math.sin(2 * Math.PI * 1.3 * time);
  const base = 2 * Math.PI * fundamental * glide * time;
  return syllable * 0.14 * (
    Math.sin(base) +
    0.46 * Math.sin(base * 2 + 0.3) +
    0.24 * Math.sin(base * 3 + 0.7)
  );
}

function sourceSample(time: number, channel: number): number {
  const phase = channel === 0 ? 0 : 0.37;
  if (time < 0.9) {
    return tone(time, [196, 294, 392], phase) * (0.78 + 0.22 * Math.sin(2 * Math.PI * 1.7 * time));
  }
  if (time < 1.18) return 0;
  if (time < 2.25) return speech(time, 155, phase);
  if (time < 3.1) {
    return tone(time, [330, 495, 660], phase) * (0.86 + 0.14 * Math.sin(2 * Math.PI * 2.3 * time));
  }
  if (time < 4.7) return speech(time, 182, phase * 1.4);
  return tone(time, [262, 392, 523], phase) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 1.2 * time));
}

function inDropWindow(scenario: DemoScenario, start: number): boolean {
  if (scenario === "consecutive") return start >= 1.46 && start < 1.7;
  if (scenario === "pause") return start >= 0.94 && start < 1.1;
  if (scenario === "boundary") return start >= 2.2 && start < 2.3;
  if (scenario === "rate-change") return start >= 4.96 && start < 5.06;
  if (scenario === "mono-corruption") return false;
  return (
    (start >= 0.94 && start < 1.02) ||
    (start >= 1.46 && start < 1.52) ||
    (start >= 2.2 && start < 2.28) ||
    (start >= 3.9 && start < 4.14) ||
    (start >= 4.98 && start < 5.04)
  );
}

function shouldCorrupt(scenario: DemoScenario, start: number): boolean {
  if (scenario === "mono-corruption") return start >= 1.84 && start < 1.88;
  if (scenario === "mixed") {
    return (start >= 1.84 && start < 1.88) || (start >= 3.58 && start < 3.62);
  }
  return false;
}

export function createDemoStream(scenario: DemoScenario = "mixed"): DemoStream {
  const rateChangeAtSec = 4.8;
  const durationSec = 6.2;
  const packets: AudioPacket[] = [];
  let time = 0;
  let sequence = 0;
  let droppedPackets = 0;
  let corruptedPackets = 0;

  while (time < durationSec) {
    const sampleRate = time < rateChangeAtSec ? 48000 : 16000;
    const frames = Math.round(sampleRate * 0.02);
    const timestampUs = Math.round(time * 1_000_000);
    const packetStart = time;
    time += frames / sampleRate;

    if (inDropWindow(scenario, packetStart)) {
      droppedPackets += 1;
      sequence += 1;
      continue;
    }

    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const sampleTime = packetStart + frame / sampleRate;
      left[frame] = sourceSample(sampleTime, 0);
      right[frame] = sourceSample(sampleTime, 1);
    }

    if (shouldCorrupt(scenario, packetStart)) {
      corruptedPackets += 1;
      if (scenario === "mono-corruption" && packetStart >= 1.86) {
        left.fill(Number.NaN);
        right.fill(Number.NaN);
      } else if (packetStart >= 3.5) {
        left.fill(Number.NaN);
      } else {
        right.fill(Number.NaN);
      }
    }

    packets.push({
      sequence,
      sampleRate,
      timestampUs,
      channels: [left, right],
      origin: "received"
    });
    sequence += 1;
  }

  return {
    packets,
    scenario,
    durationSec: time,
    rateChangeAtSec,
    droppedPackets,
    corruptedPackets
  };
}
