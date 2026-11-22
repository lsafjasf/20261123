// Optional browser helpers. The lossless pipeline never uses these APIs:
// WebCodecs/MediaSource are codec-oriented and cannot guarantee sample-exact
// PCM round trips, while Canvas/WebAudio are only used for visual/audible preview.

export interface PreviewEnvelope {
  peaks: number[];
  rms: number[];
  width: number;
}

declare global {
  interface AudioContext {
    decodeAudioData(compressedData: ArrayBuffer): Promise<AudioBuffer>;
  }
}

export function hasBrowserPreview(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

export async function decodeWavPreview(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const contextCtor = (globalThis as { AudioContext?: { new (): AudioContext } }).AudioContext;
  if (!contextCtor) {
    throw new Error("WebAudio AudioContext is unavailable in this runtime.");
  }
  const context = new contextCtor();
  try {
    return await context.decodeAudioData(bytes.slice(0));
  } finally {
    if (typeof context.close === "function") {
      await context.close();
    }
  }
}

export function computeEnvelope(buffer: AudioBuffer, width: number): PreviewEnvelope {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`canvas width must be a positive integer, got ${String(width)}`);
  }
  const peaks = new Array<number>(width).fill(0);
  const rms = new Array<number>(width).fill(0);
  const data = buffer.getChannelData(0);
  const bucketSize = Math.max(1, Math.floor(data.length / width));

  for (let column = 0; column < width; column += 1) {
    const start = column * bucketSize;
    const end = Math.min(data.length, start + bucketSize);
    let peak = 0;
    let squareSum = 0;
    let count = 0;
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(data[index] ?? 0);
      peak = Math.max(peak, value);
      squareSum += value * value;
      count += 1;
    }
    peaks[column] = peak;
    rms[column] = count === 0 ? 0 : Math.sqrt(squareSum / count);
  }
  return { peaks, rms, width };
}

export function drawEnvelope(canvas: HTMLCanvasElement, envelope: PreviewEnvelope): void {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("canvas 2D context unavailable.");
  }
  const { width, height } = canvas;
  if (envelope.width !== width) {
    throw new Error(`envelope width ${envelope.width} does not match canvas width ${width}.`);
  }
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0b1020";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#57d9a3";
  context.lineWidth = 1;
  const midline = height / 2;
  for (let column = 0; column < width; column += 1) {
    const peakHeight = (envelope.peaks[column] ?? 0) * midline;
    context.beginPath();
    context.moveTo(column + 0.5, midline - peakHeight);
    context.lineTo(column + 0.5, midline + peakHeight);
    context.stroke();
  }
}

export function previewTechNote(): string {
  return [
    "WebAudio decodeAudioData: lossy preview only, not used for split/verify.",
    "Canvas: renders peak/RMS envelope of decoded preview buffer.",
    "WebCodecs/MediaSource: unused because they cannot guarantee byte-exact integer PCM reassembly.",
  ].join("\n");
}
