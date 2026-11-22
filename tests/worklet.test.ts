import assert from "node:assert/strict";
import test from "node:test";

interface WorkletMessage {
  readonly type: string;
  readonly requestId?: number;
  readonly generation: number;
  readonly position: number;
  readonly outputFrames: number;
}

class FakePort {
  onmessage:
    | ((event: MessageEvent<Record<string, unknown>>) => void)
    | null = null;
  readonly messages: WorkletMessage[] = [];

  postMessage(message: WorkletMessage): void {
    this.messages.push(message);
  }
}

class FakeAudioWorkletProcessor {
  readonly port = new FakePort();
}

interface ProcessorInstance {
  readonly port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorConstructor = new () => ProcessorInstance;

let ProcessorClass: ProcessorConstructor | null = null;

(globalThis as unknown as Record<string, unknown>).sampleRate = 48_000;
(globalThis as unknown as Record<string, unknown>).AudioWorkletProcessor =
  FakeAudioWorkletProcessor;
(globalThis as unknown as Record<string, unknown>).registerProcessor = (
  _name: string,
  processor: ProcessorConstructor,
) => {
  ProcessorClass = processor;
};

await import("../src/browser/pcm-player.worklet.ts");

function processor(): ProcessorInstance {
  if (ProcessorClass === null) {
    throw new Error("worklet processor was not registered");
  }
  return new ProcessorClass();
}

function send(
  target: ProcessorInstance,
  data: Record<string, unknown>,
): void {
  target.port.onmessage?.({
    data,
  } as MessageEvent<Record<string, unknown>>);
}

function runQuantum(target: ProcessorInstance): Float32Array[] {
  const output = [new Float32Array(128), new Float32Array(128)];
  target.process([], [output]);
  return output;
}

function sourceChannels(frameCount: number): Float32Array[] {
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    left[frame] = frame;
    right[frame] = frame + 1;
  }
  return [left, right];
}

test("worklet handoff fades out, reports one boundary, and resumes with fade-in", () => {
  const channels = sourceChannels(10_000);
  const first = processor();
  send(first, {
    type: "configure",
    sourceRate: 48_000,
    sourceChannels: 2,
    outputChannels: 2,
    generation: 1,
    position: 0,
  });
  send(first, { type: "append", startFrame: 0, channels });
  send(first, { type: "play", generation: 1 });

  let produced = 0;
  for (let quantum = 0; quantum < 5; quantum += 1) {
    runQuantum(first);
    produced += 128;
  }
  send(first, { type: "handoff", generation: 1, requestId: 7 });

  let snapshot: WorkletMessage | null = null;
  for (let quantum = 0; quantum < 8 && snapshot === null; quantum += 1) {
    const output = runQuantum(first);
    produced += 128;
    snapshot =
      first.port.messages.find(
        (message) => message.type === "snapshot" && message.requestId === 7,
      ) ?? null;
    if (snapshot !== null) {
      assert.equal(output[0].at(-1), 0);
    }
  }
  assert.ok(snapshot !== null);
  assert.ok(produced >= snapshot.position);
  assert.equal(snapshot.outputFrames, snapshot.position);
  const boundary = snapshot.position;

  const second = processor();
  send(second, {
    type: "configure",
    sourceRate: 48_000,
    sourceChannels: 2,
    outputChannels: 2,
    generation: 2,
    position: boundary,
  });
  send(second, { type: "append", startFrame: 0, channels });
  send(second, { type: "play", generation: 2 });

  const firstOutput = runQuantum(second);
  assert.ok(
    Math.abs(firstOutput[0][0]) < boundary * 0.01,
    "new sink must begin inside the short fade-in, not at full gain",
  );
  for (let quantum = 0; quantum < 4; quantum += 1) {
    runQuantum(second);
  }
  send(second, { type: "pause", generation: 2, requestId: 9 });
  for (let quantum = 0; quantum < 8; quantum += 1) {
    runQuantum(second);
  }
  const secondSnapshot = second.port.messages.find(
    (message) => message.type === "snapshot" && message.requestId === 9,
  );
  assert.ok(secondSnapshot !== undefined);
  assert.ok(secondSnapshot.position > boundary);
});
