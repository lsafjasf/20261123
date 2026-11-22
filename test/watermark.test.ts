import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  decodeSymbols,
  hamming74Decode,
  hamming74Encode
} from "../src/payload.ts";
import { createImage, cropRgba, resizeRgba } from "../src/image.ts";
import {
  detectWatermark,
  embedWatermark,
  mergeDetections
} from "../src/watermark.ts";
import type { RgbaImage } from "../src/types.ts";

function syntheticScene(width: number, height: number, seed: number): RgbaImage {
  const image = createImage(width, height);
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value =
        88 +
        54 * Math.sin((x + seed) / 68) +
        31 * Math.cos((y - seed) / 43) +
        16 * Math.sin((x + y) / 19) +
        (random() - 0.5) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value + 13;
      image.data[offset + 2] = value - 7;
      image.data[offset + 3] = 255;
    }
  }
  return image;
}

function addNoise(image: RgbaImage, amplitude: number, seed: number): RgbaImage {
  let state = seed >>> 0;
  const output = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
  for (let offset = 0; offset < output.data.length; offset += 4) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const noise = ((state >>> 8) / 16777216 - 0.5) * amplitude;
    output.data[offset] += noise;
    output.data[offset + 1] += noise;
    output.data[offset + 2] += noise;
  }
  return output;
}

test("payload round-trips with 32-bit creator IDs", () => {
  for (const id of [1, 88420719, 1234567, 4294967295]) {
    const payload = buildPayload(id);
    const decoded = decodeSymbols(payload.symbols);
    assert.equal(payload.symbols.length, 96);
    assert.equal(decoded.creatorId, id);
    assert.equal(decoded.syncMatches, 16);
    assert.equal(decoded.crcDistance, 0);
    assert.equal(decoded.correctedIdBits, 0);
  }
});

test("Hamming(7,4) corrects a single flipped bit in every codeword", () => {
  for (let nibble = 0; nibble < 16; nibble += 1) {
    const encoded = hamming74Encode(nibble);
    for (let bit = 0; bit < 7; bit += 1) {
      const damaged = encoded ^ (1 << bit);
      const decoded = hamming74Decode(damaged);
      assert.equal(decoded.nibble, nibble);
      assert.equal(decoded.corrected, true);
    }
  }
});

test("payload decoder corrects ID and CRC bit damage before verification", () => {
  const payload = buildPayload(88420719);
  const damaged = new Uint8Array(payload.symbols);
  for (let block = 0; block < 8; block += 1) {
    damaged[16 + block * 7 + (block % 7)] ^= 1;
  }
  damaged[74] ^= 1;
  const decoded = decodeSymbols(damaged);
  assert.equal(decoded.creatorId, 88420719);
  assert.equal(decoded.correctedIdBits, 8);
  assert.equal(decoded.crcDistance, 1);
});

test("detects the source ID after crop, rescale and additive compression noise", () => {
  const creatorId = 88420719;
  const watermarked = embedWatermark(syntheticScene(640, 360, 11), {
    creatorId,
    amplitude: 4.8
  });
  const cropped = cropRgba(watermarked, 73, 39, 423, 247);
  const rescaled = resizeRgba(cropped, 295, 172);
  const noisy = addNoise(rescaled, 9, 19);
  const result = detectWatermark(noisy, { sensitivity: "balanced" });

  assert.equal(result.found, true);
  assert.equal(result.creatorId, creatorId);
  assert.ok(result.confidence >= 58);
  assert.ok(result.syncMatches >= 15);
  assert.ok(result.geometry !== null);
  assert.equal(result.bitMatrix.length, 96);
});

test("does not report a hit on unmarked synthetic frames", () => {
  for (const seed of [201, 202, 203]) {
    const result = detectWatermark(syntheticScene(480, 270, seed), {
      sensitivity: "aggressive"
    });
    assert.equal(result.found, false);
    assert.equal(result.creatorId, null);
  }
});

test("cross-frame merge rejects a sequence of ordinary frames", () => {
  const detections = [211, 212, 213, 214].map((seed) =>
    detectWatermark(syntheticScene(480, 270, seed), { sensitivity: "aggressive" })
  );
  const merged = mergeDetections(detections, "aggressive");
  assert.equal(merged.found, false);
  assert.equal(merged.creatorId, null);
});

test("cross-frame evidence increases confidence for truncated clips", () => {
  const creatorId = 73194;
  const detections = [];
  for (let index = 0; index < 3; index += 1) {
    const frame = embedWatermark(syntheticScene(560, 315, 40 + index * 7), {
      creatorId,
      amplitude: 4.8
    });
    detections.push(detectWatermark(addNoise(frame, 7, 80 + index), {
      sensitivity: "balanced"
    }));
  }
  const merged = mergeDetections(detections, "balanced");
  assert.equal(merged.found, true);
  assert.equal(merged.creatorId, creatorId);
  assert.ok(merged.hits >= 2);
  assert.ok(merged.confidence >= 58);
});
