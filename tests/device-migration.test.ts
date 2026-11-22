import assert from "node:assert/strict";
import test from "node:test";
import {
  ZERO,
  compare,
  equals,
  floorFraction,
  fraction,
  lessThan,
} from "../src/core/fraction.ts";
import { PlaybackController } from "../src/core/playback-controller.ts";
import type { EmittedBlock } from "./helpers/fake-sink.ts";
import {
  FakeSinkFactory,
  format,
  makeSource,
} from "./helpers/fake-sink.ts";

function assertContiguous(blocks: readonly EmittedBlock[]): void {
  let cursor = ZERO;
  for (const block of blocks) {
    assert.ok(
      equals(block.start, cursor),
      `expected contiguous block at ${cursor.numerator}/${cursor.denominator}, got ${block.start.numerator}/${block.start.denominator}`,
    );
    assert.ok(block.end.numerator > block.start.numerator || block.end.denominator < block.start.denominator);
    cursor = block.end;
  }
}

function assertSameRateValues(
  block: EmittedBlock,
  sourceStartFrame: number,
  sourceChannelCount: number,
): void {
  const firstFrame = floorFraction(block.start);
  for (let channel = 0; channel < block.channels.length; channel += 1) {
    for (let frame = 0; frame < block.channels[channel].length; frame += 1) {
      const expected = sourceStartFrame + firstFrame + frame + channel * 0.25;
      assert.equal(
        block.channels[channel][frame],
        expected,
        `sample mismatch at frame ${firstFrame + frame}, channel ${channel}`,
      );
    }
  }
  assert.ok(sourceChannelCount >= block.channels.length);
}

function makeController(
  source = makeSource(30_000),
): { controller: PlaybackController; factory: FakeSinkFactory; source: ReturnType<typeof makeSource> } {
  const factory = new FakeSinkFactory(source);
  const controller = new PlaybackController({
    durationFrames: source.durationFrames,
    sampleRate: source.sampleRate,
    sinkFactory: factory,
  });
  return { controller, factory, source };
}

test("headphone to speaker switch emits every source frame exactly once", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(4_800);

  await controller.switchDevice(format("speakers", 48_000, 2));
  const speakers = factory.latest;
  speakers.advance(4_800);

  const blocks = [...headphones.emitted, ...speakers.emitted];
  assertContiguous(blocks);
  assert.equal(floorFraction(blocks.at(-1)!.end), 9_600);
  assertSameRateValues(blocks[0], 0, 2);
  assertSameRateValues(blocks[1], 0, 2);
  assert.ok(headphones.closed);
  assert.ok(!speakers.closed);
});

test("sample-rate and channel-layout change preserves the fractional source cursor", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(1_001);

  const switched = await controller.switchDevice(
    format("speakers", 44_100, 1),
    "sample-rate-change",
  );
  const speakers = factory.latest;
  speakers.advance(4_410);

  assert.equal(switched.status, "playing");
  assert.ok(equals(speakers.openedAt[0], fraction(1_001)));
  assert.equal(headphones.emitted.length, 1);
  assert.equal(speakers.emitted.length, 1);
  assert.ok(equals(speakers.emitted[0].start, fraction(1_001)));
  assert.ok(equals(speakers.emitted[0].end, fraction(5_801)));
  assertContiguous([...headphones.emitted, ...speakers.emitted]);
});

test("paused device switch keeps the paused frame and resumes without replay", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(1_234);
  const paused = await controller.pause();
  assert.equal(paused.status, "paused");
  assert.ok(equals(paused.position, fraction(1_234)));

  const switched = await controller.switchDevice(format("speakers", 44_100, 1));
  const speakers = factory.latest;
  assert.equal(switched.status, "paused");
  assert.ok(!switched.resumeIntent);
  assert.ok(equals(switched.position, fraction(1_234)));
  assert.ok(equals(speakers.openedAt[0], fraction(1_234)));

  speakers.advance(200);
  assert.equal(speakers.emitted.length, 0);
  await controller.play();
  speakers.advance(200);
  assert.equal(speakers.emitted.length, 1);
  assert.ok(equals(speakers.emitted[0].start, fraction(1_234)));
});

