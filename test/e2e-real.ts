// 真实 MP4 端到端：解封装 -> 多段删除 -> 吸附 -> 导出 -> 写盘供 ffprobe 校验。
// 运行: node test/e2e-real.ts /tmp/real.mp4 /tmp/out.mp4
import { readFile, writeFile } from "node:fs/promises";
import { demux } from "../src/core/mp4/demux.ts";
import { buildPlan, resolveSegment } from "../src/core/edit/plan.ts";
import { buildOutput } from "../src/core/edit/export.ts";

const [src, dst] = process.argv.slice(2);
const movie = demux(new Uint8Array(await readFile(src)));
const vt = movie.tracks.find((t) => t.kind === "video")!;
const at = movie.tracks.find((t) => t.kind === "audio")!;
console.log("src:", movie.duration / movie.timescale, "s",
  "video", vt.codec, vt.timescale, vt.samples.length, "samples,",
  vt.samples.filter((s) => s.keyframe).length, "keyframes;",
  "audio", at.codec, at.timescale, at.samples.length, "frames");

// 删除 [2.4, 4.1] 与 [9.37, 11.0]：故意都落在非关键帧上
const plan = buildPlan(movie, [
  { start: 2.4, end: 4.1 },
  { start: 9.37, end: 11.0 },
]);
for (const seg of plan.segments) {
  console.log(`seg#${seg.index} [${seg.start.toFixed(3)}..${seg.end.toFixed(3)}] mode=${seg.mode}`,
    seg.snapOptions ? `snaps prev=${seg.snapOptions.prev} next=${seg.snapOptions.next}` : "",
    "|", seg.notes.join(" ; "));
}
// 全部吸附到关键帧（保持无损）：优先上一关键帧，不可用则下一关键帧
plan.segments.forEach((seg, i) => {
  if (seg.mode === "pending") {
    resolveSegment(movie, plan, i, seg.snapOptions?.prev != null ? "snap-prev" : "snap-next");
  }
});
console.log("final:", plan.finalDuration.toFixed(6), "s, fullyLossless =", plan.fullyLossless,
  ", avDrift =", (plan.avDriftMaxSec * 1000).toFixed(2), "ms");

const out = await buildOutput(movie, plan);
await writeFile(dst, out.data);
console.log("written", dst, (out.data.byteLength / 1024).toFixed(0), "KiB");
