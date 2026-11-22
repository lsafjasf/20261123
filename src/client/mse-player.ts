/**
 * Play the exported WebM through MediaSource rather than a plain blob URL,
 * proving the muxer output is accepted by the platform's SourceBuffer
 * pipeline. Used by the post-export verification step.
 */
export async function playThroughMediaSource(
  video: HTMLVideoElement,
  blob: Blob,
): Promise<void> {
  if (typeof MediaSource === 'undefined') {
    throw new Error('MediaSource unavailable in this browser');
  }
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;

  await new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
    mediaSource.addEventListener('sourceclose', () =>
      reject(new Error('MediaSource closed early')),
    );
  });

  const mimeCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const mimeType =
    mimeCandidates.find((candidate) =>
      MediaSource.isTypeSupported(candidate),
    ) ?? '';
  if (!mimeType) throw new Error('no supported WebM SourceBuffer type');

  const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await new Promise<void>((resolve, reject) => {
    sourceBuffer.addEventListener('updateend', () => resolve(), { once: true });
    sourceBuffer.addEventListener('error', () =>
      reject(new Error('SourceBuffer append failed')),
    );
    sourceBuffer.appendBuffer(bytes);
  });
  mediaSource.endOfStream();
}
