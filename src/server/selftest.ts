import { analyzeTracks, offsetAt } from "../shared/analyze.ts";
import { buildFixtures, DEFAULT_SPEC, offsetTruth } from "./fixtures.ts";
import { renderCorrected } from "../shared/render.ts";
import { gccPhat } from "../shared/gcc.ts";
import { Fft } from "../shared/fft.ts";
import { resampleLinear } from "../shared/resample.ts";

const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
  console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
}

function approx(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

const { camera, recorder } = buildFixtures();
const result = analyzeTracks(camera, recorder);

assert(result.windows.length >= 50, `produced ${result.windows.length} analysis windows`);
const silent = result.windows.filter((w) => w.kind === "silence");
const music = result.windows.filter((w) => w.kind === "music");
assert(silent.length >= 2, `silence windows detected (${silent.length})`);
assert(music.length >= 2, `music/tone windows detected (${music.length})`);
assert(silent.every((w) => w.excluded), "silence windows excluded from correlation");
assert(music.every((w) => w.excluded), "music windows excluded from correlation");
assert(result.anchors.length >= 12, `usable anchors extracted (${result.anchors.length})`);

const probeTimes = [5, 12, 24, 29, 34, 45, 55];
const errors = probeTimes.map((t) => Math.abs(offsetAt(result, t) - offsetTruth(DEFAULT_SPEC, t)));
const maxError = Math.max(...errors);
assert(maxError < 12, `piecewise offset within 12 ms of truth (max ${maxError.toFixed(2)} ms)`);

const kink = result.breakpoints.find((b) => Math.abs(b - DEFAULT_SPEC.driftKinkAtSec) < 4);
assert(kink !== undefined, `drift kink located near ${DEFAULT_SPEC.driftKinkAtSec}s (got ${kink?.toFixed(2) ?? "none"})`);
assert(result.segments.length >= 2, `segmented curve built (${result.segments.length} segments)`);

const aligned = renderCorrected(recorder, result, { targetSampleRate: camera.sampleRate });
const residual = gccPhat(
  aligned.channels[0]!.subarray(6 * 48000, 8 * 48000),
  camera.channels[0]!.subarray(6 * 48000, 8 * 48000),
  Math.round(0.02 * 48000),
);
assert(
  approx((residual.lagSamples / 48000) * 1000, 0, 3),
  `rendered track aligned within 3 ms around a clap (residual ${((residual.lagSamples / 48000) * 1000).toFixed(2)} ms)`,
);

const fft = new Fft(64);
const re = new Float64Array(64);
const im = new Float64Array(64);
re[0] = 1;
fft.forward(re, im);
fft.inverse(re, im);
assert(approx(re[0]!, 1, 1e-9) && approx(re[1]!, 0, 1e-9), "FFT round trip preserves impulse");

const mismatchedRecorder = {
  ...recorder,
  sampleRate: 44100,
  channels: [resampleLinear(recorder.channels[0]!, 48000, 44100)],
};
const mismatched = analyzeTracks(camera, mismatchedRecorder);
const mismatchError = Math.max(...[10, 25, 40, 52].map((t) => Math.abs(offsetAt(mismatched, t) - offsetTruth(DEFAULT_SPEC, t))));
assert(mismatchError < 15, `cross sample-rate analysis within 15 ms (max ${mismatchError.toFixed(2)} ms)`);
const mismatchedAligned = renderCorrected(mismatchedRecorder, mismatched, { targetSampleRate: 48000 });
assert(mismatchedAligned.sampleRate === 48000, "renderer outputs reference sample rate");
assert(
  Math.abs(mismatchedAligned.duration - camera.duration) < 0.05,
  `rendered duration matches reference (${mismatchedAligned.duration.toFixed(2)}s)`,
);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll self-test checks passed.");
