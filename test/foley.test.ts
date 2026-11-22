import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CueStore } from '../src/client/foley.ts';
import { FRAME_RATES } from '../src/shared/timebase.ts';

test('generate from scene covers footsteps, impacts and door sounds', () => {
  const store = new CueStore({ num: 24, den: 1 }, 48000);
  const added = store.generateFromScene(0, 24 * 12, 24);
  assert.equal(added, store.cues.length);
  const kinds = new Set(store.cues.map((c) => c.sound));
  assert.ok(kinds.has('footstep-l') && kinds.has('footstep-r'));
  assert.ok(kinds.has('impact'));
  assert.ok(kinds.has('door-latch') && kinds.has('door-creak') && kinds.has('door-thud'));
});

test('frame range selection limits generated cues', () => {
  const store = new CueStore({ num: 24, den: 1 }, 48000);
  store.generateFromScene(0, 24 * 5, 24); // only act 1 (walking)
  assert.ok(store.cues.every((c) => c.sound.startsWith('footstep')));
  assert.equal(store.cues.length, 10);
});

test('nudging by samples and frames composes exactly', () => {
  const store = new CueStore({ num: 24, den: 1 }, 48000); // 2000 samples/frame
  const cue = store.addCue(10, 'impact');
  const base = store.triggerOf(cue);
  store.nudgeSamples(cue.id, 17);
  store.nudgeSamples(cue.id, -5);
  assert.equal(store.triggerOf(cue), base + 12);
  store.nudgeFrames(cue.id, 2);
  assert.equal(store.triggerOf(cue), base + 12 + 4000);
});

test('overlapping cues on one frame all survive export and reload', () => {
  for (const { rate } of FRAME_RATES) {
    const store = new CueStore(rate, 48000);
    store.addCue(48, 'impact', 1, 'a');
    store.addCue(48, 'door-thud', 0.5, 'b');
    const c = store.addCue(48, 'footstep-l', 0.9, 'c');
    store.nudgeSamples(c.id, 3);
    const before = store.cues.map((x) => store.triggerOf(x));
    const json = store.export();
    const reloaded = new CueStore({ num: 1, den: 1 }, 8000); // wrong on purpose
    reloaded.import(json);
    assert.deepEqual(
      reloaded.cues.map((x) => reloaded.triggerOf(x)),
      before,
      `round-trip at ${rate.num}/${rate.den}`,
    );
    assert.equal(reloaded.frameRate().num, rate.num);
    assert.ok(reloaded.verifyRoundTrip());
  }
});

test('imported cue ids never collide with new cues', () => {
  const store = new CueStore({ num: 24, den: 1 }, 48000);
  store.addCue(1, 'impact');
  const json = store.export();
  const reloaded = new CueStore({ num: 24, den: 1 }, 48000);
  reloaded.import(json);
  const fresh = reloaded.addCue(2, 'impact');
  assert.ok(!reloaded.cues.slice(0, -1).some((c) => c.id === fresh.id));
});

test('interval generation respects the selected range', () => {
  const store = new CueStore({ num: 30, den: 1 }, 48000);
  const n = store.generateInterval(10, 40, 10, 'impact');
  assert.equal(n, 4);
  assert.deepEqual(store.cues.map((c) => c.frame), [10, 20, 30, 40]);
});
