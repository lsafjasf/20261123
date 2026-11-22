export interface PlaybackHandle {
  element: HTMLVideoElement;
  source: MediaSource;
  url: string;
  revoke: () => void;
}

function mimeFor(codec: "vp9" | "vp8" | "av1", hasAudio: boolean): string {
  const videoCodec = codec === "vp8"
    ? "vp8"
    : codec === "av1"
      ? "av01.0.04M.08"
      : "vp09.00.10.08";
  return hasAudio
    ? `video/webm;codecs=${videoCodec},opus`
    : `video/webm;codecs=${videoCodec}`;
}

export function canPlay(codec: "vp9" | "vp8" | "av1", hasAudio: boolean): boolean {
  const mime = mimeFor(codec, hasAudio);
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
}

export async function playBytes(
  element: HTMLVideoElement,
  bytes: Uint8Array,
  codec: "vp9" | "vp8" | "av1",
  hasAudio: boolean,
): Promise<PlaybackHandle> {
  const mime = mimeFor(codec, hasAudio);
  if (!MediaSource.isTypeSupported(mime)) {
    throw new Error(`MediaSource does not support ${mime}`);
  }
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  element.src = url;

  await new Promise<void>((resolve, reject) => {
    source.addEventListener("sourceopen", () => resolve(), { once: true });
    source.addEventListener("sourceclose", () => reject(new Error("MediaSource closed early")), { once: true });
  });

  const buffer = source.addSourceBuffer(mime);
  await new Promise<void>((resolve, reject) => {
    buffer.addEventListener("updateend", () => resolve(), { once: true });
    buffer.addEventListener("error", () => reject(new Error("SourceBuffer append failed")), { once: true });
    buffer.appendBuffer(bytes);
  });
  if (source.readyState === "open") {
    source.endOfStream();
  }

  return {
    element,
    source,
    url,
    revoke: () => URL.revokeObjectURL(url),
  };
}

