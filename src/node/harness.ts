// Codec capability bench harness.
// Serves the browser runner, executes the config matrix one run per page
// load, collects results, and writes artifacts/report.{json,md}.
//
// Usage:
//   node src/node/harness.ts [options]
//     --repeat N        runs per config (default 3)
//     --full            full cross product matrix
//     --frames N        frames per run (default 48)
//     --only <id>       run a single config id
//     --list            list config ids and exit
//     --port N          fixed port (default random)
//     --browser <path>  browser binary to drive (headless)
//     --keep-server     keep serving for manual repro after the queue
//     --out <dir>       artifacts directory (default artifacts)
//     --timeout-ms N    per-run timeout (default 90000)
//     --min-psnr N      deviation threshold in dB (default 18)
//     --mse-timeout N   MSE stage timeout (default 8000)

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildMatrix } from '../shared/matrix.ts';
import type { TestConfig } from '../shared/matrix.ts';
import { summarizeConfig } from '../shared/result.ts';
import type { RunResult, ConfigSummary } from '../shared/result.ts';
import { stripFile } from './strip.ts';
import { renderMarkdown, renderConsoleSummary } from './report.ts';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

interface CliOptions {
  repeat: number;
  full: boolean;
  frames: number;
  only?: string;
  list: boolean;
  port: number;
  browser?: string;
  keepServer: boolean;
  out: string;
  timeoutMs: number;
  minPsnr: number;
  mseTimeout: number;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      repeat: { type: 'string', default: '3' },
      full: { type: 'boolean', default: false },
      frames: { type: 'string', default: '48' },
      only: { type: 'string' },
      list: { type: 'boolean', default: false },
      port: { type: 'string', default: '0' },
      browser: { type: 'string' },
      'keep-server': { type: 'boolean', default: false },
      out: { type: 'string', default: 'artifacts' },
      'timeout-ms': { type: 'string', default: '90000' },
      'min-psnr': { type: 'string', default: '18' },
      'mse-timeout': { type: 'string', default: '8000' },
    },
  });
  return {
    repeat: Number(values.repeat),
    full: values.full === true,
    frames: Number(values.frames),
    only: values.only as string | undefined,
    list: values.list === true,
    port: Number(values.port),
    browser: values.browser as string | undefined,
    keepServer: values['keep-server'] === true,
    out: values.out as string,
    timeoutMs: Number(values['timeout-ms']),
    minPsnr: Number(values['min-psnr']),
    mseTimeout: Number(values['mse-timeout']),
  };
}

interface RunTask {
  config: TestConfig;
  runIndex: number;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

function browserArgs(browserPath: string, url: string, profileDir: string): string[] {
  const name = browserPath.toLowerCase();
  if (name.includes('firefox')) {
    return ['-headless', '-profile', profileDir, url];
  }
  return [
    '--headless=new',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    url,
  ];
}

// Linux-only best-effort peak RSS (bytes) across every process sharing the
// browser profile dir; null elsewhere.
function startRssSampler(tag: string): { stop: () => number | null } {
  if (process.platform !== 'linux') return { stop: () => null };
  let peak = 0;
  const timer = setInterval(() => {
    let total = 0;
    let pids: string[];
    try {
      pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    } catch {
      return;
    }
    for (const pid of pids) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmdline.includes(tag)) continue;
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (match) total += Number(match[1]) * 1024;
      } catch {
        // process exited between readdir and read
      }
    }
    if (total > peak) peak = total;
  }, 200);
  return {
    stop: () => {
      clearInterval(timer);
      return peak > 0 ? peak : null;
    },
  };
}



