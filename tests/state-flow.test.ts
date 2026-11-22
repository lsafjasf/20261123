import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState, reduce } from "../src/ui/state.ts";
import { buildDemoTrack } from "../src/audio/demo.ts";
import { detectBeats } from "../src/audio/dsp.ts";
import { DEFAULT_VAD, detectSpeech } from "../src/core/speech.ts";
import { buildCutRows, toCsv } from "../src/core/cutlist.ts";
import { renderFrame, RENDER_WIDTH, RENDER_HEIGHT } from "../src/ui/canvas-render.ts";
import { formatTimecode } from "../src/core/timeline.ts";
import type { Project } from "../src/core/types.ts";

function loadDemoProject(): { project: Project; waveform: Float32Array } {
  const demo = buildDemoTrack();
  const view = new DataView(demo.wav.buffer, demo.wav.byteOffset);
  const frameCount = view.getUint32(40, true) / 4;
  const pcm = new Float32Array(frameCount);
  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    const left = view.getInt16(offset, true) / 0x8000;
    const right = view.getInt16(offset + 2, true) / 0x8000;
    pcm[i] = (left + right) / 2;
    offset += 4;
  }
  const project: Project = {
    clips: demo.clips,
    beats: detectBeats(pcm, demo.sampleRate),
    cuts: [],
    speech: detectSpeech(pcm, demo.sampleRate, DEFAULT_VAD),
    duration: demo.durationSec,
  };
  return { project, waveform: pcm.slice(0, 1600) };
}

/** 最小 Canvas 2D 桩，只记录被调用的方法不报错。 */
function makeCanvasStub(): HTMLCanvasElement {
  const noop = () => undefined;
  const callable = (): void => undefined;
  const base = {
    createLinearGradient: () => ({ addColorStop: noop }) as unknown as CanvasGradient,
  };
  const ctx = new Proxy(base, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      return new Proxy(callable, {
        get: () => noop,
        apply: () => undefined,
      });
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    width: RENDER_WIDTH,
    height: RENDER_HEIGHT,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

test("完整流程：载入 → 规划 → 拖动隔离 → 校验 → 切点表", () => {
  const { project, waveform } = loadDemoProject();
  let state = initialState();
  state = reduce(state, { type: "load", project, waveform });

  assert.equal(state.project.clips.length, 8);
  assert.equal(state.project.cuts.length, 9);
  assert.ok(state.project.beats.length > 20);
  assert.equal(state.project.speech.length, 2);
  assert.equal(state.issues.length, 0, "初始规划不应切断说话");

  // 模拟把某个内部切点强行拖进说话区间，验证校验能抓到。
  const speechStart = state.project.speech[0].start;
  const target = state.project.cuts.find(
    (cut) => cut.leftClipId !== null && cut.rightClipId !== null,
  )!;
  const untouched = state.project.cuts
    .filter((cut) => cut.id !== target.id)
    .map((cut) => ({ id: cut.id, time: cut.time }));

  state = reduce(state, { type: "drag-cut", cutId: target.id, requestedTime: speechStart + 0.5 });
  const moved = state.project.cuts.find((cut) => cut.id === target.id)!;
  assert.equal(moved.manual, true);
  for (const snapshot of untouched) {
    const other = state.project.cuts.find((cut) => cut.id === snapshot.id)!;
    assert.equal(other.time, snapshot.time, "其他切点不得联动");
  }
  assert.ok(state.issues.some((issue) => issue.kind === "speech-split"));

  // 重新规划后手动切点保留，其余仍满足约束。
  state = reduce(state, { type: "replan" });
  const retained = state.project.cuts.find((cut) => cut.id === target.id)!;
  assert.equal(retained.manual, true);
  assert.equal(retained.time, moved.time);

  // 切点表内容与时间格式。
  const rows = buildCutRows(state.project.cuts, state.project.speech);
  assert.equal(rows.length, 9);
  const csv = toCsv(rows);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("speech_safe"));
  assert.match(formatTimecode(125.4), /^\d{2}:\d{2}\.\d{3}$/);
});

test("renderFrame 在 Canvas 桩上不抛错并覆盖 8 段", () => {
  const { project } = loadDemoProject();
  const canvas = makeCanvasStub();
  const samples = [0.5, 5, 9, 13, 17, 21, 25, 30];
  for (const time of samples) {
    assert.doesNotThrow(() =>
      renderFrame(canvas, time, {
        clips: project.clips,
        beats: project.beats,
        cuts: project.cuts,
      }),
    );
  }
});

test("强弱与最短停留设置会重新规划且保持约束", () => {
  const { project, waveform } = loadDemoProject();
  let state = initialState();
  state = reduce(state, { type: "load", project, waveform });
  state = reduce(state, { type: "set-weight", clipId: project.clips[0].id, weight: "weak" });
  assert.equal(state.project.clips[0].weight, "weak");
  state = reduce(state, { type: "set-min-duration", clipId: project.clips[1].id, seconds: 3 });
  const cut = state.project.cuts.find((item) => item.rightClipId === project.clips[1].id)!;
  const prev = state.project.cuts[state.project.cuts.indexOf(cut) - 1];
  assert.ok(cut.time - prev.time >= 3 - 1e-6);
  state = reduce(state, { type: "set-in-point", clipId: project.clips[2].id, inPoint: 2.5 });
  assert.equal(state.project.clips[2].source.inPoint, 2.5);
});
