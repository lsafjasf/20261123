/**
 * 非丢帧 SMPTE 时间码工具。
 * 时间码只依赖帧号与标称帧率，因此同一文件重复扫描永远得到相同时间码。
 */

/** 29.97/23.976 等分数帧率向上取整为标称整数帧率（本系统统一输出非丢帧）。 */
export function nominalFrameRate(frameRate: number): number {
  return Math.round(frameRate);
}

export function frameToTimecode(frame: number, frameRate: number): string {
  const fps = nominalFrameRate(frameRate);
  let f = Math.max(0, Math.round(frame));
  const framesPerHour = fps * 3600;
  f %= framesPerHour * 24;
  const hours = Math.floor(f / framesPerHour);
  f -= hours * framesPerHour;
  const minutes = Math.floor(f / (fps * 60));
  f -= minutes * fps * 60;
  const seconds = Math.floor(f / fps);
  const frames = f - seconds * fps;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

export function parseTimecode(tc: string, frameRate: number): number {
  const parts = tc.split(':').map((part) => Number(part));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error(`非法时间码: ${tc}`);
  }
  const fps = nominalFrameRate(frameRate);
  const [hours, minutes, seconds, frames] = parts;
  return ((hours * 60 + minutes) * 60 + seconds) * fps + frames;
}

/** 时间区间显示用：秒保留 3 位小数。 */
export function formatSeconds(seconds: number): string {
  return seconds.toFixed(3);
}
