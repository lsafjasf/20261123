// WebAudio audition: sentence ranges, comp playback, playhead callbacks.

let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;
let playheadTimer = 0;

export function audioCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

export function stopAll(): void {
  if (current) {
    try {
      current.stop();
    } catch {
      /* already stopped */
    }
    current = null;
  }
  if (playheadTimer) {
    cancelAnimationFrame(playheadTimer);
    playheadTimer = 0;
  }
}

// Play pcm[startSec..endSec]; onTick(playheadSec) fires per animation frame.
export function playRange(
  pcm: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  onTick?: (t: number) => void,
  onEnd?: () => void,
): void {
  stopAll();
  const ac = audioCtx();
  const from = Math.max(0, Math.floor(startSec * sampleRate));
  const to = Math.min(pcm.length, Math.ceil(endSec * sampleRate));
  if (to <= from) return;
  const buf = ac.createBuffer(1, to - from, sampleRate);
  buf.copyToChannel(pcm.subarray(from, to), 0);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
  const t0 = ac.currentTime;
  src.onended = () => {
    if (current === src) current = null;
    if (playheadTimer) cancelAnimationFrame(playheadTimer);
    playheadTimer = 0;
    onEnd?.();
  };
  current = src;
  src.start();
  if (onTick) {
    const tick = () => {
      if (current !== src) return;
      onTick(startSec + (ac.currentTime - t0));
      playheadTimer = requestAnimationFrame(tick);
    };
    playheadTimer = requestAnimationFrame(tick);
  }
}

export function isPlaying(): boolean {
  return current !== null;
}
