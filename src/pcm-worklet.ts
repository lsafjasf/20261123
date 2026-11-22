declare const sampleRate: number;
declare const AudioWorkletProcessor: {
  new (options?: AudioWorkletNodeOptions): {
    readonly port: MessagePort;
  };
};
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input?.length || !input[0]?.length) {
      return true;
    }

    const channels = input.map((channel) => channel.slice());
    this.port.postMessage({
      sampleRate,
      frames: input[0].length,
      channels,
    }, channels.map((channel) => channel.buffer));
    return true;
  }
}

registerProcessor("pcm-tap", PcmTapProcessor);
