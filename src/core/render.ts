import type { AudioPacket, RepairReport } from "./types.ts";
import { resampleChannels } from "./dsp.ts";

export interface RenderedAudio {
  channels: Float32Array[];
  sampleRate: number;
  durationSec: number;
}

export function renderPackets(
  packets: readonly AudioPacket[],
  targetRate = 48000,
  muteConcealed = false
): RenderedAudio {
  const channelCount = Math.max(1, ...packets.map((packet) => packet.channels.length));
  const chunks: Float32Array[][] = [];
  let totalFrames = 0;

  for (const packet of packets) {
    if (packet.channels.length === 0 || packet.channels[0].length === 0 ||
        packet.sampleRate <= 0) continue;
    const frames = packet.channels[0].length;
    const targetFrames = Math.max(1, Math.round(frames * targetRate / packet.sampleRate));
    const channels = Array.from({ length: channelCount }, (_, channel) => {
      const source = packet.channels[Math.min(channel, packet.channels.length - 1)];
      if (muteConcealed && packet.origin === "concealed") {
        return new Float32Array(targetFrames);
      }
      const resampled = resampleChannels([source], packet.sampleRate, targetRate)[0];
      if (resampled.length === targetFrames) return resampled;
      const normalized = new Float32Array(targetFrames);
      normalized.set(resampled.subarray(0, targetFrames));
      return normalized;
    });
    chunks.push(channels);
    totalFrames += channels[0].length;
  }

  const output = Array.from({ length: channelCount }, () => new Float32Array(totalFrames));
  let offset = 0;
  for (const channels of chunks) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      output[channel].set(channels[channel], offset);
    }
    offset += channels[0].length;
  }
  return {
    channels: output,
    sampleRate: targetRate,
    durationSec: totalFrames / targetRate
  };
}

export function renderReport(
  report: RepairReport,
  targetRate = 48000,
  muteConcealed = false
): RenderedAudio {
  return renderPackets(report.packets, targetRate, muteConcealed);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function encodeWavPcm16(
  channels: readonly Float32Array[],
  sampleRate: number
): Uint8Array {
  const channelCount = Math.max(1, channels.length);
  const frames = channels.length > 0
    ? Math.min(...channels.map((channel) => channel.length))
    : 0;
  const bytesPerSample = 2;
  const dataBytes = frames * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const source = channels[Math.min(channel, channels.length - 1)];
      const sample = Math.max(-1, Math.min(1, source?.[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Uint8Array(buffer);
}

export function makeWav(
  channels: readonly Float32Array[],
  sampleRate: number
): Blob {
  const wav = encodeWavPcm16(channels, sampleRate);
  return new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)], {
    type: "audio/wav"
  });
}
