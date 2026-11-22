import assert from "node:assert/strict";
import test from "node:test";
import { activeCueAt, parseSubtitle, parseTimecode, splitSentences, timeSentences } from "../shared/cues.js";
import { approximateMeasure, layoutSubtitle } from "../shared/layout.js";
import { DEFAULT_STYLE, PRESETS } from "../shared/presets.js";
import { frameTimestamp, validateFrameTimings } from "../shared/timeline.js";
import type { SubtitleCue } from "../shared/types.js";

const SRT = `1
00:00:04,600 --> 00:00:08,400
再逐项排除干扰。保留可复核的证据链。

2
00:00:08,800 --> 00:00:12,600
逐帧对齐，让字幕与原始音轨同步落位。`;

test("parses SRT timecodes into exact microseconds", () => {
  assert.equal(parseTimecode("00:00:04,600"), 4_600_000);
  assert.equal(parseTimecode("01:02:03.045"), 3_723_045_000);
  assert.equal(parseTimecode("02:03.500"), 123_500_000);
});

test("keeps sentence punctuation and allocates the complete cue duration", () => {
  assert.deepEqual(splitSentences("先找变量。再排除干扰！"), ["先找变量。", "再排除干扰！"]);
  const sentences = timeSentences("先找变量。再排除干扰！", 1_000_000, 5_000_000);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].startUs, 1_000_000);
  assert.equal(sentences[0].endUs, sentences[1].startUs);
  assert.equal(sentences.at(-1)?.endUs, 5_000_000);
});

test("subtitle boundaries are end-exclusive and never shifted by a frame", () => {
  const document = parseSubtitle(SRT);
  assert.equal(document.cues.length, 2);
  assert.equal(activeCueAt(document.cues, 4_566_000), null);
  assert.equal(activeCueAt(document.cues, 4_600_000)?.id, "1");
  assert.equal(activeCueAt(document.cues, 8_399_999)?.id, "1");
  assert.equal(activeCueAt(document.cues, 8_400_000), null);
  assert.equal(activeCueAt(document.cues, 8_800_000)?.id, "2");

  const timestamps = Array.from({ length: 300 }, (_, index) => frameTimestamp(index, { numerator: 30, denominator: 1 }));
  const check = validateFrameTimings(timestamps, document.cues, { numerator: 30, denominator: 1 });
  const range = check.cueRanges[0];
  assert.equal(range.firstFrame, 138);
  assert.equal(timestamps[range.firstFrame!], 4_600_000);
});

test("landscape and portrait keep subtitles inside independent safe areas", () => {
  const document = parseSubtitle(SRT);
  const cue = document.cues[0];
  for (const aspect of ["16:9", "9:16"] as const) {
    const preset = PRESETS[aspect];
    const layout = layoutSubtitle(
      {
        preset,
        style: DEFAULT_STYLE,
        subjectBox: null,
        placement: "auto",
        timeUs: 4_800_000,
        cue
      },
      approximateMeasure(preset.fontSize)
    );
    assert.equal(layout.visible, true);
    assert.ok(layout.lines.length >= 1 && layout.lines.length <= preset.maxLines);
    assert.ok(layout.backgroundBox.x >= preset.safe.x);
    assert.ok(layout.backgroundBox.y >= preset.safe.y);
    assert.ok(layout.backgroundBox.x + layout.backgroundBox.width <= preset.safe.x + preset.safe.width + 0.5);
    assert.ok(layout.backgroundBox.y + layout.backgroundBox.height <= preset.safe.y + preset.safe.height + 0.5);
    assert.equal(layout.warnings.includes("字幕超出安全区"), false);
  }
});

test("subject avoidance moves a lower-third subtitle away from the subject", () => {
  const cue: SubtitleCue = {
    id: "1",
    startUs: 0,
    endUs: 4_000_000,
    text: "主体占据下半区时，字幕自动上移。",
    sentences: timeSentences("主体占据下半区时，字幕自动上移。", 0, 4_000_000)
  };
  const preset = PRESETS["16:9"];
  const layout = layoutSubtitle(
    {
      preset,
      style: DEFAULT_STYLE,
      subjectBox: { x: 0.1, y: 0.36, width: 0.72, height: 0.58 },
      placement: "auto",
      timeUs: 1_000_000,
      cue
    },
    approximateMeasure(preset.fontSize)
  );
  assert.equal(layout.placement, "top");
  assert.equal(layout.subjectOverlap, 0);
});

test("active sentence styling is limited to the active run", () => {
  const document = parseSubtitle(SRT);
  const cue = document.cues[0];
  const preset = PRESETS["9:16"];
  const layout = layoutSubtitle(
    {
      preset,
      style: DEFAULT_STYLE,
      subjectBox: null,
      placement: "bottom",
      timeUs: 7_000_000,
      cue
    },
    approximateMeasure(preset.fontSize)
  );
  const runs = layout.lines.flatMap((line) => line.runs);
  assert.ok(runs.some((run) => run.active));
  assert.ok(runs.every((run) => (run.active ? run.sentenceId === layout.activeSentenceId : true)));
});
