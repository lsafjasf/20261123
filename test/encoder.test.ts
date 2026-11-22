import test from "node:test";
import assert from "node:assert/strict";
import { makeProject } from "./helpers.ts";
import { buildPlans } from "../src/shared/timeline.ts";
import { renderFrame, type LoadedImage, type RenderContext } from "../src/web/renderer.ts";
import type { AudioBundle } from "../src/web/audio.ts";
import { parseElement, sameId, idBytes, walkElements } from "../src/shared/ebml.ts";
import { CLUSTER, SEGMENT, SIMPLE_BLOCK, TRACKS } from "../src/shared/webm-ids.ts";

class FakeChunk {
  readonly byteLength: number;
  readonly timestamp: number;
  readonly type: "key" | "delta";
  private readonly payload: Uint8Array;

  constructor(timestamp: number, type: "key" | "delta", payload: Uint8Array) {
    this.timestamp = timestamp;
    this.type = type;
    this.payload = payload;
    this.byteLength = payload.byteLength;
  }

  copyTo(destination: Uint8Array): void {
    destination.set(this.payload);
  }
}

class FakeEncoder {
  encodeQueueSize = 0;
  protected chunks: FakeChunk[] = [];
  private readonly output: (chunk: FakeChunk) => void;
  constructor(output: (chunk: FakeChunk) => void) {
    this.output = output;
  }
  protected emit(chunk: FakeChunk): void {
    this.chunks.push(chunk);
    this.output(chunk);
  }
}

class FakeVideoEncoder extends FakeEncoder {
  constructor(handlers: { output: (chunk: FakeChunk) => void }) {
    super(handlers.output);
  }
  configure(): void {}
  encode(frame: { close: () => void; timestamp: number }, options?: { keyFrame?: boolean }): void {
    this.emit(new FakeChunk(frame.timestamp, options?.keyFrame ? "key" : "delta", Uint8Array.of(0x99, frame.timestamp % 251)));
    frame.close();
  }
  async flush(): Promise<void> {}
  close(): void {}
  static async isConfigSupported(): Promise<{ supported: boolean }> {
    return { supported: true };
  }
}

class FakeAudioEncoder extends FakeEncoder {
  constructor(handlers: { output: (chunk: FakeChunk) => void }) {
    super(handlers.output);
  }
  configure(): void {}
  encode(data: { close: () => void; timestamp: number }): void {
    this.emit(new FakeChunk(data.timestamp, "delta", Uint8Array.of(0xf8, 0x68)));
    data.close();
  }
  async flush(): Promise<void> {}
  close(): void {}
}

class FakeAudioData {
  readonly timestamp: number;
  constructor(init: { timestamp: number; data: Uint8Array }) {
    this.timestamp = init.timestamp;
  }
  close(): void {}
}

class FakeVideoFrame {
  readonly timestamp: number;
  constructor(_source: unknown, init: { timestamp: number }) {
    this.timestamp = init.timestamp;
  }
  close(): void {}
}

class FakeContext {
  fillStyle = "";
  globalAlpha = 1;
  imageSmoothingEnabled = false;
  imageSmoothingQuality = "low";
  fillRect(): void {}
  save(): void {}
  restore(): void {}
  drawImage(): void {}
}

function installWebCodecsShims(): void {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  globalScope.VideoEncoder = FakeVideoEncoder;
  globalScope.AudioEncoder = FakeAudioEncoder;
  globalScope.AudioData = FakeAudioData;
  globalScope.VideoFrame = FakeVideoFrame;
}

function makeRenderContext(): RenderContext {
  const project = makeProject();
  const bundle = buildPlans(project);
  const images = new Map<string, LoadedImage>();
  for (const spec of project.images) {
    images.set(spec.id, {
      bitmap: { width: spec.pixelWidth, height: spec.pixelHeight } as unknown as HTMLImageElement,
      width: spec.pixelWidth,
      height: spec.pixelHeight,
    });
  }
  return {
    ctx: new FakeContext() as unknown as CanvasRenderingContext2D,
    project,
    timeline: bundle.timeline,
    plans: bundle.plans,
    images,
  };
}

test("full export pipeline produces a parseable WebM with video and audio blocks", async () => {
  installWebCodecsShims();
  const { encodeVideo } = await import("../src/web/encoder.ts");
  const render = makeRenderContext();
  const sampleRate = 48000;
  const audio: AudioBundle = {
    sampleRate,
    channels: 2,
    length: sampleRate,
    buffer: new AudioBufferShim(sampleRate, 1),
  };
  const canvas = {} as HTMLCanvasElement;
  const result = await encodeVideo({
    project: render.project,
    canvas,
    render: (time) => renderFrame(render, time),
    durationSeconds: 1,
    audio,
  });

  assert.ok(result.bytes.byteLength > 0);
  const header = parseElement(result.bytes, 0);
  assert.ok(header);
  const segment = parseElement(result.bytes, header.dataOffset + header.dataSize);
  assert.ok(segment && sameId(segment.id, idBytes(SEGMENT)));

  let sawTracks = false;
  let clusters = 0;
  let blocks = 0;
  for (const child of walkElements(result.bytes, segment.dataOffset, segment.dataOffset + segment.dataSize)) {
    if (sameId(child.id, idBytes(TRACKS))) {
      sawTracks = true;
    }
    if (sameId(child.id, idBytes(CLUSTER))) {
      clusters += 1;
      for (const inner of walkElements(result.bytes, child.dataOffset, child.dataOffset + child.dataSize)) {
        if (sameId(inner.id, idBytes(SIMPLE_BLOCK))) {
          blocks += 1;
        }
      }
    }
  }
  assert.ok(sawTracks);
  assert.ok(clusters >= 1);
  assert.equal(blocks, 30 + 50);
});

class AudioBufferShim {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels = 2;
  private readonly channel: Float32Array;

  constructor(sampleRate: number, seconds: number) {
    this.sampleRate = sampleRate;
    this.length = Math.ceil(sampleRate * seconds);
    this.channel = new Float32Array(this.length);
  }

  getChannelData(): Float32Array {
    return this.channel;
  }
}
