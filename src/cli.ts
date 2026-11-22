#!/usr/bin/env node
// vidpriv — privacy cleaner for phone recordings. Node stdlib only.

import { basename, dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { inspect, clean, verify, selectRemovable } from './service.ts';
import { CATEGORIES, type CategoryId, type Finding } from './types.ts';

interface ParsedArgs {
  command: string;
  file?: string;
  flags: Map<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      positionals.push(token);
    }
  }
  return { command: command ?? 'help', flags, positionals, file: positionals[0] };
}

function categorySet(flags: Map<string, string | boolean>): Set<CategoryId> {
  const selected = new Set<CategoryId>();
  for (const category of CATEGORIES) {
    if (flags.get(category.id) === true) selected.add(category.id);
  }
  const grouped = flags.get('categories');
  if (typeof grouped === 'string') {
    if (grouped.trim() === 'a') {
      for (const category of CATEGORIES) selected.add(category.id);
      return selected;
    }
    for (const id of grouped.split(',').map((s) => s.trim())) {
      if (CATEGORIES.some((c) => c.id === id)) selected.add(id as CategoryId);
    }
  }
  return selected;
}

function printFinding(finding: Finding, index: number): void {
  const mark = finding.confidence === 'confirmed' ? '确认' : '待确认';
  const risk = {
    'container-only': '仅容器',
    'container-nonstandard': '非标准容器',
    'breaks-timing': '删除会破坏时序',
    'out-of-scope': '超出范围',
  }[finding.risk];
  console.log(
    `  [${index + 1}] (${mark}/${risk}) ${finding.category}  ${finding.path}`,
  );
  console.log(`      ${finding.reason}${finding.preview ? ` | 预览: ${finding.preview}` : ''}`);
}

async function askCategories(): Promise<Set<CategoryId>> {
  const rl = createInterface({ input, output });
  console.log('\n按类别选择要删除的信息（逗号分隔编号，a=全部，q=取消）：');
  CATEGORIES.forEach((category, i) => {
    console.log(`  ${i + 1}. ${category.label} — ${category.description}`);
  });
  const answer = (await rl.question('选择> ')).trim().toLowerCase();
  rl.close();
  if (answer === 'q' || answer === '') return new Set();
  if (answer === 'a') return new Set(CATEGORIES.map((c) => c.id));
  const selected = new Set<CategoryId>();
  for (const part of answer.split(',')) {
    const index = Number(part.trim()) - 1;
    const category = CATEGORIES[index];
    if (category) selected.add(category.id);
  }
  return selected;
}

async function runInspect(file: string): Promise<void> {
  const report = await inspect(file);
  console.log(`文件: ${report.file} (${report.fileSize} 字节, ${report.brand})`);
  console.log(`\n发现 ${report.findings.length} 项元数据：`);
  report.findings.forEach(printFinding);
  if (report.sidecars.length > 0) {
    console.log(`\n同名旁路文件（仅提示，不会修改）：`);
    for (const sidecar of report.sidecars) {
      console.log(`  [${sidecar.risk}] ${sidecar.path} — ${sidecar.note}`);
    }
  } else {
    console.log('\n未发现同名旁路文件。');
  }
  for (const note of report.notes) console.log(`\n注意: ${note}`);
}

async function runClean(file: string, flags: Map<string, string | boolean>): Promise<void> {
  let categories = categorySet(flags);
  if (categories.size === 0 && input.isTTY) {
    categories = await askCategories();
  }
  if (categories.size === 0) {
    console.error('未选择任何类别；可用 --location --device --chat-thumbnail --edit-history 或 --categories=a');
    process.exitCode = 2;
    return;
  }

  const ext = extname(file);
  const defaultOutput = join(
    dirname(file),
    `${basename(file, ext)}.cleaned${ext}`,
  );
  const outputPath = typeof flags.get('output') === 'string'
    ? (flags.get('output') as string)
    : defaultOutput;
  const manifestPath = typeof flags.get('manifest') === 'string'
    ? (flags.get('manifest') as string)
    : `${outputPath}.hash.json`;

  const report = await inspect(file);
  const { removable, keptForReview } = selectRemovable(
    report.findings,
    categories,
    flags.get('include-review') === true,
  );
  console.log(`将删除 ${removable.length} 项，保留待确认 ${keptForReview.length} 项`);

  const result = await clean(file, {
    categories,
    includeReview: flags.get('include-review') === true,
    output: outputPath,
    manifestPath,
    perSampleHashes: flags.get('per-sample') === true,
  });

  if (!result.rewroteContainer) {
    console.log('\n未生成新文件：没有可安全删除的项目，原文件保持不变。');
  } else {
    console.log(`\n输出: ${result.output}`);
    console.log(`重编码: 否（仅容器改写，free 填充 ${result.freeSpaceBytes} 字节）`);
  }
  console.log(`码流哈希一致: ${result.hashMatch ? '是 ✓' : '否 ✗'}`);
  console.log(`哈希清单: ${manifestPath}`);
  if (result.keptForReview.length > 0) {
    console.log('\n保留的待确认项（未静默处理）：');
    result.keptForReview.forEach(printFinding);
  }
  if (result.sidecars.length > 0) {
    console.log('\n同名旁路文件（需另行人工处理）：');
    for (const sidecar of result.sidecars) {
      console.log(`  [${sidecar.risk}] ${sidecar.path} — ${sidecar.note}`);
    }
  }
  for (const note of result.notes) console.log(`\n注意: ${note}`);
}

async function runVerify(file: string, flags: Map<string, string | boolean>): Promise<void> {
  const manifestPath = typeof flags.get('manifest') === 'string'
    ? (flags.get('manifest') as string)
    : `${file}.hash.json`;
  const { match, details } = await verify(file, manifestPath);
  for (const detail of details) console.log(detail);
  process.exitCode = match ? 0 : 1;
}

function usage(): void {
  console.log(`vidpriv — 手机录像隐私清理（仅 Node 标准库 + Web 平台 API）

用法:
  node src/cli.ts inspect <视频文件>
  node src/cli.ts clean <视频文件> [类别选项] [--output 路径] [--manifest 路径] [--include-review] [--per-sample]
  node src/cli.ts verify <视频文件> [--manifest 路径]

类别选项（可多选）:
  --location            拍摄地点
  --device              设备型号
  --chat-thumbnail      聊天软件缩略图
  --edit-history        旧剪辑记录
  --categories=a        全部类别（a）或逗号分隔 id
  --include-review      同时删除标记为“待确认”且不破坏时序的项目

其他:
  node src/server.ts     启动浏览器验证页（WebCodecs/WebAudio/Canvas/MediaSource）
`);
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.file && parsed.command !== 'help') {
  usage();
  process.exit(2);
}

try {
  switch (parsed.command) {
    case 'inspect':
      await runInspect(parsed.file!);
      break;
    case 'clean':
      await runClean(parsed.file!, parsed.flags);
      break;
    case 'verify':
      await runVerify(parsed.file!, parsed.flags);
      break;
    default:
      usage();
  }
} catch (error) {
  console.error(`错误: ${(error as Error).message}`);
  process.exitCode = 1;
}
