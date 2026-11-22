import { StreamAnalyzer } from '../shared/analyzer.js';
import { decodeAdts, probeAdts } from '../shared/adts.js';
             
                  
                
                
                
                            
import { blobSource, decodeWav } from '../shared/wav.js';

const scope = self                
                                                                   
                                                                        
 ;

let generation = 0;
let paused = false;
let resumeWaiter                      = null;
let analyzer                        = null;
let metadata                       = null;
let latestAds                         = [];
let latestSettings                                     = null;
let warnings           = [];
let finalized = false;
let activeSince = 0;
let pausedAt = 0;
let pausedTotal = 0;

function post(message                )       {
  scope.postMessage(message);
}

async function waitForResume(token        )                   {
  while (paused && token === generation) {
    await new Promise      ((resolve) => {
      resumeWaiter = resolve;
    });
  }
  return token === generation;
}

function setPaused(value         , token        )       {
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

function elapsedSeconds()         {
  const now = performance.now();
  const currentPause = paused && pausedAt > 0 ? now - pausedAt : 0;
  return Math.max(0, (now - activeSince - pausedTotal - currentPause) / 1000);
}

async function analyze(token        , file      , request                 )                {
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
          seconds: decodedFrames / metadata .sampleRate,
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

scope.onmessage = (event                             ) => {
  const message = event.data;
  if (message.type === 'start') {
    generation += 1;
    const token = generation;
    analyze(token, message.file, message.request).catch((error         ) => {
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
