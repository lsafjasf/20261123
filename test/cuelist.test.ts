import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCueList,
  serializeCueList,
  parseCueList,
  cueListsEqual,
  triggerSample,
  type Cue,
} from '../src/shared/cuelist.ts';
import { FRAME_RATES } from '../src/shared/timebase.ts';

function sampleCues(): Cue[] {
  return [
    { id: 'c3', frame: 96, offsetSamples: -37, sound: 'impact', gain: 0.8, label: 'ball' },
    { id: 'c1', frame: 12, offsetSamples: 0, sound: 'footstep-l', gain: 1, label: '' },
    { id: 'c2', frame: 12, offsetSamples: 5, sound: 'footstep-r', gain: 0.65432109, label: 'overlap' },
  ];
}

test('export -> import round-trips positions exactly at every frame rate', () => {
  for (const { rate } of FRAME_RATES) {
    const list = createCueList(rate, 48000);
    list.cues = sampleCues();
    const before = list.cues.map((c) => triggerSample(c, list));
    const restored = parseCueList(serializeCueList(list));
    const after = restored.cues.map((c) => triggerSample(c, restored));
    assert.deepEqual([...before].sort((x, y) => x - y), [...after].sort((x, y) => x - y));
    assert.ok(cueListsEqual(list, restored));
  }
});

test('serialization is deterministic regardless of cue order', () => {
  const a = createCueList({ num: 24, den: 1 }, 48000);
  a.cues = sampleCues();
  const b = createCueList({ num: 24, den: 1 }, 48000);
  b.cues = [...sampleCues()].reverse();
  assert.equal(serializeCueList(a), serializeCueList(b));
  // Byte-stable across repeated exports.
  assert.equal(serializeCueList(a), serializeCueList(parseCueList(serializeCueList(a))));
});

test('overlapping cues on the same frame keep distinct trigger samples', () => {
  const list = createCueList({ num: 24, den: 1 }, 48000);
  list.cues = sampleCues();
  const [c1, c2] = [list.cues[1], list.cues[2]];
  assert.equal(c1.frame, c2.frame);
  assert.notEqual(triggerSample(c1, list), triggerSample(c2, list));
  assert.equal(triggerSample(c2, list) - triggerSample(c1, list), 5);
});

test('gain is quantized so floats never break round-trip equality', () => {
  const list = createCueList({ num: 25, den: 1 }, 44100);
  list.cues = [{ id: 'g', frame: 3, offsetSamples: 0, sound: 'door-creak', gain: 0.65432109, label: '' }];
  const restored = parseCueList(serializeCueList(list));
  assert.equal(restored.cues[0].gain, 0.654321);
  assert.ok(cueListsEqual(list, restored));
});

test('parser rejects malformed documents', () => {
  assert.throws(() => parseCueList('{"format":"other"}'), SyntaxError);
  const list = createCueList({ num: 24, den: 1 }, 48000);
  list.cues = sampleCues();
  const doc = JSON.parse(serializeCueList(list));
  doc.cues[0].frame = 1.5;
  assert.throws(() => parseCueList(JSON.stringify(doc)), SyntaxError);
  doc.cues[0].frame = 12;
  doc.cues[0].offsetSamples = 0.25;
  assert.throws(() => parseCueList(JSON.stringify(doc)), SyntaxError);
});

test('trigger sample combines frame base and fine offset', () => {
  const list = createCueList({ num: 24, den: 1 }, 48000); // 2000 samples/frame
  const cue: Cue = { id: 'x', frame: 10, offsetSamples: -450, sound: 'impact', gain: 1, label: '' };
  assert.equal(triggerSample(cue, list), 20000 - 450);
});
