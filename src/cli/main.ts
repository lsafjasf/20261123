/**
 * Command-line entry point. Zero third-party dependencies; Node 24 runs the
 * TypeScript directly via native type stripping.
 *
 * Commands:
 *   analyze <dir|file...> --out <dir>      QC analysis + matrix/anomaly export
 *   mix <dir|file...> --lang <zh|en>       render dialogue-first default mix WAV
 *   samples [dir]                          generate synthetic test deliverables
 *   serve [dir]                            offline static + API server for the web app
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { parseWav, encodeWav16 } from '../core/wav.ts';
import { analyzeTracks, prepareTracks, type PreparedTrack } from '../core/analyze.ts';
import { buildDialogueFirstMix } from '../core/mix.ts';
import { DEFAULT_THRESHOLDS, type DecodedTrack, type TrackKind } from '../core/types.ts';
import { anomaliesToCsv, matrixToCsv, reportToJson } from './report.ts';
import { generateSamples } from '../tools/generate-samples.ts';
import { startServer } from './server.ts';

function parseArgs(argv: string[]): { command: string; positionals: string[]; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags.set(key, 'true');
      else {
        flags.set(key, next);
        i++;
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, positionals, flags };
}

function collectWavFiles(targets: string[]): string[] {
  const files: string[] = [];
  for (const target of targets) {
    const absolute = resolve(target);
    if (!existsSync(absolute)) throw new Error(`Path not found: ${target}`);
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        if (extname(entry).toLowerCase() === '.wav') files.push(join(absolute, entry));
      }
    } else if (extname(absolute).toLowerCase() === '.wav') {
      files.push(absolute);
    }
  }
  return files;
}

export function loadTracks(files: string[]): DecodedTrack[] {
  return files.map((file) => {
    const buffer = readFileSync(file);
    const decoded = parseWav(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    return {
      fileName: file.split(/[\\/]/).pop() ?? file,
      kind: 'unknown',
      sampleRate: decoded.sampleRate,
      channelCount: decoded.channelCount,
      durationSec: decoded.pcm.channels[0].length / decoded.sampleRate,
      pcm: decoded.pcm,
    };
  });
}

function runAnalyze(positionals: string[], flags: Map<string, string>): void {
  const targets = positionals.length ? positionals : [process.cwd()];
  const files = collectWavFiles(targets);
  if (!files.length) throw new Error('No .wav files found in the given paths');
  const prepared: PreparedTrack[] = prepareTracks(loadTracks(files));
  const report = analyzeTracks(prepared, DEFAULT_THRESHOLDS);

  const outDir = flags.get('out') ?? join(process.cwd(), 'report');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), reportToJson(report));
  writeFileSync(join(outDir, 'track-matrix.csv'), matrixToCsv(report));
  writeFileSync(join(outDir, 'anomalies.csv'), anomaliesToCsv(report));

  const errors = report.anomalies.filter((a) => a.severity === 'error').length;
  const warnings = report.anomalies.filter((a) => a.severity === 'warning').length;
  console.log(`Analyzed ${prepared.length} tracks -> ${outDir}`);
  console.log(`  report.json, track-matrix.csv, anomalies.csv`);
  console.log(`  errors=${errors} warnings=${warnings} info=${report.anomalies.length - errors - warnings}`);
  if (flags.get('print') === 'true') console.log(reportToJson(report));
}

function runMix(positionals: string[], flags: Map<string, string>): void {
  const targets = positionals.length ? positionals : [process.cwd()];
  const prepared = prepareTracks(loadTracks(collectWavFiles(targets)));
  const lang = (flags.get('lang') ?? 'zh') === 'en' ? 'dialogue-en' : 'dialogue-zh';
  const result = buildDialogueFirstMix(prepared, lang as TrackKind);
  const outDir = flags.get('out') ?? join(process.cwd(), 'report');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `default-mix-${lang}.wav`);
  writeFileSync(outFile, Buffer.from(encodeWav16(result.mix)));
  console.log(`Rendered dialogue-first mix (${lang}) -> ${outFile}`);
}

const usage = `Film multi-track delivery toolkit (offline, no dependencies)

Usage:
  node src/cli/main.ts analyze <dir|file...> [--out dir] [--print]
  node src/cli/main.ts mix <dir|file...> --lang <zh|en> [--out dir]
  node src/cli/main.ts samples [dir]
  node src/cli/main.ts serve [dir] [--port 8080]
`;

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'analyze':
      runAnalyze(positionals, flags);
      break;
    case 'mix':
      runMix(positionals, flags);
      break;
    case 'samples':
      generateSamples(positionals[0] ?? join(process.cwd(), 'samples'));
      break;
    case 'serve': {
      const root = positionals[0] ?? process.cwd();
      const port = Number(flags.get('port') ?? 8080);
      await startServer(root, port);
      break;
    }
    default:
      console.log(usage);
      if (command) process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
