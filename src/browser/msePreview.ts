/**
 * MediaSource 预览：把服务端产出的 webm 分片喂给 MSE SourceBuffer。
 * 全程使用浏览器原生 API（MediaSource / fetch / URL），无第三方包。
 */
export function initMsePreview(options: {
  videoId: string;
  selectId: string;
  buttonId: string;
  statusId: string;
}): void {
  const video = document.querySelector(`#${options.videoId}`) as HTMLVideoElement;
  const select = document.querySelector(`#${options.selectId}`) as HTMLSelectElement;
  const button = document.querySelector(`#${options.buttonId}`) as HTMLButtonElement;
  const status = document.querySelector(`#${options.statusId}`) as HTMLSpanElement;

  async function refreshList(): Promise<void> {
    const response = await fetch("/api/outputs");
    const result = (await response.json()) as { ok: boolean; outputs: string[] };
    const previous = select.value;
    select.innerHTML = "";
    for (const name of result.outputs) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
    if (previous) select.value = previous;
  }

  async function play(): Promise<void> {
    const name = select.value;
    if (!name) {
      status.textContent = "暂无可播放产物";
      return;
    }
    if (typeof MediaSource === "undefined") {
      video.src = `/api/file?name=${encodeURIComponent(name)}`;
      status.textContent = "浏览器不支持 MediaSource，回退为直接播放";
      return;
    }
    status.textContent = "MSE 加载中…";
    const mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);

    await new Promise<void>((resolvePromise) => {
      mediaSource.addEventListener("sourceopen", () => resolvePromise(), { once: true });
    });
    const mime = `video/webm; codecs="vp09.00.10.08, opus"`;
    const supported = MediaSource.isTypeSupported(mime);
    const buffer = mediaSource.addSourceBuffer(
      supported ? mime : 'video/webm; codecs="vp8, opus"',
    );

    try {
      const response = await fetch(`/api/file?name=${encodeURIComponent(name)}`);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      let streaming = true;
      const appendNext = async (): Promise<void> => {
        while (streaming) {
          const { value, done } = await reader.read();
          if (done) {
            streaming = false;
            mediaSource.endOfStream();
            status.textContent = `播放就绪：${name}`;
            return;
          }
          if (buffer.updating) {
            await new Promise((resolvePromise) =>
              buffer.addEventListener("updateend", () => resolvePromise(), { once: true }),
            );
          }
          buffer.appendBuffer(value);
          await new Promise<void>((resolvePromise) =>
            buffer.addEventListener("updateend", () => resolvePromise(), { once: true }),
          );
        }
      };
      await appendNext();
    } catch (err) {
      status.textContent = `MSE 播放失败：${(err as Error).message}（可改用直接播放）`;
      video.src = `/api/file?name=${encodeURIComponent(name)}`;
    }
  }

  button.addEventListener("click", () => {
    void play();
  });
  void refreshList();
  window.setInterval(() => void refreshList(), 4000);
}
