import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const chrome = process.env.CHROME_PATH || '/home/hj/.cache/ms-playwright/chromium-1169/chrome-linux/chrome';
const port = Number(process.env.SMOKE_PORT || 9333);
const url = process.env.APP_URL || 'http://127.0.0.1:4180/';
const profile = `/tmp/loudness-smoke-${process.pid}`;

class Cdp {
  private socket: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private listeners = new Map<string, Array<(params: unknown) => void>>();
  readonly errors: string[] = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(JSON.stringify(message.params));
      if (message.method === 'Runtime.consoleAPICalled') {
        const params = message.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
        if (params.type === 'error') {
          this.errors.push(params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ') || 'console.error');
        }
      }
      for (const listener of this.listeners.get(message.method || '') || []) listener(message.params);
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method: string, timeout = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), timeout);
      const listener = (params: unknown): void => {
        clearTimeout(timer);
        const listeners = this.listeners.get(method) || [];
        this.listeners.set(method, listeners.filter((item) => item !== listener));
        resolve(params);
      };
      this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
    });
  }
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value: T; description?: string } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result.result.value;
}

async function waitFor(cdp: Cdp, expression: string, timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate<boolean>(cdp, expression);
    if (value) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const browser = spawn(chrome, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=1440,1200',
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
browser.stderr.on('data', (chunk) => { stderr += String(chunk); });

async function connect(): Promise<Cdp> {
  let target: { webSocketDebuggerUrl: string } | null = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      target = targets.find((item) => item.type === 'page') || null;
      if (target) break;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  if (!target) throw new Error(`Chrome did not start\n${stderr}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true });
  });
  return new Cdp(socket);
}

try {
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await waitFor(cdp, "document.querySelector('#integratedValue')?.textContent !== '—'", 35_000);
  await new Promise((resolveWait) => setTimeout(resolveWait, 4200));

  const summary = await evaluate<Record<string, string>>(cdp, `({
    integrated: document.querySelector('#integratedValue')?.textContent,
    truePeak: document.querySelector('#truePeakValue')?.textContent,
    samplePeak: document.querySelector('#samplePeakValue')?.textContent,
    program: document.querySelector('#programValue')?.textContent,
    ads: document.querySelector('#adCountValue')?.textContent,
    status: document.querySelector('#deliveryStatus')?.textContent,
    problems: document.querySelector('#problemsBadge')?.textContent
  })`);

  let audioState: Record<string, unknown> = { skipped: true };
  let playingTime = '';
  let pausedTime = '';
  let pausedTimeLater = '';
  if (process.env.SKIP_PLAY !== '1') {
    await cdp.send('Runtime.evaluate', {
      expression: "document.querySelector('#playButton').click()",
      userGesture: true
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1400));
    audioState = await evaluate<Record<string, unknown>>(cdp, `(() => {
    const audio = document.querySelector('#audio');
    return {
      paused: audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyState: audio.readyState,
      networkState: audio.networkState,
      error: audio.error?.code || null,
      toast: document.querySelector('#toast')?.textContent
    };
  })()`);
    playingTime = await evaluate<string>(cdp, "document.querySelector('#currentTime')?.textContent || ''");
    await cdp.send('Runtime.evaluate', {
      expression: "document.querySelector('#playButton').click()",
      userGesture: true
    });
    pausedTime = await evaluate<string>(cdp, "document.querySelector('#currentTime')?.textContent || ''");
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    pausedTimeLater = await evaluate<string>(cdp, "document.querySelector('#currentTime')?.textContent || ''");
    if (pausedTime !== pausedTimeLater) throw new Error('Paused clock moved unexpectedly');
  }

  await evaluate(cdp, "document.querySelector('[data-tab=\"problems\"]').click()");
  const problemCount = await evaluate<number>(cdp, "document.querySelectorAll('.problem-item').length");
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await evaluate(cdp, "document.querySelector('.review-panel').scrollIntoView({ block: 'start' })");
  const problemsShot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(import.meta.dirname, '../artifacts/ui-problems.png'), Buffer.from(problemsShot.data, 'base64'));
  await evaluate(cdp, "document.querySelector('[data-tab=\"segments\"]').click()");
  const segmentCount = await evaluate<number>(cdp, "document.querySelectorAll('.segment-card').length");
  const segmentsShot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(import.meta.dirname, '../artifacts/ui-segments.png'), Buffer.from(segmentsShot.data, 'base64'));
  await evaluate(cdp, "document.querySelector('[data-tab=\"seconds\"]').click()");

  const height = await evaluate<number>(cdp, 'Math.min(2400, Math.max(1200, document.documentElement.scrollHeight))');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const screenshot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  });
  const target = resolve(import.meta.dirname, '../artifacts/ui.png');
  await writeFile(target, Buffer.from(screenshot.data, 'base64'));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1600, deviceScaleFactor: 1, mobile: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const mobileScreenshot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  });
  const mobileTarget = resolve(import.meta.dirname, '../artifacts/ui-mobile.png');
  await writeFile(mobileTarget, Buffer.from(mobileScreenshot.data, 'base64'));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false });

  if (problemCount < 1) throw new Error('No problem rows rendered');
  if (segmentCount !== 2) throw new Error(`Expected program + one ad card, got ${segmentCount}`);
  if (summary.integrated === '—') throw new Error('Integrated loudness did not render');
  await evaluate(cdp, "document.querySelector('#exportJsonButton').click(); document.querySelector('#exportCsvButton').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));

  await evaluate(cdp, `(() => {
    document.querySelector('#adStartInput').value = '50';
    document.querySelector('#adEndInput').value = '55';
    document.querySelector('#adLabelInput').value = '测试广告';
    document.querySelector('#addAdButton').click();
  })()`);
  await waitFor(cdp, "document.querySelectorAll('.ad-chip').length === 2 && document.querySelector('#adCountValue')?.textContent === '2'");
  await evaluate(cdp, "document.querySelector('[data-tab=\"segments\"]').click()");
  const updatedSegments = await evaluate<number>(cdp, "document.querySelectorAll('.segment-card').length");
  if (updatedSegments !== 3) throw new Error(`Ad update did not rebuild segment cards: ${updatedSegments}`);
  await evaluate(cdp, "document.querySelectorAll('[data-remove-ad]')[1].click()");
  await waitFor(cdp, "document.querySelectorAll('.ad-chip').length === 1");
  await evaluate(cdp, "document.querySelector('[data-tab=\"seconds\"]').click()");

  let adtsSummary: Record<string, string> | null = null;
  if (process.env.ADTS_FILE) {
    const adtsSupport = await evaluate<{ supported: boolean }>(cdp, `AudioDecoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2,
      description: new Uint8Array([0x11, 0x90]).buffer
    })`);
    if (!adtsSupport.supported) {
      console.log('AAC/ADTS skipped: this Chromium build does not expose a WebCodecs AAC decoder.');
    } else {
    await cdp.send('DOM.enable');
    const documentNode = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument');
    const inputNode = await cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector: '#fileInput'
    });
    await cdp.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [process.env.ADTS_FILE] });
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    const selected = await evaluate<string>(cdp, "document.querySelector('#workTitle')?.textContent || ''");
    if (selected !== 'demo.aac') {
      await evaluate(cdp, "document.querySelector('#fileInput').dispatchEvent(new Event('change', { bubbles: true }))");
    }
    try {
      await waitFor(cdp, `document.querySelector('#workTitle')?.textContent === 'demo.aac' && document.querySelector('#integratedValue')?.textContent !== '—' && document.querySelector('#scanLabel')?.textContent === '扫描完成'`, 40_000);
    } catch (error) {
      const debug = await evaluate<Record<string, unknown>>(cdp, `({
        title: document.querySelector('#workTitle')?.textContent,
        integrated: document.querySelector('#integratedValue')?.textContent,
        scan: document.querySelector('#scanLabel')?.textContent,
        summary: document.querySelector('#fileSummary')?.textContent,
        toast: document.querySelector('#toast')?.textContent,
        errors: ${JSON.stringify(cdp.errors)}
      })`);
      throw new Error(`${(error as Error).message}\n${JSON.stringify(debug, null, 2)}`);
    }
    adtsSummary = await evaluate<Record<string, string>>(cdp, `({
      subtitle: document.querySelector('#workSubtitle')?.textContent,
      integrated: document.querySelector('#integratedValue')?.textContent,
      truePeak: document.querySelector('#truePeakValue')?.textContent,
      rows: document.querySelector('#secondsBadge')?.textContent,
      problems: document.querySelector('#problemsBadge')?.textContent
    })`);
    }
  }

  let longScanSummary: Record<string, string> | null = null;
  if (process.env.LONG_FILE) {
    await cdp.send('DOM.enable');
    const documentNode = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument');
    const inputNode = await cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector: '#fileInput'
    });
    await cdp.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [process.env.LONG_FILE] });
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const selected = await evaluate<string>(cdp, "document.querySelector('#workTitle')?.textContent || ''");
    if (selected !== 'demo-long.wav') {
      await evaluate(cdp, "document.querySelector('#fileInput').dispatchEvent(new Event('change', { bubbles: true }))");
    }
    await waitFor(cdp, "parseInt(document.querySelector('#scanRatio')?.textContent || '0', 10) > 0 && document.querySelector('#scanLabel')?.textContent === '流式扫描中'", 30_000);
    await evaluate(cdp, "document.querySelector('#scanPauseButton').click()");
    await waitFor(cdp, "document.querySelector('#scanLabel')?.textContent?.includes('已暂停')", 5_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    const pausedRatio = await evaluate<string>(cdp, "document.querySelector('#scanProgress')?.style.width || ''");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    const heldRatio = await evaluate<string>(cdp, "document.querySelector('#scanProgress')?.style.width || ''");
    if (pausedRatio !== heldRatio) throw new Error(`Scan progress moved while paused: ${pausedRatio} -> ${heldRatio}`);
    await evaluate(cdp, "document.querySelector('#scanPauseButton').click()");
    await waitFor(cdp, "document.querySelector('#scanLabel')?.textContent === '扫描完成' && document.querySelector('#integratedValue')?.textContent !== '—'", 90_000);
    longScanSummary = await evaluate<Record<string, string>>(cdp, `({
      integrated: document.querySelector('#integratedValue')?.textContent,
      rows: document.querySelector('#secondsBadge')?.textContent,
      pausedRatio: ${JSON.stringify(pausedRatio)},
      heldRatio: ${JSON.stringify(heldRatio)}
    })`);
    if (longScanSummary.rows !== '540') throw new Error(`Expected 540 per-second rows, got ${longScanSummary.rows}`);
  }
  if (cdp.errors.length) throw new Error(`Browser errors:\n${cdp.errors.join('\n')}`);
  console.log(JSON.stringify({ summary, audioState, playingTime, pausedTime, problemCount, segmentCount, adtsSummary, longScanSummary, screenshot: target }, null, 2));
  await cdp.send('Browser.close').catch(() => undefined);
} finally {
  browser.kill('SIGTERM');
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
}
