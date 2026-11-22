/**
 * 扫描状态存储（纯 Node 标准库 node:fs / node:path / node:crypto）。
 *
 * 目录结构：
 *   <root>/state/<sha256>/state.json     检查点（原子写）
 *   <root>/state/<sha256>/batches/000000.ndjson ...
 *   <root>/results/<sha256>.json          最终分析结果
 *
 * 续扫语义：
 * - 批次按 batchIndex 命名，重复上传同一批次直接幂等忽略；
 * - 缺批次（序号不连续）拒绝写入，防止顺序错乱破坏指标连续性；
 * - 引擎版本不一致拒绝续扫，避免新旧阈值混用导致结果漂移。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ENGINE_VERSION } from '../shared/config.ts';
import type {
  AnalysisResult,
  BatchAck,
  BatchUpload,
  FrameMetric,
  MetricBundle,
  ScanState,
} from '../shared/types.ts';

export class ScanStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, 'state'), { recursive: true });
    mkdirSync(join(root, 'results'), { recursive: true });
  }

  get rootDir(): string {
    return this.root;
  }

  private dir(sha256: string): string {
    return join(this.root, 'state', sha256);
  }

  private batchDir(sha256: string): string {
    return join(this.dir(sha256), 'batches');
  }

  private statePath(sha256: string): string {
    return join(this.dir(sha256), 'state.json');
  }

  getState(sha256: string): ScanState | null {
    const path = this.statePath(sha256);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as ScanState;
  }

  listStates(): ScanState[] {
    const stateRoot = join(this.root, 'state');
    if (!existsSync(stateRoot)) return [];
    return readdirSync(stateRoot)
      .map((sha) => this.getState(sha))
      .filter((state): state is ScanState => state !== null)
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  /** 上传一批帧指标；返回最新检查点。 */
  uploadBatch(batch: BatchUpload): BatchAck {
    if (batch.engineVersion !== ENGINE_VERSION) {
      throw new Error(
        `引擎版本不匹配：采集端 ${batch.engineVersion}，服务端 ${ENGINE_VERSION}，请刷新采集页后重新扫描`,
      );
    }
    if (batch.frames.length === 0) {
      throw new Error('空批次被拒绝');
    }
    mkdirSync(this.batchDir(batch.sha256), { recursive: true });
    const state = this.getState(batch.sha256);
    const expected = state?.nextBatchIndex ?? 0;
    if (batch.batchIndex < expected) {
      return this.ack(batch.sha256);
    }
    if (batch.batchIndex !== expected) {
      throw new Error(
        `批次序号不连续：期望 ${expected}，收到 ${batch.batchIndex}，请从检查点续扫`,
      );
    }
    const step = Math.max(1, batch.sampleEvery);
    const expectedFrame = state ? state.lastFrameIndex + step : 0;
    if (batch.frames[0].index !== expectedFrame) {
      throw new Error(
        `帧序号不连续：期望首帧 ${expectedFrame}，收到 ${batch.frames[0].index}`,
      );
    }
    for (let i = 1; i < batch.frames.length; i += 1) {
      const gap = batch.frames[i].index - batch.frames[i - 1].index;
      if (gap !== step) {
        throw new Error(
          `批内帧步长异常：位置 ${i} 步长 ${gap}，期望 ${step}`,
        );
      }
    }

    const batchPath = join(
      this.batchDir(batch.sha256),
      `${String(batch.batchIndex).padStart(6, '0')}.ndjson`,
    );
    const payload = batch.frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n';
    atomicWrite(batchPath, payload);

    const lastFrame = batch.frames[batch.frames.length - 1];
    const nextState: ScanState = {
      sha256: batch.sha256,
      fileName: batch.fileName,
      size: batch.size,
      engineVersion: batch.engineVersion,
      status: 'scanning',
      nextBatchIndex: expected + 1,
      lastFrameIndex: lastFrame.index,
      totalFrames: state?.totalFrames ?? batch.videoMeta?.frameCount ?? 0,
      sampleEvery: batch.sampleEvery,
      videoMeta: batch.videoMeta ?? state?.videoMeta ?? null,
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(this.statePath(batch.sha256), JSON.stringify(nextState, null, 2));
    return this.ack(batch.sha256);
  }

  /** 浏览器端采集完成后收尾：校验帧数并标记 done。 */
  complete(sha256: string, totalFrames: number): ScanState {
    const state = this.getState(sha256);
    if (!state) throw new Error(`未知扫描任务: ${sha256}`);
    const step = Math.max(1, state.sampleEvery);
    const lastExpected = Math.floor((totalFrames - 1) / step) * step;
    if (state.lastFrameIndex !== lastExpected) {
      throw new Error(
        `采样帧数不一致：末帧应为 ${lastExpected}，实际 ${state.lastFrameIndex}，声明总帧 ${totalFrames}`,
      );
    }
    const done: ScanState = {
      ...state,
      status: 'done',
      totalFrames,
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(this.statePath(sha256), JSON.stringify(done, null, 2));
    return done;
  }

  /** 从批次文件重建完整指标包（确定性：按文件名排序顺序读取）。 */
  loadBundle(sha256: string): MetricBundle {
    const state = this.getState(sha256);
    if (!state) throw new Error(`未知扫描任务: ${sha256}`);
    const dir = this.batchDir(sha256);
    const files = existsSync(dir)
      ? readdirSync(dir).filter((name) => name.endsWith('.ndjson')).sort()
      : [];
    const frames: FrameMetric[] = [];
    for (const file of files) {
      const lines = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) frames.push(JSON.parse(line) as FrameMetric);
    }
    return {
      schemaVersion: 1,
      engineVersion: state.engineVersion,
      file: {
        name: state.fileName,
        size: state.size,
        sha256: state.sha256,
      },
      video: state.videoMeta ?? {
        width: 0,
        height: 0,
        frameRate: 30,
        frameCount: frames.length,
        durationSec: frames.length / 30,
        hasAudio: false,
      },
      sampleEvery: state.sampleEvery,
      frames,
      collector: 'server-rebuild',
      createdAt: state.updatedAt,
    };
  }

  saveResult(result: AnalysisResult): void {
    const path = join(this.root, 'results', `${result.sha256}.json`);
    atomicWrite(path, JSON.stringify(result, null, 2) + '\n');
  }

  getResult(sha256: string): AnalysisResult | null {
    const path = join(this.root, 'results', `${sha256}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as AnalysisResult;
  }

  listResults(): AnalysisResult[] {
    const dir = join(this.root, 'results');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as AnalysisResult)
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  private ack(sha256: string): BatchAck {
    const state = this.getState(sha256);
    if (!state) throw new Error('检查点写入失败');
    return {
      sha256,
      nextBatchIndex: state.nextBatchIndex,
      lastFrameIndex: state.lastFrameIndex,
      status: state.status,
    };
  }
}

/** 临时文件 + rename 原子写，中断不会留下半个 JSON。 */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${createHash('md5').update(path).digest('hex').slice(0, 8)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
