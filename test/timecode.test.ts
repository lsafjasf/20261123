import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTimecode,
  formatTimecode,
  convertFrames,
  RATE_23976,
  RATE_25,
  RATE_2997_DF,
} from "../src/core/timecode.ts";

test("non-drop round-trip at 23.976 and 25", () => {
  for (const rate of [RATE_23976, RATE_25]) {
    for (const tc of ["00:00:00:00", "00:01:00:00", "01:00:00:00", "10:59:59:23"]) {
      assert.equal(formatTimecode(parseTimecode(tc, rate), rate), tc);
    }
  }
});

test("drop-frame skips frame numbers at minute boundaries", () => {
  assert.equal(parseTimecode("00:01:00;02", RATE_2997_DF), 1800);
  assert.equal(formatTimecode(1800, RATE_2997_DF), "00:01:00;02");
  assert.equal(parseTimecode("00:10:00;00", RATE_2997_DF), 17982);
  assert.equal(formatTimecode(17982, RATE_2997_DF), "00:10:00;00");
  assert.equal(parseTimecode("01:00:00;00", RATE_2997_DF), 107892);
  assert.equal(formatTimecode(107892, RATE_2997_DF), "01:00:00;00");
});

test("drop-frame round-trip across a full hour", () => {
  for (const f of [0, 1, 1799, 1800, 17982, 107892, 1000000]) {
    assert.equal(parseTimecode(formatTimecode(f, RATE_2997_DF), RATE_2997_DF), f);
  }
});

test("cross-rate conversion is exact", () => {
  // 86400 frames at 24000/1001 fps = 3603.6s wall clock -> 90090 frames at 25.
  assert.equal(convertFrames(86400n, RATE_23976, RATE_25), 90090n);
  // 107892 frames at 30000/1001 fps = 3599.9964s -> 90000 frames at 25.
  assert.equal(convertFrames(107892n, RATE_2997_DF, RATE_25), 90000n);
});
