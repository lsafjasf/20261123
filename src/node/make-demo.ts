// 生成一对可直接在网页里试听的演示录音：demo_micA.wav / demo_micB.wav
// 运行：node dist/node/make-demo.js

import { writeFileSync } from "node:fs";
import { synthScene } from "../dsp/synth.js";
import { encodeWav } from "../dsp/wav.js";

const scene = synthScene({ seed: 20261123, durationSec: 24, bleedDb: -11 });
writeFileSync("demo_micA.wav", new Uint8Array(encodeWav([scene.trackA], scene.sampleRate)));
writeFileSync("demo_micB.wav", new Uint8Array(encodeWav([scene.trackB], scene.sampleRate)));
console.log("已生成 demo_micA.wav / demo_micB.wav（24s，含抢话重叠与同时大笑，串音 -11dB）");
