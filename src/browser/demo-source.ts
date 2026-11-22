import { PcmSource } from "../core/pcm-source.ts";

function sine(
  frequency: number,
  timeSeconds: number,
  phase = 0,
): number {
  return Math.sin(2 * Math.PI * frequency * timeSeconds + phase);
}

function marker(timeSeconds: number): number {
  const beat = timeSeconds % 0.5;
  if (beat > 0.012) {
    return 0;
  }
  const envelope = Math.exp(-beat * 260);
  return Math.sin(2 * Math.PI * 1_760 * timeSeconds) * envelope * 0.12;
}

export function createDemoSource(
  durationSeconds = 18,
  sampleRate = 48_000,
): PcmSource {
  const frameCount = Math.round(durationSeconds * sampleRate);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    const fade = Math.min(1, time / 0.05, (durationSeconds - time) / 0.15);
    const pulse = marker(time);
    left[frame] =
      fade *
      (0.16 * sine(220, time) +
        0.045 * sine(440, time, Math.PI / 5) +
        pulse);
    right[frame] =
      fade *
      (0.16 * sine(330, time, Math.PI / 7) +
        0.04 * sine(660, time, Math.PI / 3) -
        pulse * 0.7);
  }
  return new PcmSource([
    {
      startFrame: 0,
      frameCount,
      sampleRate,
      channelCount: 2,
      channels: [left, right],
    },
  ]);
}
