const CDP_HOST = process.env.CDP_HOST ?? "http://127.0.0.1:9333";
const PAGE_URL = process.env.PAGE_URL ?? "http://127.0.0.1:4173/";

interface CdpTarget {
  type: string;
  webSocketDebuggerUrl: string;
}

class Cdp {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Array<(params: any) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static async connect(): Promise<Cdp> {
    const targets = await (await fetch(`${CDP_HOST}/json/list`)).json() as CdpTarget[];
    const target = targets.find((candidate) => candidate.type === "page");
    if (!target) throw new Error("没有可连接的 Chrome 页面");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  const cdp = await Cdp.connect();
  const consoleErrors: string[] = [];
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") consoleErrors.push(params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    consoleErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception");
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 920,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Page.navigate", { url: PAGE_URL });

  const evaluate = async (expression: string): Promise<any> => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  const waitFor = async (expression: string, timeoutMs = 15000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`等待超时: ${expression}`);
  };

  const press = async (key: string, code: string, keyCode: number, modifiers = 0): Promise<void> => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    });
  };

  await waitFor(`Boolean(window.frameReview) && window.frameReview.snapshot()?.displayedFrame === 0 && !window.frameReview.snapshot()?.decoding`);
  const initial = await evaluate(`window.frameReview.snapshot()`);
  console.log("initial", {
    frame: initial.targetFrame,
    decoded: initial.displayedFrame,
    exact: initial.exact,
    cache: initial.videoStats.cache,
    decodeRequests: initial.videoStats.decodeRequests
  });

  for (let index = 0; index < 10; index += 1) {
    await press("ArrowRight", "ArrowRight", 39);
    await sleep(12);
  }
  await waitFor(`window.frameReview.snapshot()?.displayedFrame === 10 && !window.frameReview.snapshot()?.decoding`);
  const afterTen = await evaluate(`window.frameReview.snapshot()`);
  console.log("after 10 steps", { frame: afterTen.targetFrame, displayed: afterTen.displayedFrame, exact: afterTen.exact });
  if (afterTen.targetFrame !== 10 || afterTen.displayedFrame !== 10) throw new Error("连续十次单帧未落在第 11 帧");

  await press("ArrowRight", "ArrowRight", 39, 8);
  await waitFor(`window.frameReview.snapshot()?.displayedFrame === 20 && !window.frameReview.snapshot()?.decoding`);
  console.log("shift jump", await evaluate(`window.frameReview.snapshot().targetFrame`));

  for (let index = 0; index < 10; index += 1) {
    await press("ArrowLeft", "ArrowLeft", 37);
    await sleep(12);
  }
  await waitFor(`window.frameReview.snapshot()?.displayedFrame === 10 && !window.frameReview.snapshot()?.decoding`);
  await press("ArrowRight", "ArrowRight", 39, 8);
  await waitFor(`window.frameReview.snapshot()?.displayedFrame === 20 && !window.frameReview.snapshot()?.decoding`);
  console.log("reverse 10 steps + shift", await evaluate(`window.frameReview.snapshot().displayedFrame`));

  const beforeSwitch = await evaluate(`window.frameReview.snapshot()`);
  await evaluate(`document.querySelectorAll('.audio-option')[1].click()`);
  await sleep(350);
  const afterSwitch = await evaluate(`window.frameReview.snapshot()`);
  console.log("audio switch", {
    track: afterSwitch.audioTrackId,
    frame: afterSwitch.displayedFrame,
    cacheFrames: [beforeSwitch.videoStats.cache.frames, afterSwitch.videoStats.cache.frames]
  });
  if (afterSwitch.displayedFrame !== afterSwitch.targetFrame) throw new Error("切音轨后视频帧丢失");

  const beforeResize = await evaluate(`window.frameReview.snapshot()`);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1120,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(500);
  const afterResize = await evaluate(`window.frameReview.snapshot()`);
  console.log("resize", {
    frame: [beforeResize.displayedFrame, afterResize.displayedFrame],
    decodeRequests: [beforeResize.videoStats.decodeRequests, afterResize.videoStats.decodeRequests]
  });
  if (beforeResize.videoStats.decodeRequests !== afterResize.videoStats.decodeRequests) {
    throw new Error("窗口缩放触发了重新解码");
  }

  await press(" ", "Space", 32);
  await sleep(1200);
  const playing = await evaluate(`window.frameReview.snapshot()`);
  console.log("playback", {
    playing: playing.playing,
    target: playing.targetFrame,
    displayed: playing.displayedFrame,
    audio: playing.audioState,
    audioError: playing.audioError
  });
  if (!playing.playing || playing.targetFrame <= afterResize.targetFrame) throw new Error("播放后目标帧没有前进");
  if (playing.audioState === "unsupported" || playing.audioState === "error") {
    throw new Error(`音频播放失败: ${playing.audioError}`);
  }
  await press(" ", "Space", 32);
  await sleep(150);

  const rect = await evaluate(`(() => { const r = document.getElementById('timeline').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x + rect.w * 0.25,
    y: rect.y + rect.h / 2,
    button: "left",
    clickCount: 1
  });
  await waitFor(`!document.getElementById('previewTag').hidden && document.getElementById('previewCanvas').classList.contains('visible')`, 4000);
  const previewInfo = await evaluate(`({
    tag: document.getElementById('previewTag').textContent,
    snap: window.frameReview.snapshot(),
    previewClass: document.getElementById('previewCanvas').className,
    thumbnail: window.frameReview.thumbnails()
  })`);
  console.log("preview", previewInfo);
  if (previewInfo.thumbnail?.frameNumber !== 0 || previewInfo.thumbnail?.timestamp !== 0) {
    throw new Error("低清预览没有使用当前 GOP 的 I 帧");
  }
  const previewScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile("/tmp/uid4-preview.png", Buffer.from(previewScreenshot.data, "base64"))
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x + rect.w * 0.62,
    y: rect.y + rect.h / 2,
    button: "left"
  });
  await sleep(50);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x + rect.w * 0.62,
    y: rect.y + rect.h / 2,
    button: "left",
    clickCount: 1
  });
  await waitFor(`window.frameReview.snapshot()?.exact && !window.frameReview.snapshot()?.decoding`, 5000);
  const scrubbed = await evaluate(`window.frameReview.snapshot()`);
  console.log("scrub final", { frame: scrubbed.displayedFrame, exact: scrubbed.exact });

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile("/tmp/uid4-review.png", Buffer.from(screenshot.data, "base64"))
  );
  console.log("console errors", consoleErrors);
  if (consoleErrors.length) throw new Error("浏览器控制台存在错误");
  cdp.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