async function main(): Promise<number> {
  const cli = parseCli();
  const configs = buildMatrix({ full: cli.full, frames: cli.frames, only: cli.only });

  if (cli.list) {
    for (const config of configs) console.log(config.id);
    return 0;
  }
  if (cli.only && configs.length === 0) {
    console.error(`unknown config id: ${cli.only} (use --list to see ids)`);
    return 1;
  }

  const queue: RunTask[] = [];
  for (const config of configs) {
    for (let runIndex = 0; runIndex < cli.repeat; runIndex++) {
      queue.push({ config, runIndex });
    }
  }

  const results: RunResult[] = [];
  const configById = new Map(configs.map((c) => [c.id, c]));
  let pendingResolve: ((result: RunResult) => void) | null = null;
  let currentTask: RunTask | null = null;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      res.writeHead(500).end(String(err));
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/repro/'))) {
      const html = readFileSync(join(ROOT, 'src/browser/index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('.ts')) {
      const stripped = stripFile(ROOT, url.pathname);
      if (stripped === null) {
        res.writeHead(404).end('not found');
      } else {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(stripped);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const id = url.searchParams.get('id') ?? '';
      const config = configById.get(id);
      if (!config) {
        res.writeHead(404).end('unknown config');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          config,
          options: { minPsnrDb: cli.minPsnr, mseTimeoutMs: cli.mseTimeout },
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/result') {
      const body = await readBody(req);
      const result = JSON.parse(body) as RunResult;
      results.push(result);
      res.writeHead(200).end('ok');
      if (pendingResolve) {
        const resolveRun = pendingResolve;
        pendingResolve = null;
        resolveRun(result);
      }
      return;
    }
    res.writeHead(404).end('not found');
  }

  await new Promise<void>((resolveListen) => server.listen(cli.port, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : cli.port;
  const startedAt = new Date().toISOString();

  console.log(`bench server: http://127.0.0.1:${port}`);
  console.log(`matrix: ${configs.length} configs x ${cli.repeat} runs = ${queue.length} runs`);
  if (!cli.browser) {
    console.log('no --browser given: open the printed URLs in any browser, in order.');
  }

  const runOne = (task: RunTask): Promise<RunResult> => {
    const url = `http://127.0.0.1:${port}/?config=${encodeURIComponent(task.config.id)}&run=${task.runIndex}`;
    currentTask = task;
    if (!cli.browser) {
      console.log(`\n[${task.config.id} run ${task.runIndex}] open: ${url}`);
      return new Promise<RunResult>((resolveRun) => {
        pendingResolve = resolveRun;
      });
    }
    return new Promise<RunResult>((resolveRun) => {
      const profileDir = mkdtempSync(join(tmpdir(), 'codec-bench-'));
      const rss = startRssSampler(profileDir);
      const child: ChildProcess = spawn(cli.browser!, browserArgs(cli.browser!, url, profileDir), {
        stdio: 'ignore',
      });
      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingResolve = null;
        child.kill('SIGKILL');
        const peakRss = rss.stop();
        if (peakRss !== null) {
          (result as RunResult & { peakProcessRssBytes?: number }).peakProcessRssBytes = peakRss;
        }
        rmSync(profileDir, { recursive: true, force: true });
        resolveRun(result);
      };
      const timer = setTimeout(() => {
        finish({
          ...timeoutResult(task),
          error: `no result within ${cli.timeoutMs} ms`,
        });
      }, cli.timeoutMs);
      child.on('error', (err) => {
        finish({ ...timeoutResult(task), failStage: 'harness', error: `browser spawn: ${String(err)}` });
      });
      child.on('exit', (code) => {
        // The page posts its result before the browser exits; an early exit
        // means the run never reported back.
        setTimeout(() => {
          finish({ ...timeoutResult(task), error: `browser exited early (code ${code})` });
        }, 500);
      });
      pendingResolve = (result) => finish(result);
    });
  };

  function timeoutResult(task: RunTask): RunResult {
    return {
      configId: task.config.id,
      runIndex: task.runIndex,
      status: 'fail',
      failStage: 'timeout',
      claimedSupport: { encoder: null, decoder: null, mse: null },
      timing: { generateMs: null, encodeMs: null, firstChunkMs: null, decodeMs: null, ttffMs: null, mseMs: null },
      memory: { peakJsHeapBytes: null },
      quality: { mae: null, psnrDb: null, framesCompared: 0 },
      frames: { expected: task.config.frames, encoded: 0, decoded: 0 },
      mse: 'skipped',
      userAgent: 'unavailable',
      platform: 'unavailable',
      startedAt: new Date().toISOString(),
      durationMs: 0,
    };
  }

  let done = 0;
  for (const task of queue) {
    const before = results.length;
    const result = await runOne(task);
    if (results.length === before) results.push(result);
    done++;
    const status = result.status.toUpperCase();
    console.log(
      `[${done}/${queue.length}] ${status} ${result.configId} run=${result.runIndex}` +
        (result.error ? ` :: ${result.failStage}: ${result.error}` : ''),
    );
  }

  const summaries: ConfigSummary[] = configs.map((config) =>
    summarizeConfig(
      config.id,
      results.filter((r) => r.configId === config.id),
    ),
  );

  mkdirSync(cli.out, { recursive: true });
  const browserLabel = cli.browser ?? 'manual';
  const report = {
    startedAt,
    browser: browserLabel,
    repeat: cli.repeat,
    options: { minPsnrDb: cli.minPsnr, frames: cli.frames, full: cli.full },
    summaries,
  };
  writeFileSync(join(cli.out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(
    join(cli.out, 'report.md'),
    renderMarkdown({ summaries, configs: configById, repeat: cli.repeat, browserLabel, startedAt }),
  );
  console.log('\n' + renderConsoleSummary(summaries));
  console.log(`\nreport: ${join(cli.out, 'report.md')}`);

  const unstable = summaries.filter((s) => !s.stable).length;
  const failed = summaries.filter((s) => s.conclusion === 'fail').length;

  if (cli.keepServer) {
    console.log('keep-server: serving repro pages, e.g.');
    for (const s of summaries.filter((s) => s.conclusion !== 'pass').slice(0, 5)) {
      console.log(`  http://127.0.0.1:${port}/?config=${s.configId}&run=0`);
    }
    console.log('Ctrl+C to exit.');
    await new Promise(() => undefined);
  }

  server.close();
  currentTask = null;
  void currentTask;
  return failed > 0 || unstable > 0 ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
