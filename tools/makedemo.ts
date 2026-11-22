// Generate a demo "interview in an empty room" WAV for the UI.
import { writeFileSync, mkdirSync } from "node:fs";
import { synthVoice, roomIr, applyReverb } from "../src/dsp/synth.ts";
import { encodeWav } from "../src/dsp/wav.ts";

const SR = 16000;
const { samples } = synthVoice(SR, 7);
const wet = applyReverb(samples, roomIr(SR));
// normalise
let peak = 0;
for (const v of wet) peak = Math.max(peak, Math.abs(v));
const out = Float32Array.from(wet, (v) => (v / peak) * 0.85);
mkdirSync("public", { recursive: true });
writeFileSync("public/demo-interview.wav", Buffer.from(encodeWav(out, SR)));
console.log(`wrote public/demo-interview.wav (${(out.length / SR).toFixed(1)}s)`);
