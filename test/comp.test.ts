import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { segmentSentences } from "../src/shared/dsp.ts";
import { alignTakes } from "../src/shared/align.ts";
import { buildPlan, renderPlan, provenance } from "../src/shared/comp.ts";
import { decodeWav } from "../src/shared/wav.ts";

const SR = 24000;

function loadTake(n: number): Float32Array {
  const buf = readFileSync(`takes/take-${String(n).padStart(2, "0")}.wav`);
  return decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)).channels[0];
}

function setup() {
  const takes = Array.from({ length: 12 }, (_, i) => loadTake(i + 1));
  const segs = takes.map((s) => segmentSentences(s, SR));
  const aligned = alignTakes(segs, 0);
  return { takes, segs, aligned };
}

test("plan anchors every sentence to the fixed reference timeline", () => {
  const { segs, aligned } = setup();
  const choices = [0, 5, 2, 11, 3, 7];
  const plan = buildPlan(segs, aligned, 0, choices, SR, { fadeMs: 12 });
  assert.equal(plan.segments.length, 6);
  for (let i = 0; i < 6; i++) {
    const seg = plan.segments[i];
    assert.equal(seg.take, choices[i]);
    // Speech onset of the chosen take must land on the reference onset.
    const src = segs[choices[i]].sentences[seg.srcSentence];
    const dstOnset = seg.dstStart + (src.start - seg.srcIn);
    assert.ok(Math.abs(dstOnset - segs[0].sentences[i].start) < 1e-6, `sentence ${i} onset`);
    // Stays inside its slot ± half fade.
    assert.ok(seg.dstStart >= segs[0].cutPoints[i] - 0.006 - 1e-6);
    assert.ok(seg.dstEnd <= segs[0].cutPoints[i + 1] + 0.006 + 1e-6);
  }
});

test("editing one sentence leaves all other regions bit-identical", () => {
  const { takes, segs, aligned } = setup();
  const base = buildPlan(segs, aligned, 0, [0, 0, 0, 0, 0, 0], SR, { fadeMs: 12 });
  const edited = buildPlan(segs, aligned, 0, [0, 0, 4, 0, 0, 0], SR, { fadeMs: 12 });
  const a = renderPlan(takes, base);
  const b = renderPlan(takes, edited);
  assert.equal(a.length, b.length);
  const segA = base.segments[2];
  const segB = edited.segments[2];
  const fade = Math.ceil(0.012 * SR);
  // The changed region is the union of the sentence's slot in both plans ± fade.
  const lo = Math.max(0, Math.floor(Math.min(segA.dstStart, segB.dstStart) * SR) - fade);
  const hi = Math.min(a.length, Math.ceil(Math.max(segA.dstEnd, segB.dstEnd) * SR) + fade);
  for (let i = 0; i < a.length; i++) {
    if (i >= lo && i < hi) continue; // changed segment ± one fade
    assert.equal(a[i], b[i], `sample ${i} (${(i / SR).toFixed(3)}s) changed outside sentence 3`);
  }
  // And the changed region really did change.
  let diff = 0;
  for (let i = lo; i < hi; i++) diff += Math.abs(a[i] - b[i]);
  assert.ok(diff > 0.001, "expected audible difference inside edited sentence");
});

test("no clicks at joins: sample-to-sample steps stay small", () => {
  const { takes, segs, aligned } = setup();
  const plan = buildPlan(segs, aligned, 0, [0, 3, 1, 8, 2, 10], SR, { fadeMs: 12 });
  const out = renderPlan(takes, plan);
  // Worst-case click metric: max absolute step between adjacent samples.
  // Speech content here is < 5 kHz so legit steps are well under 0.2.
  let maxStep = 0;
  let maxAt = 0;
  for (let i = 1; i < out.length; i++) {
    const step = Math.abs(out[i] - out[i - 1]);
    if (step > maxStep) {
      maxStep = step;
      maxAt = i;
    }
  }
  assert.ok(maxStep < 0.2, `click-like step ${maxStep} at ${(maxAt / SR).toFixed(3)}s`);
});

test("render preserves speech energy (no silence holes)", () => {
  const { takes, segs, aligned } = setup();
  const plan = buildPlan(segs, aligned, 0, [2, 2, 2, 2, 2, 2], SR, { fadeMs: 12 });
  const out = renderPlan(takes, plan);
  for (let i = 0; i < 6; i++) {
    const refSent = segs[0].sentences[i];
    const from = Math.floor(refSent.start * SR);
    const to = Math.floor(refSent.end * SR);
    let sum = 0;
    for (let k = from; k < to; k++) sum += out[k] * out[k];
    const rms = Math.sqrt(sum / (to - from));
    assert.ok(rms > 0.02, `sentence ${i} too quiet in render: ${rms}`);
  }
});

test("provenance tracks the take of every segment", () => {
  const { segs, aligned } = setup();
  const choices = [1, 1, 5, 5, 9, 9];
  const plan = buildPlan(segs, aligned, 0, choices, SR, { fadeMs: 12 });
  const prov = provenance(plan);
  assert.deepEqual(prov.map((p) => p.take), choices);
  assert.deepEqual(prov.map((p) => p.sentence), [0, 1, 2, 3, 4, 5]);
  for (const p of prov) {
    assert.ok(p.dstEnd > p.dstStart);
    assert.ok(p.srcOut > p.srcIn);
  }
});

test("missing sentence in a take renders as a gap, others unaffected", () => {
  const { takes, segs, aligned } = setup();
  // Break take 4's alignment for sentence 2.
  const broken = aligned.map((row) => row.slice());
  broken[4][2] = -1;
  const plan = buildPlan(segs, broken, 0, [0, 0, 4, 0, 0, 0], SR, { fadeMs: 12 });
  assert.equal(plan.segments[2].srcSentence, -1);
  const out = renderPlan(takes, plan);
  const refSent = segs[0].sentences[2];
  let sum = 0;
  const from = Math.floor(refSent.start * SR);
  const to = Math.floor(refSent.end * SR);
  for (let k = from; k < to; k++) sum += Math.abs(out[k]);
  assert.ok(sum / (to - from) < 1e-4, "gap should be silent");
});
