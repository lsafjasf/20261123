import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { generate, weddingScenario } from "../src/gen.ts";
import { buildTimeline } from "../src/timeline.ts";
import { repair, rowsToCsv } from "../src/repair.ts";
import { parseMp4 } from "../src/mp4.ts";

let dir: string;
let manifest: ReturnType<typeof weddingScenario>;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wedding-e2e-"));
  manifest = weddingScenario();
  generate(manifest, dir);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (p: string) => readFileSync(join(dir, p));

test("时间线核查：检出全部注入故障", () => {
  const tl = buildTimeline(manifest, read);
  const byCam = new Map(tl.cameras.map((c) => [c.camera, c]));

  // cam1：12s 换卡空洞
  const cam1 = byCam.get("cam1-main")!;
  assert.equal(cam1.events.length, 1);
  assert.equal(cam1.events[0].kind, "GAP");
  assert.equal(cam1.events[0].duration.ticks, 12n * 90000n);

  // cam2：3s 空洞 + 1.2s 重叠 + clip002 非单调
  const cam2 = byCam.get("cam2-roam")!;
  assert.deepEqual(cam2.events.map((e) => e.kind), ["GAP", "OVERLAP"]);
  assert.equal(cam2.events[1].duration.ticks, 12n * 9000n);
  assert.ok(cam2.clips[1].nonMonotonic.length > 0);
  assert.ok(cam2.clips[1].faults.includes("NON_MONOTONIC"));

  // cam3：断电截断 + 抖动漂移
  const cam3 = byCam.get("cam3-fixed")!;
  assert.ok(cam3.clips[0].faults.includes("TRUNCATED"));
  assert.ok(cam3.clips[1].faults.includes("DRIFT"));

  // cam4：帧率误标漂移，6 分钟累计 -32367 tick（90000 刻度）
  const cam4 = byCam.get("cam4-backup")!;
  assert.ok(cam4.clips[0].faults.includes("DRIFT"));
  assert.equal(cam4.clips[0].driftTicks, -32367n);
});

test("修复：逐帧整数时间戳、零漂移、重叠裁剪", () => {
  const result = repair(manifest, read);
  assert.equal(result.outputs.length, 8);

  for (const out of result.outputs) {
    const info = parseMp4(out.bytes);
    const video = info.tracks.find((t) => t.kind === "video")!;
    // 严格单调
    for (let i = 1; i < video.samples.length; i++) {
      assert.ok(
        video.samples[i].dts > video.samples[i - 1].dts,
        `${out.path} 样本 ${i} 非单调`,
      );
    }
  }

  // cam4：第 n 帧 == 锚点 + n*3003，六分钟零漂移
  const cam4 = result.outputs.find((o) => o.path.includes("cam4"))!;
  const video = parseMp4(cam4.bytes).tracks.find((t) => t.kind === "video")!;
  const anchor = video.samples[0].dts;
  assert.equal(anchor, 90000n); // wallStart 1000ms
  for (let i = 0; i < video.samples.length; i++) {
    assert.equal(video.samples[i].dts, anchor + BigInt(i) * 3003n);
  }

  // cam2 seg003：重叠 1.2s -> 裁掉 30 个头部视频帧
  const s = result.summaries.find(
    (x) => x.camera === "cam2-roam" && x.segment === "seg003",
  )!;
  assert.equal(s.trimmedHeadSamples, 30);
  assert.equal(s.videoSamples, 1125 - 30);

  // 对照表：cam4 末帧 delta ≈ +0.3596s（漂移被收回）
  const lastRow = result.rows.find(
    (r) => r.camera === "cam4-backup" && r.track === "video" &&
      r.sampleIndex === 10788,
  )!;
  assert.equal(lastRow.deltaSeconds, "0.359600");
  // 被裁剪样本在表中且新值为空
  const trimmed = result.rows.filter((r) => r.note === "TRIMMED_OVERLAP");
  assert.ok(trimmed.length > 0);
  assert.equal(trimmed[0].newDtsTicks, "");

  // CSV 结构
  const csv = rowsToCsv(result.rows);
  assert.ok(csv.startsWith("camera,segment,track,"));
  assert.equal(csv.trim().split("\n").length, result.rows.length + 1);
});

test("修复产物可被 ffmpeg 无错解码", (t) => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    t.skip("ffmpeg 不可用");
    return;
  }
  const result = repair(manifest, read);
  for (const out of result.outputs) {
    const p = join(dir, "out", out.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, out.bytes);
    execFileSync("ffmpeg", ["-v", "error", "-i", p, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
});
