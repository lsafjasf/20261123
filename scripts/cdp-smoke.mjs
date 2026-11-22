import { writeFile } from "node:fs/promises";

const port = process.env.CDP_PORT ?? "9222";
const appPort = process.env.APP_PORT ?? "4317";
const mode = process.env.SMOKE_MODE ?? "complete";
const appUrl = `http://127.0.0.1:${appPort}/`;
const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
  method: "PUT",
}).then((response) => response.json());

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let sequence = 0;
const pending = new Map();
const logs = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      task.reject(new Error(message.error.message));
    } else {
      task.resolve(message.result);
    }
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    logs.push(`[console:${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description).join(" ")}`);
  }
  if (message.method === "Runtime.exceptionThrown") {
    logs.push(`[exception] ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
  }
  if (message.method === "Log.entryAdded") {
    logs.push(`[log:${message.params.entry.level}] ${message.params.entry.text}`);
  }
};

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await Promise.all([command("Runtime.enable"), command("Page.enable"), command("Log.enable")]);
await command("Page.bringToFront");
await command("Page.setWebLifecycleState", { state: "active" });
await command("Network.enable");
await command("Network.setCacheDisabled", { cacheDisabled: true });
await command("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

try {
  if (process.env.RESET_STORAGE === "1") {
    await command("Storage.clearDataForOrigin", { origin: appUrl.replace(/\/$/, ""), storageTypes: "all" });
  }
  await command("Page.navigate", { url: appUrl });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitFor(
    `!document.querySelector('#start-panel').hidden || !document.querySelector('#error-screen').hidden`,
    45_000,
    "boot or error",
  );
  const bootState = await evaluate(`({
    startVisible: !document.querySelector('#start-panel').hidden,
    errorVisible: !document.querySelector('#error-screen').hidden,
    errorCode: document.querySelector('#error-code').textContent,
    errorTitle: document.querySelector('#error-title').textContent,
    errorGuidance: document.querySelector('#error-guidance').textContent,
    errorTechnical: document.querySelector('#error-technical').textContent,
    cache: document.querySelector('#cached-count').textContent,
    size: document.querySelector('#cached-size').textContent,
    storageOffline: localStorage.getItem('nimbus.offline'),
    navigatorOnline: navigator.onLine,
    serviceWorkerControlled: Boolean(navigator.serviceWorker.controller),
    ledger: [...document.querySelectorAll('.ledger-row')].map(row => row.textContent.trim())
  })`);
  console.log("BOOT", JSON.stringify(bootState, null, 2));

  if (mode === "offline" && bootState.startVisible) {
    await command("Network.enable");
    await command("Network.setBlockedURLs", { urls: [`*://127.0.0.1:${appPort}/api/*`] });
    await evaluate(`localStorage.setItem('nimbus.offline', '1')`);
    await command("Page.reload");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await waitFor(
      `!document.querySelector('#start-panel').hidden || !document.querySelector('#error-screen').hidden`,
      15_000,
      "offline boot",
    );
    const offlineBoot = await evaluate(`({
      startVisible: !document.querySelector('#start-panel').hidden,
      errorVisible: !document.querySelector('#error-screen').hidden,
      network: document.querySelector('#network-label').textContent,
      cache: document.querySelector('#cached-count').textContent,
      apiRequests: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/')).map(entry => entry.name)
    })`);
    console.log("OFFLINE_BOOT", JSON.stringify(offlineBoot, null, 2));
    if (offlineBoot.startVisible) {
      await evaluate(`document.querySelector('#start-button').click()`);
      await waitFor(`document.querySelector('#player').currentTime > 1.2`, 15_000, "offline playback");
      console.log(
        "OFFLINE_PLAYBACK",
        JSON.stringify(
          await evaluate(`({
            currentTime: document.querySelector('#player').currentTime,
            paused: document.querySelector('#player').paused,
            segment: document.querySelector('#now-chapter').textContent,
            cache: document.querySelector('#cached-count').textContent
          })`),
          null,
          2,
        ),
      );
    }
    await evaluate(`localStorage.setItem('nimbus.offline', '0')`);
    await command("Network.setBlockedURLs", { urls: [] });
  } else if (bootState.startVisible) {
    await evaluate(`document.querySelector('#start-button').click()`);
    await waitFor(`document.querySelector('#player').currentTime > 0.4`, 15_000, "playback start");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const playbackState = await evaluate(`({
      currentTime: document.querySelector('#player').currentTime,
      paused: document.querySelector('#player').paused,
      readyState: document.querySelector('#player').readyState,
      duration: document.querySelector('#player').duration,
      error: document.querySelector('#player').error?.message ?? null,
      segment: document.querySelector('#now-chapter').textContent,
      key: document.querySelector('#active-key-label').textContent,
      license: document.querySelector('#license-seconds').textContent,
      licenseState: document.querySelector('#license-state').textContent
    })`);
    console.log("PLAYBACK", JSON.stringify(playbackState, null, 2));
    if (process.env.SMOKE_DUMP_MEDIA === "1") {
      const base64 = await evaluate(`(async () => {
        const open = indexedDB.open('nimbus-controlled-player');
        const db = await new Promise((resolve, reject) => {
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const read = (store, key) => new Promise((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const b64 = value => {
          const binary = String.fromCharCode(...new Uint8Array(value));
          return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
        };
        const fromB64 = value => {
          const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
          const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
          return Uint8Array.from(binary, character => character.charCodeAt(0));
        };
        const meta = await read('meta', 'cacheMeta');
        const segment = await read('segments', 'seg-01');
        const license = await read('licenses', 'seg-01');
        const wrappingKey = await read('meta', 'wrappingKey');
        const key = await crypto.subtle.unwrapKey('raw', fromB64(license.wrappedKey.data), wrappingKey, 'AES-KW', {name: 'AES-GCM', length: 128}, false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromB64(segment.iv)}, key, segment.ciphertext);
        const output = new Uint8Array(meta.initSegment.byteLength + plain.byteLength);
        output.set(new Uint8Array(meta.initSegment), 0);
        output.set(new Uint8Array(plain), meta.initSegment.byteLength);
        let binary = '';
        for (let offset = 0; offset < output.length; offset += 0x8000) {
          binary += String.fromCharCode(...output.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      })()`);
      await writeFile("/tmp/nimbus-segment.webm", Buffer.from(base64, "base64"));
      console.log("MEDIA DUMP /tmp/nimbus-segment.webm");
    }
    if (process.env.SMOKE_DEBUG_TIMELINE === "1") {
      for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        console.log(
          "TICK",
          await evaluate(`(() => {
            const video = document.querySelector('#player');
            return [video.currentTime, video.paused, video.readyState, video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0];
          })()`),
        );
      }
    }

    if (mode === "fault") {
      await evaluate(`document.querySelector('#inject-failure').click()`);
      await waitFor(`!document.querySelector('#error-screen').hidden`, 12_000, "fault error screen");
      const faultState = await evaluate(`({
        code: document.querySelector('#error-code').textContent,
        title: document.querySelector('#error-title').textContent,
        segment: document.querySelector('#error-segment').textContent,
        position: document.querySelector('#error-position').textContent
      })`);
      console.log("FAULT", JSON.stringify(faultState, null, 2));
    } else if (mode === "expiry") {
      await evaluate(`document.querySelector('#play-button').click()`);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      const pausedState = await evaluate(`({
        warning: !document.querySelector('#pause-warning').hidden,
        license: document.querySelector('#license-seconds').textContent,
        state: document.querySelector('#license-state').textContent
      })`);
      console.log("PAUSED_EXPIRY", JSON.stringify(pausedState, null, 2));
      await evaluate(`document.querySelector('#expired-resume').click()`);
      await waitFor(`!document.querySelector('#error-screen').hidden`, 5_000, "expiry error screen");
      const expiryState = await evaluate(`({
        code: document.querySelector('#error-code').textContent,
        title: document.querySelector('#error-title').textContent
      })`);
      console.log("EXPIRY", JSON.stringify(expiryState, null, 2));
    } else {
      await waitFor(`document.querySelector('#player').currentTime > 8.5`, 15_000, "key rotation segment");
      const rotationState = await evaluate(`({
        currentTime: document.querySelector('#player').currentTime,
        segment: document.querySelector('#now-chapter').textContent,
        key: document.querySelector('#active-key-label').textContent,
        epoch: document.querySelector('#epoch-tag').textContent,
        events: [...document.querySelectorAll('#event-log li')].slice(0, 5).map(item => item.textContent)
      })`);
      console.log("ROTATION", JSON.stringify(rotationState, null, 2));

      await waitFor(
        `!document.querySelector('#completion-panel').hidden || !document.querySelector('#error-screen').hidden`,
        15_000,
        "completion",
      );
      const completionState = await evaluate(`({
        complete: !document.querySelector('#completion-panel').hidden,
        error: !document.querySelector('#error-screen').hidden,
        currentTime: document.querySelector('#player').currentTime,
        duration: document.querySelector('#player').duration
      })`);
      console.log("COMPLETION", JSON.stringify(completionState, null, 2));
    }
  }

  const screenshotPath =
    mode === "fault"
      ? "/tmp/nimbus-fault.png"
      : mode === "expiry"
        ? "/tmp/nimbus-expiry.png"
        : mode === "offline"
          ? "/tmp/nimbus-offline.png"
          : "/tmp/nimbus-smoke.png";
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(`SCREENSHOT ${screenshotPath}`);
} catch (error) {
  const failureState = await evaluate(`({
    currentTime: document.querySelector('#player')?.currentTime,
    paused: document.querySelector('#player')?.paused,
    readyState: document.querySelector('#player')?.readyState,
    errorScreen: !document.querySelector('#error-screen')?.hidden,
    errorCode: document.querySelector('#error-code')?.textContent,
    buffered: (() => {
      const video = document.querySelector('#player');
      return video ? [...Array(video.buffered.length)].map((_, index) => [video.buffered.start(index), video.buffered.end(index)]) : [];
    })(),
    events: [...document.querySelectorAll('#event-log li')].slice(0, 10).map(item => item.textContent)
  })`);
  console.log("FAILURE STATE", JSON.stringify(failureState, null, 2));
  throw error;
} finally {
  if (logs.length > 0) {
    console.log("BROWSER LOGS");
    console.log(logs.join("\n"));
  }
  socket.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
}
