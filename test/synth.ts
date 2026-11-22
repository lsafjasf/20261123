// 合成测试：房间A底噪 + 语音段，8s 处拼接到房间B底噪（电平/谱形不同），
// 14s 处复制粘贴 2s 房间A底噪，另含良性事件（停顿/换气/衣料摩擦）。
import { computeFeatures } from "../src/features.ts";
import { detectBoundaries } from "../src/detect.ts";

const sr = 44100;
const dur = 20;
const n = sr * dur;
const pcm = new Float32Array(n);

function noiseTone(level: number, color: number, seed: number): () => number {
  let s = seed;
  let lp = 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const w = s / 0x40000000 - 1;
    lp += color * (w - lp);
    return lp * level;
  };
}

const toneA = noiseTone(0.012, 0.08, 42);
const toneB = noiseTone(0.05, 0.35, 777);
const speech = (t: number) =>
  (Math.sin(2 * Math.PI * 180 * t) * 0.4 + Math.sin(2 * Math.PI * 320 * t) * 0.25) *
  (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.3 * t));

const copySrc = new Float32Array(2 * sr);
{
  const t = noiseTone(0.012, 0.08, 42);
  for (let i = 0; i < n; i++) {
    const v = t();
    if (i >= 2 * sr && i < 4 * sr) copySrc[i - 2 * sr] = v;
    if (i < 8 * sr) pcm[i] = v;
  }
}
for (let i = 0; i < n; i++) {
  const t = i / sr;
  if ((t > 1 && t < 4.5) || (t > 5.5 && t < 7.8)) pcm[i] += speech(t) * 0.15;
}
{
  let s = 9;
  for (let i = Math.floor(6.0 * sr); i < Math.floor(6.3 * sr); i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    pcm[i] += (s / 0x40000000 - 1) * 0.03;
  }
}
for (let i = 8 * sr; i < n; i++) pcm[i] = toneB();
for (let i = 11 * sr; i < 11 * sr + 220; i++) {
  pcm[i] += Math.sin(2 * Math.PI * 4000 * (i / sr)) * 0.2 * Math.exp(-(i - 11 * sr) / 60);
}
for (let i = 0; i < copySrc.length; i++) pcm[14 * sr + i] = copySrc[i];

const feats = computeFeatures(pcm, sr);
const hits = detectBoundaries(feats, { sensitivity: 50, minVotes: 2 });

console.log("boundaries:");
for (const h of hits) {
  console.log(
    `  t=${h.time.toFixed(2)}s votes=${h.votes} sev=${h.severity}` +
    ` floor=${h.scores.floor.toFixed(1)} phase=${h.scores.phase.toFixed(1)}` +
    ` jump=${h.scores.jump.toFixed(1)} rep=${h.scores.repeat.toFixed(3)}` +
    (h.benign ? ` benign="${h.benign}"` : ""),
  );
}

const near = (t: number, tol = 0.3) => hits.some((h) => Math.abs(h.time - t) < tol && !h.benign);
let fail = 0;
const expect = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) fail++;
};
expect("8s 硬拼接被检出", near(8));
expect("14s 粘贴起点被检出", near(14));
expect("16s 粘贴终点被检出", near(16));
expect("5s 停顿未被判为可疑", !near(5));
expect("6.15s 换气未被判为可疑", !near(6.15));
expect("11s 衣料摩擦未被判为可疑(单通道抑制)", !near(11));
process.exit(fail ? 1 : 0);
