// Orchestration: inspect, clean (container-only rewrite + hash proof), verify.

import { basename, dirname, resolve as resolvePath } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parseFile, findFirst } from './mp4.ts';
import { classifyAll } from './classify.ts';
import { planRewrite, rewriteContainer } from './rewriter.ts';
import { buildManifest, manifestsEquivalent } from './sample-table.ts';
import { scanSidecars } from './sidecar.ts';
import { NodeFileReader } from './node-reader.ts';
import type {
  CategoryId, CleanResult, Finding, HashManifest, InspectReport,
} from './types.ts';

export interface CleanOptions {
  categories: Set<CategoryId>;
  includeReview: boolean;
  output: string;
  manifestPath?: string;
  perSampleHashes: boolean;
}

async function inspectInternal(filePath: string): Promise<{
  report: InspectReport;
  root: Awaited<ReturnType<typeof parseFile>>;
  reader: NodeFileReader;
}> {
  const absolute = resolvePath(filePath);
  const reader = await NodeFileReader.create(absolute);
  const root = await parseFile(reader);
  const ftyp = findFirst(root, (n) => n.type === 'ftyp');
  const { findings } = await classifyAll(reader, root);
  const sidecars = await scanSidecars(dirname(absolute), basename(absolute));
  const notes: string[] = [];
  if (!ftyp) notes.push('未发现 ftyp 盒，文件可能不是 ISO-BMFF/MOV 容器，结果仅供参考');
  return {
    report: {
      file: absolute,
      fileSize: reader.size,
      brand: ftyp ? `ftyp@${ftyp.start}` : 'unknown',
      findings,
      sidecars,
      notes,
    },
    root,
    reader,
  };
}

export async function inspect(filePath: string): Promise<InspectReport> {
  const { report, reader } = await inspectInternal(filePath);
  await reader.close();
  return report;
}

/**
 * Select findings that are safe to remove for the chosen categories.
 * - confirmed + container-safe: removable by default
 * - review: removable only with explicit includeReview; breaks-timing never
 */
export function selectRemovable(
  findings: Finding[],
  categories: Set<CategoryId>,
  includeReview: boolean,
): { removable: Finding[]; keptForReview: Finding[] } {
  const removable: Finding[] = [];
  const keptForReview: Finding[] = [];
  const seenRanges = new Set<string>();

  for (const finding of findings) {
    if (!categories.has(finding.category)) continue;
    const timingUnsafe = finding.risk === 'breaks-timing' ||
      finding.risk === 'out-of-scope';
    const allowed = finding.confidence === 'confirmed' ||
      (includeReview && !timingUnsafe);
    if (!allowed || timingUnsafe) {
      keptForReview.push(finding);
      continue;
    }
    const rangeKey = `${finding.start}:${finding.end}`;
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);
    removable.push(finding);
  }
  return { removable, keptForReview };
}

export async function clean(
  filePath: string,
  options: CleanOptions,
): Promise<CleanResult> {
  const absolute = resolvePath(filePath);
  const before = await inspectInternal(absolute);
  const { removable, keptForReview } = selectRemovable(
    before.report.findings,
    options.categories,
    options.includeReview,
  );

  const notes = [...before.report.notes];
  if (removable.length === 0) {
    notes.push('没有符合所选类别且可安全删除的项目，未写出新文件');
  }

  // A single XMP uuid box can match several categories; make that explicit.
  const multiCategoryBoxes = new Map<string, Set<CategoryId>>();
  for (const finding of before.report.findings) {
    const key = `${finding.start}:${finding.end}`;
    const set = multiCategoryBoxes.get(key) ?? new Set<CategoryId>();
    set.add(finding.category);
    multiCategoryBoxes.set(key, set);
  }
  for (const finding of removable) {
    const set = multiCategoryBoxes.get(`${finding.start}:${finding.end}`);
    if (set && set.size > 1) {
      notes.push(
        `${finding.path} 是多类别容器（${[...set].join('、')}），按盒整体删除，其中其他类别的数据也会一并移除`,
      );
    }
  }

  const beforeManifest = await buildManifest(
    before.reader, before.root, basename(absolute), options.perSampleHashes,
  );

  let output = options.output;
  let rewroteContainer = false;
  let freeSpaceBytes = 0;
  let afterManifest = beforeManifest;

  if (removable.length > 0) {
    const plan = planRewrite(removable);
    freeSpaceBytes = plan.freeBytes;
    await rewriteContainer(absolute, output, plan);
    rewroteContainer = true;

    const afterReader = await NodeFileReader.create(output);
    try {
      const afterRoot = await parseFile(afterReader);
      afterManifest = await buildManifest(
        afterReader, afterRoot, basename(output), options.perSampleHashes,
      );
    } finally {
      await afterReader.close();
    }
  }

  await before.reader.close();

  const hashMatch = manifestsEquivalent(beforeManifest, afterManifest);
  if (!hashMatch) {
    notes.push('警告：清洗前后码流哈希不一致，请丢弃输出文件并人工复核');
  }
  if (keptForReview.length > 0) {
    notes.push(
      `${keptForReview.length} 项因无法确认安全而保留（见报告 keptForReview），未做静默处理`,
    );
  }

  const result: CleanResult = {
    input: absolute,
    output: rewroteContainer ? resolvePath(output) : absolute,
    removed: removable,
    keptForReview,
    rewroteContainer,
    reencoded: false,
    freeSpaceBytes,
    beforeManifest,
    afterManifest,
    hashMatch,
    sidecars: before.report.sidecars,
    notes,
  };

  if (options.manifestPath) {
    await writeFile(
      options.manifestPath,
      JSON.stringify(
        {
          before: result.beforeManifest,
          after: result.afterManifest,
          hashMatch,
          removed: removable.map((f) => ({
            path: f.path, category: f.category, bytes: f.size,
          })),
        },
        null,
        2,
      ),
    );
  }
  return result;
}

export async function verify(
  filePath: string,
  manifestPath: string,
): Promise<{ match: boolean; details: string[] }> {
  const absolute = resolvePath(filePath);
  const reader = await NodeFileReader.create(absolute);
  const details: string[] = [];
  try {
    const root = await parseFile(reader);
    const current = await buildManifest(reader, root, basename(absolute));
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      before?: HashManifest;
      after?: HashManifest;
    };
    const baseline = saved.after ?? saved.before;
    if (!baseline) throw new Error('清单中缺少 before/after 哈希记录');
    const match = manifestsEquivalent(baseline, current);
    details.push(
      match
        ? '当前文件的 mdat 与每条轨道采样哈希均与清洗清单一致，码流未被重编码或改动'
        : '哈希不一致：码流在清洗后发生过变化，请勿公开发布并人工复核',
    );
    return { match, details };
  } finally {
    await reader.close();
  }
}