test("device loss keeps a recoverable position and resumes on a new device", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(2_000);
  controller.acceptPositionUpdate({
    sink: headphones,
    snapshot: headphones.currentSnapshot(),
  });

  const interrupted = await controller.deviceLost();
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recoverable, true);
  assert.equal(interrupted.resumeIntent, true);
  assert.equal(interrupted.device, null);
  assert.ok(equals(interrupted.position, fraction(2_000)));

  const recovered = await controller.recover(format("speakers", 48_000, 2));
  const speakers = factory.latest;
  assert.equal(recovered.status, "playing");
  assert.equal(recovered.recoverable, false);
  assert.ok(equals(speakers.openedAt[0], fraction(2_000)));
  speakers.advance(300);
  assert.ok(equals(speakers.emitted[0].start, fraction(2_000)));
  assertContiguous([...headphones.emitted, ...speakers.emitted]);
});

test("seek while playing discards every queued frame from the old position", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(500);

  const sought = await controller.seek(fraction(3_000));
  assert.equal(sought.status, "playing");
  headphones.advance(100);

  assert.equal(headphones.emitted.length, 2);
  assert.ok(equals(headphones.emitted[1].start, fraction(3_000)));
  assert.ok(equals(headphones.emitted[1].end, fraction(3_100)));
  for (const block of headphones.emitted) {
    assert.ok(
      compare(block.end, fraction(500)) <= 0 ||
        compare(block.start, fraction(3_000)) >= 0,
      "a stale block from the skipped region was rendered",
    );
  }
});

test("seek during a device handoff wins over the captured old cursor", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(400);

  let releaseHandoff: (() => void) | undefined;
  let markHandoffStarted: (() => void) | undefined;
  const handoffStarted = new Promise<void>((resolve) => {
    markHandoffStarted = resolve;
  });
  headphones.handoffGate = new Promise<void>((resolve) => {
    releaseHandoff = resolve;
  });
  headphones.handoffStarted = () => markHandoffStarted?.();

  const switching = controller.switchDevice(format("speakers", 44_100, 2));
  await handoffStarted;
  const seeking = controller.seek(fraction(2_000));
  releaseHandoff?.();
  await Promise.all([switching, seeking]);

  const speakers = factory.latest;
  assert.ok(equals(speakers.openedAt[0], fraction(2_000)));
  speakers.advance(441);
  assert.equal(speakers.emitted.length, 1);
  assert.ok(equals(speakers.emitted[0].start, fraction(2_000)));
  assert.ok(equals(headphones.emitted[0].end, fraction(400)));
  assert.ok(lessThan(headphones.emitted[0].end, speakers.emitted[0].start));
});

test("device loss while paused stays paused and recovers at the same frame", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(900);
  const paused = await controller.pause();
  assert.ok(equals(paused.position, fraction(900)));

  const lost = await controller.deviceLost();
  assert.equal(lost.status, "interrupted");
  assert.equal(lost.resumeIntent, false);
  assert.ok(equals(lost.position, fraction(900)));

  const recovered = await controller.recover(format("speakers", 44_100, 2));
  assert.equal(recovered.status, "paused");
  assert.ok(equals(recovered.position, fraction(900)));
  assert.ok(equals(factory.latest.openedAt[0], fraction(900)));
});

test("failed migration leaves a recoverable snapshot at the handoff frame", async () => {
  const { controller, factory } = makeController();
  await controller.open(format("headphones", 48_000, 2));
  await controller.play();
  const headphones = factory.latest;
  headphones.advance(700);
  controller.acceptPositionUpdate({
    sink: headphones,
    snapshot: headphones.currentSnapshot(),
  });

  factory.failNextOpen = true;
  const failed = await controller.switchDevice(format("speakers", 44_100, 2));
  assert.equal(failed.status, "interrupted");
  assert.equal(failed.recoverable, true);
  assert.equal(failed.resumeIntent, true);
  assert.ok(equals(failed.position, fraction(700)));

  const recovered = await controller.recover(format("speakers", 44_100, 2));
  assert.equal(recovered.status, "playing");
  assert.ok(equals(recovered.position, fraction(700)));
  factory.latest.advance(200);
  assert.ok(equals(factory.latest.emitted[0].start, fraction(700)));
});
