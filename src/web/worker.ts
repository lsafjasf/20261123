import { StreamAnalyzer } from '../shared/analyzer.ts';
import { decodeAdts, probeAdts } from '../shared/adts.ts';
import type {
  AnalysisRequest,
  AudioMetadata,
  WorkerRequest,
  WorkerResponse
} from '../shared/types.ts';
import { blobSource, decodeWav } from '../shared/wav.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

let generation = 0;
let paused = false;
let resumeWaiter: (() => void) | null = null;
let analyzer: StreamAnalyzer | null = null;
let metadata: AudioMetadata | null = null;
let latestAds: AnalysisRequest['ads'] = [];
let latestSettings: AnalysisRequest['settings'] | null = null;
let warnings: string[] = [];
let finalized = false;
let activeSince = 0;
let pausedAt = 0;
let pausedTotal = 0;

function post(message: WorkerResponse): void {
  scope.postMessage(message);
}

async function waitForResume(token: number): Promise<boolean> {
  while (paused && token === generation) {
    await new Promise<void>((resolve) => {
      resumeWaiter = resolve;
    });
  }
  return token === generation;
}

function setPaused(value: boolean, token: number): void {
  if (token !== generation) return;
  if (value === paused) return;
  paused = value;
  if (paused) {
    pausedAt = performance.now();
  } else {
    if (pausedAt > 0) pausedTotal += performance.now() - pausedAt;
    pausedAt = 0;
    const waiter = resumeWaiter;
    resumeWaiter = null;
    waiter?.();
  }
}

function elapsedSeconds(): number {
  const now = performance.now();
  const currentPause = paused && pausedAt > 0 ? now - pausedAt : 0;
  return Math.max(0, (now - activeSince - pausedTotal - currentPause) / 1000);
}

async function analyze(token: number, file: File, request: AnalysisRequest): Promise<void> {
  latestAds = request.ads;
  latestSettings = request.settings;
  warnings = [];
  finalized = false;
  analyzer = null;
  metadata = null;
  paused = false;
  pausedAt = 0;
  pausedTotal = 0;
  activeSince = performance.now();

  const source = blobSource(file);
  const probe = new Uint8Array(await source.read(0, 12));
  const riff = String.fromCharCode(...probe.slice(0, 4));
  const adts = probe[0] === 0xff && (probe[1] & 0xf6) === 0xf0;
  const id3 = riff === 'ID3\u0003' || riff === 'ID3\u0004';
  if (adts || id3) {
    if (typeof AudioDecoder === 'undefined') {
      throw new Error('该 AAC/ADTS 文件需要 WebCodecs AudioDecoder；请使用支持 WebCodecs 的 Chromium 系浏览器。');
    }
    metadata = await probeAdts(source);
    if (token !== generation) return;
    analyzer = new StreamAnalyzer(metadata.sampleRate, metadata.channels);
    post({ type: 'metadata', metadata });
    let decodedFrames = 0;
    await decodeAdts(
      source,
      async (channels, frameCount) => {
        if (!(await waitForResume(token))) return;
        analyzer?.push(channels, frameCount);
        decodedFrames += frameCount;
      },
      async (ratio) => {
        if (token !== generation) return;
        post({
          type: 'progress',
          ratio,
          seconds: decodedFrames / metadata!.sampleRate,
          elapsed: elapsedSeconds(),
          state: paused ? 'paused' : 'scanning'
        });
      },
      () => waitForResume(token)
    );
    if (token !== generation || !analyzer || !metadata || !latestSettings) return;
    const result = analyzer.finish(metadata, latestAds, latestSettings, warnings);
    finalized = true;
    post({ type: 'result', result });
    return;
  }
  if (riff !== 'RIFF' && riff !== 'RF64') {
    throw new Error('流式分析支持 WAV PCM/Float 与 AAC/ADTS；其他容器请先转为 WAV。');
  }

  let scannedFrames = 0;
  for await (const part of decodeWav(source)) {
    if (!(await waitForResume(token))) return;
    if ('metadata' in part) {
      metadata = part.metadata;
      latestSettings = latestSettings || request.settings;
      analyzer = new StreamAnalyzer(part.metadata.sampleRate, part.metadata.channels);
      post({ type: 'metadata', metadata: part.metadata });
      continue;
    }
    if (!analyzer || !metadata) throw new Error('WAV 头信息尚未就绪');
    analyzer.push(part.channels, part.frameCount);
    scannedFrames += part.frameCount;
    const ratio = metadata.duration > 0 ? Math.min(1, scannedFrames / metadata.sampleRate / metadata.duration) : 0;
    post({
      type: 'progress',
      ratio,
      seconds: scannedFrames / metadata.sampleRate,
      elapsed: elapsedSeconds(),
      state: paused ? 'paused' : 'scanning'
    });
  }

  if (token !== generation || !analyzer || !metadata || !latestSettings) return;
  const result = analyzer.finish(metadata, latestAds, latestSettings, warnings);
  finalized = true;
  post({ type: 'result', result });
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'start') {
    generation += 1;
    const token = generation;
    analyze(token, message.file, message.request).catch((error: unknown) => {
      if (token !== generation) return;
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }

  const token = generation;
  if (message.type === 'pause') {
    setPaused(true, token);
    return;
  }
  if (message.type === 'resume') {
    setPaused(false, token);
    return;
  }
  if (message.type === 'cancel') {
    generation += 1;
    paused = false;
    resumeWaiter?.();
    resumeWaiter = null;
    return;
  }
  if (message.type === 'set-ads') {
    latestAds = message.ads;
    if (finalized && analyzer && latestSettings) {
      const result = analyzer.update(latestAds, latestSettings, warnings);
      if (result) post({ type: 'result', result });
    }
    return;
  }
  if (message.type === 'set-settings') {
    latestSettings = message.settings;
    if (finalized && analyzer) {
      const result = analyzer.update(latestAds, message.settings, warnings);
      if (result) post({ type: 'result', result });
    }
  }
};
