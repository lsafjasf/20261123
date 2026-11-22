// Minimal browser API shim: verifies the UI module graph evaluates and its
// top-level DOM wiring runs without throwing, without a real browser.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

class FakeNode {
  hidden = false;
  disabled = true;
  value = '';
  textContent = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  files: File[] = [];
  width = 800;
  height = 200;
  private handlers = new Map<string, EventListener>();
  getContext(): unknown {
    return {
      clearRect(): void {},
      fillRect(): void {},
      beginPath(): void {},
      moveTo(): void {},
      lineTo(): void {},
      stroke(): void {},
      fillText(): void {},
      strokeText(): void {},
      set fillStyle(_: string) {},
      set strokeStyle(_: string) {},
      set lineWidth(_: number) {},
      set font(_: string) {},
    };
  }
  getBoundingClientRect(): { left: number; width: number; height: number } {
    return { left: 0, width: this.width, height: this.height };
  }
  addEventListener(type: string, handler: EventListener): void {
    this.handlers.set(type, handler);
  }
  removeEventListener(): void {}
  click(): void {}
  appendChild(): void {}
  querySelector(): FakeNode {
    return new FakeNode();
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  dispatch(type: string): void {
    this.handlers.get(type)?.({ target: this } as unknown as Event);
  }
}

class FakeAudioContext {
  sampleRate = 24000;
  state: 'running' | 'suspended' = 'running';
  currentTime = 0;
  destination = {};
  createGain(): FakeNode {
    return new FakeNode();
  }
  createBuffer(channels: number, length: number): AudioBuffer {
    return {
      numberOfChannels: channels,
      length,
      sampleRate: this.sampleRate,
      getChannelData: (): Float32Array => new Float32Array(length),
      copyToChannel(): void {},
    } as unknown as AudioBuffer;
  }
  createBufferSource(): FakeNode {
    const node = new FakeNode();
    Object.assign(node, {
      connect(): void {},
      start(): void {},
      stop(): void {},
      disconnect(): void {},
    });
    return node;
  }
  createBiquadFilter(): FakeNode {
    const node = new FakeNode();
    Object.assign(node, {
      type: '',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0, setTargetAtTime(): void {} },
      connect(): FakeNode {
        return node;
      },
    });
    return node;
  }
  createDynamicsCompressor(): FakeNode {
    const node = new FakeNode();
    for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) {
      Object.assign(node, { [key]: { value: 0 } });
    }
    Object.assign(node, { connect(): FakeNode { return node; }, disconnect(): void {} });
    return node;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.state = 'suspended';
  }
}

const elements = new Map<string, FakeNode>();
const getOrCreate = (selector: string): FakeNode => {
  if (!elements.has(selector)) elements.set(selector, new FakeNode());
  return elements.get(selector)!;
};

Object.assign(globalThis, {
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
  document: {
    querySelector: (selector: string): FakeNode => getOrCreate(selector),
    querySelectorAll: (): FakeNode[] => [],
    createElement: (tag: string): FakeNode => getOrCreate(`created:${tag}`),
  },
  window: globalThis,
  Blob: class {},
  URL: {
    createObjectURL: (): string => 'blob:x',
    revokeObjectURL(): void {},
  },
});

const appUrl = pathToFileURL(resolve('src/browser/app.ts')).href;
await import(appUrl);

if (!elements.get('#model-banner')?.textContent.includes('近似模型')) {
  throw new Error('模型声明横幅未正确填充');
}
if (!elements.get('#run-analysis')?.disabled) {
  throw new Error('未加载分轨前运行按钮应处于禁用状态');
}
