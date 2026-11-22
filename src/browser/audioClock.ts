// Independent timebase via WebAudio. Detects throttled or frozen timers
// (common in headless/background tabs) by comparing AudioContext.currentTime
// against performance.now() over a short window.

export interface AudioClockResult {
  skewMs: number | null;
  note: string;
}

export async function measureClockSkew(windowMs: number): Promise<AudioClockResult> {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return { skewMs: null, note: 'AudioContext unavailable' };
  const ctx = new Ctor();
  try {
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }
    if (ctx.state !== 'running') {
      return { skewMs: null, note: `AudioContext state ${ctx.state}` };
    }
    const perfStart = performance.now();
    const audioStart = ctx.currentTime;
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const perfDelta = performance.now() - perfStart;
    const audioDelta = (ctx.currentTime - audioStart) * 1000;
    return { skewMs: Math.abs(perfDelta - audioDelta), note: 'ok' };
  } catch (err) {
    return { skewMs: null, note: String(err) };
  } finally {
    ctx.close().catch(() => undefined);
  }
}
