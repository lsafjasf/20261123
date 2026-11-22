/**
 * WebAudio graph for the three panels. File sources are routed through
 * MediaElementSource nodes; a quiet synthesized bed covers synthetic feeds.
 * The same graph feeds both monitoring output and an AudioData capture tap
 * for Opus encoding (when MediaStreamTrackProcessor is available).
 */
export class AudioMixer {
  readonly ctx: AudioContext;
  private readonly inputs = new Map<
    string,
    { gain: GainNode; oscillator?: OscillatorNode }
  >();
  private readonly destination: MediaStreamAudioDestinationNode;

  constructor() {
    this.ctx = new AudioContext();
    this.destination = this.ctx.createMediaStreamDestination();
    this.destination.channelCount = 2;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get stream(): MediaStream {
    return this.destination.stream;
  }

  attachFile(id: string, element: HTMLVideoElement): GainNode {
    const source = this.ctx.createMediaElementSource(element);
    const gain = this.ctx.createGain();
    gain.gain.value = 0.9;
    source.connect(gain);
    gain.connect(this.ctx.destination);
    gain.connect(this.destination);
    this.inputs.set(id, { gain });
    return gain;
  }

  addSyntheticBed(id: string, frequency: number): void {
    const oscillator = this.ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.02;
    oscillator.connect(gain);
    gain.connect(this.ctx.destination);
    gain.connect(this.destination);
    oscillator.start();
    this.inputs.set(id, { gain, oscillator });
  }

  setMuted(id: string, muted: boolean): void {
    const entry = this.inputs.get(id);
    if (entry) entry.gain.gain.value = muted ? 0 : 0.9;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  dispose(): void {
    for (const entry of this.inputs.values()) entry.oscillator?.stop();
    this.ctx.close();
  }
}

/**
 * Pull encoded-size AudioData from the mixed stream. Uses the standard
 * MediaStreamTrackProcessor when present; returns null otherwise so the app
 * can export video-only instead of failing.
 */
export async function createAudioDataTap(
  stream: MediaStream,
): Promise<ReadableStream<AudioData> | null> {
  const track = stream.getAudioTracks()[0];
  if (!track) return null;
  const ProcessorCtor = (globalThis as Record<string, unknown>)
    .MediaStreamTrackProcessor as
    | (new (init: { track: MediaStreamTrack }) => {
        readable: ReadableStream<AudioData>;
      })
    | undefined;
  if (!ProcessorCtor) return null;
  return new ProcessorCtor({ track }).readable;
}
