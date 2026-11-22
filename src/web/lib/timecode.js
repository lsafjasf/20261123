// 与 src/shared/timecode.ts 同算法的浏览器实现（无构建步骤，保持双端约定一致）。
export function nominalFrameRate(frameRate) {
  return Math.round(frameRate);
}

export function frameToTimecode(frame, frameRate) {
  const fps = nominalFrameRate(frameRate);
  let f = Math.max(0, Math.round(frame));
  f %= fps * 3600 * 24;
  const hours = Math.floor(f / (fps * 3600));
  f %= fps * 3600;
  const minutes = Math.floor(f / (fps * 60));
  f %= fps * 60;
  const seconds = Math.floor(f / fps);
  const frames = f % fps;
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

export function formatSeconds(value) {
  return Number(value).toFixed(3);
}
