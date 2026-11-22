import type { PlaybackSnapshot } from "../core/types.ts";
import { toNumber } from "../core/fraction.ts";

export function drawScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  snapshot: PlaybackSnapshot,
): void {
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#0b1118");
  background.addColorStop(0.55, "#101b24");
  background.addColorStop(1, "#071012");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(90, 190, 180, 0.12)";
  context.lineWidth = 1;
  const grid = Math.max(28, width / 24);
  for (let x = 0; x < width; x += grid) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y < height; y += grid) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  const progress =
    snapshot.durationSeconds === 0
      ? 0
      : snapshot.positionSeconds / snapshot.durationSeconds;
  const playheadX = Math.min(width, Math.max(0, progress * width));
  const waveHeight = height * 0.42;
  const centerY = height * 0.52;
  context.beginPath();
  for (let x = 0; x < width; x += 2) {
    const time =
      snapshot.positionSeconds + ((x - playheadX) / width) * 0.14;
    const envelope =
      0.38 + 0.26 * Math.sin(time * 7.1) + 0.18 * Math.sin(time * 2.3 + 1.4);
    const sample =
      Math.sin(time * 2 * Math.PI * 8.4) * envelope +
      Math.sin(time * 2 * Math.PI * 13.7) * 0.18;
    const y = centerY + sample * waveHeight * 0.5;
    if (x === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.strokeStyle =
    snapshot.status === "playing" ? "#74e4c8" : "#6d8a91";
  context.lineWidth = Math.max(2, width / 560);
  context.shadowColor = "#4cd6b4";
  context.shadowBlur = snapshot.status === "playing" ? 14 : 0;
  context.stroke();
  context.shadowBlur = 0;

  context.fillStyle = "rgba(255, 255, 255, 0.18)";
  context.fillRect(playheadX - 1, 0, 2, height);
  context.fillStyle = "#f2b84b";
  context.fillRect(playheadX - 2, 0, 4, height);

  context.fillStyle = "rgba(218, 238, 238, 0.92)";
  context.font = `${Math.round(width / 42)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = "top";
  context.fillText(
    `SRC ${String(Math.floor(toNumber(snapshot.position))).padStart(8, "0")} fr`,
    width * 0.035,
    height * 0.055,
  );
  context.fillStyle = "rgba(116, 228, 200, 0.88)";
  context.fillText(
    `${formatClock(snapshot.positionSeconds)} / ${formatClock(snapshot.durationSeconds)}`,
    width * 0.035,
    height * 0.105,
  );

  context.fillStyle = "rgba(255, 255, 255, 0.08)";
  context.beginPath();
  context.arc(width * 0.92, height * 0.1, width * 0.045, 0, Math.PI * 2);
  context.fill();
  context.fillStyle =
    snapshot.status === "playing"
      ? "#74e4c8"
      : snapshot.status === "interrupted"
        ? "#ff8b6b"
        : "#f2b84b";
  context.beginPath();
  context.arc(width * 0.92, height * 0.1, width * 0.022, 0, Math.PI * 2);
  context.fill();
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}
