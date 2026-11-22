// MediaSource 加载器：把本地 File 通过 SourceBuffer 喂给 <video>，
// 演示完整 MSE 管线；浏览器不支持 MSE 或容器不被接受时回退到 blob: URL。
export async function loadIntoVideo(video, file, onLog) {
  const supportsMse =
    typeof globalThis.MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported?.('video/mp4; codecs="avc1.42E01E"');
  if (!supportsMse) {
    onLog?.('MediaSource 不可用或不支持该容器，回退 blob: 直放');
    video.src = URL.createObjectURL(file);
    return { mode: 'blob' };
  }
  try {
    const mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);
    await new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true });
      mediaSource.addEventListener('sourceclose', reject, { once: true });
    });
    const mime = pickMime(mediaSource);
    const sourceBuffer = mediaSource.addSourceBuffer(mime);
    const data = new Uint8Array(await file.arrayBuffer());
    await new Promise((resolve, reject) => {
      sourceBuffer.addEventListener('updateend', resolve, { once: true });
      sourceBuffer.addEventListener('error', reject, { once: true });
      sourceBuffer.appendBuffer(data);
    });
    mediaSource.endOfStream();
    onLog?.(`MediaSource 加载成功（${mime}）`);
    return { mode: 'mse', mime };
  } catch (error) {
    onLog?.(`MSE 加载失败，回退 blob:（${error.message}）`);
    video.src = URL.createObjectURL(file);
    return { mode: 'blob' };
  }
}

function pickMime(mediaSource) {
  const candidates = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E"',
    'video/webm; codecs="vp8, opus"',
    'video/webm; codecs="vp8"',
  ];
  for (const mime of candidates) {
    if (MediaSource.isTypeSupported(mime)) return mime;
  }
  return mediaSource.sourceBuffers ? '' : '';
}
