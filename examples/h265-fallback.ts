/**
 * Reproduces the original bug scenario: an H.265 stream on a browser whose
 * driver claims support but cannot actually open a decoder — and a second
 * run where the hardware dies mid-stream. Both recover via software.
 *
 * Run: node examples/h265-fallback.ts
 */
import { PlayerDecoder } from '../src/player.ts';
import { declaresSupportButCannotOpen, midStreamFailure } from '../src/backends/simulated.ts';
import type { EncodedPacket } from '../src/types.ts';

function makeStream(frames: number): EncodedPacket[] {
  return Array.from({ length: frames }, (_, i) => ({
    data: new Uint8Array([i]),
    timestamp: i * 33_000,
    duration: 33_000,
    isKeyframe: i % 10 === 0,
  }));
}

async function play(title: string, hardwareFactory: () => never) {
  console.log(`\n=== ${title} ===`);
  const player = new PlayerDecoder({
    hardwareFactory,
    onStateChange: ({ from, to, backendKind }) =>
      console.log(`  [${backendKind}] ${from} -> ${to}`),
    onFallback: ({ from, to, phase }) =>
      console.log(`  !! fallback ${from} -> ${to} (phase: ${phase})`),
  });
  await player.open({ codec: 'h265', width: 1920, height: 1080, preferHardware: true });
  for (const packet of makeStream(6)) {
    const frame = await player.decode(packet);
    console.log(`  frame ts=${frame.timestamp} via ${frame.source}`);
  }
  await player.release();
  console.log('  released cleanly, page still alive');
}

await play('driver declares H.265 but cannot open', declaresSupportButCannotOpen as never);
await play('hardware decodes 3 frames then hangs', (() => midStreamFailure(3)) as never);
