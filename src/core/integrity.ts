import type { AudioPacket, ChannelDiagnostic, ConcealmentOptions } from "./types.ts";
import { channelRms, clamp } from "./dsp.ts";

export interface PacketIntegrity {
  packet: AudioPacket;
  usable: boolean;
  reason: "ok" | "empty" | "non-finite" | "repaired";
  channels: Float32Array[];
  diagnostics: ChannelDiagnostic[];
  invalidSamples: number;
}

function finiteCount(channel: Float32Array): number {
  let count = 0;
  for (const sample of channel) {
    if (Number.isFinite(sample)) count += 1;
  }
  return count;
}

function repairSamples(channel: Float32Array): { samples: Float32Array; invalid: number } {
  const output = new Float32Array(channel.length);
  let invalid = 0;
  for (let index = 0; index < channel.length; index += 1) {
    output[index] = Number.isFinite(channel[index])
      ? clamp(channel[index], -1, 1)
      : Number.NaN;
    if (!Number.isFinite(output[index])) invalid += 1;
  }
  if (invalid === channel.length) return { samples: output, invalid };

  let anchor = -1;
  for (let index = 0; index < output.length; index += 1) {
    if (Number.isFinite(output[index])) {
      anchor = index;
      break;
    }
  }
  if (anchor > 0) output.fill(output[anchor], 0, anchor);
  for (let index = 0; index < output.length; index += 1) {
    if (Number.isFinite(output[index])) {
      anchor = index;
      continue;
    }
    let next = index + 1;
    while (next < output.length && !Number.isFinite(output[next])) next += 1;
    const left = anchor >= 0 ? output[anchor] : 0;
    const right = next < output.length ? output[next] : left;
    const span = Math.max(1, next - anchor);
    output[index] = left + (right - left) * ((index - anchor) / span);
  }
  return { samples: output, invalid };
}

export function inspectPacket(
  packet: AudioPacket,
  options: ConcealmentOptions
): PacketIntegrity {
  const input = Array.isArray(packet.channels) ? packet.channels : [];
  const repaired: Array<Float32Array | null> = [];
  const validSamples: number[] = [];
  let invalidSamples = 0;

  for (const channel of input) {
    if (!(channel instanceof Float32Array) || channel.length === 0) {
      repaired.push(null);
      validSamples.push(0);
      continue;
    }
    const finite = finiteCount(channel);
    invalidSamples += channel.length - finite;
    if (finite === 0) {
      repaired.push(null);
      validSamples.push(0);
    } else {
      const result = repairSamples(channel);
      repaired.push(result.samples);
      validSamples.push(finite);
    }
  }

  const longest = Math.max(0, ...validSamples);
  if (longest === 0) {
    return {
      packet,
      usable: false,
      reason: "non-finite",
      channels: input.map(() => new Float32Array(0)),
      diagnostics: input.map((_, channel) => ({
        channel,
        status: "muted" as const,
        invalidSamples: input[channel]?.length ?? 0
      })),
      invalidSamples
    };
  }

  const targetLength = Math.max(
    ...repaired
      .filter((channel): channel is Float32Array => channel !== null && channel.length > 0)
      .map((channel) => channel.length)
  );
  if (targetLength === 0) {
    return {
      packet,
      usable: false,
      reason: "empty",
      channels: [],
      diagnostics: [],
      invalidSamples
    };
  }

  const healthyIndex = repaired.findIndex(
    (channel) => channel !== null && channel.length === targetLength
  );
  const diagnostics: ChannelDiagnostic[] = [];
  const channels: Float32Array[] = [];
  let didRepair = invalidSamples > 0;

  for (let index = 0; index < input.length; index += 1) {
    const channel = repaired[index];
    const invalid = input[index] instanceof Float32Array
      ? input[index].length - finiteCount(input[index])
      : targetLength;
    if (channel === null || channel.length !== targetLength) {
      const source = healthyIndex >= 0 ? repaired[healthyIndex] : null;
      if (source) {
        channels.push(source.slice());
        diagnostics.push({
          channel: index,
          status: "copied",
          sourceChannel: healthyIndex,
          invalidSamples: invalid
        });
      } else {
        channels.push(new Float32Array(targetLength));
        diagnostics.push({ channel: index, status: "muted", invalidSamples: invalid });
      }
      didRepair = true;
      continue;
    }
    channels.push(channel);
    if (invalid > 0) {
      diagnostics.push({ channel: index, status: "rebuilt", invalidSamples: invalid });
    } else {
      diagnostics.push({ channel: index, status: "ok" });
    }
  }

  const activeThreshold = Math.pow(10, options.silentChannelDb / 20);
  const activeChannels = channels.filter((channel) => channelRms(channel) > activeThreshold);
  if (channels.length > 1 && activeChannels.length > 0 && activeChannels.length < channels.length) {
    const sourceIndex = channels.findIndex((channel) => channelRms(channel) > activeThreshold);
    for (let index = 0; index < channels.length; index += 1) {
      if (diagnostics[index].status === "ok" &&
          channelRms(channels[index]) <= activeThreshold) {
        channels[index] = channels[sourceIndex].slice();
        diagnostics[index] = {
          channel: index,
          status: "copied",
          sourceChannel: sourceIndex,
          invalidSamples: 0
        };
        didRepair = true;
      }
    }
  }

  return {
    packet,
    usable: true,
    reason: didRepair ? "repaired" : "ok",
    channels,
    diagnostics,
    invalidSamples
  };
}
