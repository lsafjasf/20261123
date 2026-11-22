import { EventLog, round3 } from './event-log.ts';
import type {
  BufferReason,
  ClockSnapshot,
  Command,
  CatchUpPolicy,
  LatencyInfo,
  MonotonicClock,
  PlaybackState,
  SeekCommand,
  TimelineAnchor,
} from './types.ts';

/** 时钟配置。 */
export interface MediaClockOptions {
  readonly clock: MonotonicClock;
  readonly log: EventLog;
  /** 直播时间线起点对应的外部时钟读数，默认取首次 start 时刻。 */
  readonly originPerfMs?: number;
}

/** 缓冲结束的判定结果。 */
export interface BufferEndResult {
  readonly resumed: boolean;
  readonly reason: BufferReason | null;
  readonly appliedCommand: Command | null;
  /** 处理完排队命令后的最终状态（可能因排队 seek 再次进入 buffering）。 */
  readonly finalState: PlaybackState;
}

const FROZEN_STATES: ReadonlySet<PlaybackState> = new Set([
  'buffering',
  'paused',
  'idle',
  'ended',
]);

/**
 * 统一媒体时钟：整个播放管线唯一的状态与时间线事实源。
 *
 * 时间线模型（rate=1 播放时）：
 *   mediaMs(now) = anchor.mediaMs + (now - anchor.perfMs)
 * 冻结时 rate=0，mediaMs 恒等于 anchor.mediaMs。
 * 输出延迟（蓝牙耳机）不并入媒体时间，而是作为独立可观测值参与音频调度，
 * 这样延迟突变只重锚、不制造声画位置差。
 */
export class MediaClock {
  private state: PlaybackState = 'idle';
  private anchor: TimelineAnchor = {
    mediaMs: 0,
    perfMs: 0,
    rate: 0,
    outputLatencyMs: 0,
  };
  private bufferReason: BufferReason | null = null;
  private readonly pending: Command[] = [];
  private seq = 0;
  private outputLatencyMs = 0;
  private bufferedFromMs = 0;
  private bufferedToMs = 0;
  private liveEdgeMs = 0;
  private bufferStartedPerfMs = 0;
  private readonly listeners = new Map<ClockEvent, Set<(payload: ClockEventMap[ClockEvent]) => void>>();

  private readonly options: MediaClockOptions;

  constructor(options: MediaClockOptions) {
    this.options = options;
  }

  private get clock(): MonotonicClock {
    return this.options.clock;
  }

  private get log(): EventLog {
    return this.options.log;
  }

  getState(): PlaybackState {
    return this.state;
  }

  getOutputLatencyMs(): number {
    return this.outputLatencyMs;
  }

  /** 当前媒体时间（PTS，毫秒）。冻结状态下恒定。 */
  getMediaMs(nowPerfMs: number = this.clock.now()): number {
    if (this.anchor.rate === 0) {
      return this.anchor.mediaMs;
    }
    return this.anchor.mediaMs + (nowPerfMs - this.anchor.perfMs) * this.anchor.rate;
  }

  /** 反查某个媒体时间预计在外部时钟上呈现的时刻（不含输出延迟补偿）。 */
  mediaToPerf(targetMediaMs: number): number {
    if (this.anchor.rate === 0) {
      return this.anchor.perfMs;
    }
    return this.anchor.perfMs + (targetMediaMs - this.anchor.mediaMs) / this.anchor.rate;
  }

  getAnchor(): TimelineAnchor {
    return { ...this.anchor };
  }

  /** 距离直播边缘的滞后量。 */
  getLiveEdgeLagMs(nowPerfMs: number = this.clock.now()): number {
    return Math.max(0, this.liveEdgeMs - this.getMediaMs(nowPerfMs));
  }

  getBufferedToMs(): number {
    return this.bufferedToMs;
  }

  /** 当前已缓冲区间（毫秒），拖动目标必须落在其中才能立即生效。 */
  getBufferedRange(): readonly [number, number] {
    return [this.bufferedFromMs, this.bufferedToMs];
  }

  isBuffered(mediaMs: number): boolean {
    return mediaMs >= this.bufferedFromMs && mediaMs <= this.bufferedToMs;
  }

  /** 订阅时钟事件（状态切换、重锚、延迟突变等），渲染侧据此联动冻结/重排。 */
  on<E extends ClockEvent>(event: E, fn: (payload: ClockEventMap[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (payload: ClockEventMap[ClockEvent]) => void);
    return () => {
      set?.delete(fn as (payload: ClockEventMap[ClockEvent]) => void);
    };
  }

  private emit<E extends ClockEvent>(event: E, payload: ClockEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const fn of set) {
      fn(payload);
    }
  }

  // ---------------------------------------------------------------- 启动

  /** 起播：idle -> buffering(initial)，数据就绪后由 endBuffering 解冻。 */
  start(nowPerfMs: number = this.clock.now()): void {
    if (this.state !== 'idle') {
      this.log.record({
        perfMs: nowPerfMs,
        event: 'start',
        phase: 'rejected',
        state: this.state,
        mediaMs: this.getMediaMs(nowPerfMs),
        outputLatencyMs: this.outputLatencyMs,
        detail: { reason: 'notIdle' },
      });
      return;
    }
    this.log.record({
      perfMs: nowPerfMs,
      event: 'start',
      phase: 'applied',
      state: 'idle',
      mediaMs: 0,
      outputLatencyMs: this.outputLatencyMs,
      detail: {},
    });
    this.enterBuffering('initial', nowPerfMs);
  }

  // ------------------------------------------------------------ 缓冲冻结

  /**
   * 进入缓冲：画面与声音在当前媒体位置一起冻结（rate 置 0，锚点固化）。
   * 已在缓冲态时为幂等 no-op，重复触发记录 rejected 日志。
   */
  beginBuffering(reason: BufferReason, nowPerfMs: number = this.clock.now()): void {
    if (this.state === 'buffering') {
      this.log.record({
        perfMs: nowPerfMs,
        event: 'bufferStart',
        phase: 'rejected',
        state: this.state,
        mediaMs: this.getMediaMs(nowPerfMs),
        outputLatencyMs: this.outputLatencyMs,
        detail: { reason, existingReason: this.bufferReason ?? 'unknown' },
      });
      return;
    }
    if (this.state === 'idle' || this.state === 'ended') {
      return;
    }
    this.enterBuffering(reason, nowPerfMs);
  }

  private enterBuffering(reason: BufferReason, nowPerfMs: number): void {
    const frozenMediaMs = this.getMediaMs(nowPerfMs);
    const previousState = this.state;
    this.state = 'buffering';
    this.bufferReason = reason;
    this.bufferStartedPerfMs = nowPerfMs;
    this.anchor = {
      mediaMs: frozenMediaMs,
      perfMs: nowPerfMs,
      rate: 0,
      outputLatencyMs: this.outputLatencyMs,
    };
    this.log.record({
      perfMs: nowPerfMs,
      event: 'bufferStart',
      phase: 'applied',
      state: previousState,
      mediaMs: frozenMediaMs,
      outputLatencyMs: this.outputLatencyMs,
      detail: { reason },
    });
    this.emit('stateChange', { state: 'buffering', perfMs: nowPerfMs });
    this.emit('bufferStart', { reason, perfMs: nowPerfMs, mediaMs: frozenMediaMs });
  }

  /**
   * 结束缓冲：从冻结的同一媒体位置恢复，随后按 FIFO 应用冻结期间排队的命令。
   * 若队首跳转目标仍未缓冲，会重新进入 buffering(seek) 并保留剩余队列。
   */
  endBuffering(nowPerfMs: number = this.clock.now()): BufferEndResult {
    if (this.state !== 'buffering') {
      return { resumed: false, reason: null, appliedCommand: null, finalState: this.state };
    }
    const reason = this.bufferReason;
    const frozenMs = nowPerfMs - this.bufferStartedPerfMs;
    const resumeMediaMs = this.anchor.mediaMs;
    this.state = 'playing';
    this.bufferReason = null;
    this.anchor = {
      mediaMs: resumeMediaMs,
      perfMs: nowPerfMs,
      rate: 1,
      outputLatencyMs: this.outputLatencyMs,
    };
    this.log.record({
      perfMs: nowPerfMs,
      event: 'bufferEnd',
      phase: 'applied',
      state: 'buffering',
      mediaMs: resumeMediaMs,
      outputLatencyMs: this.outputLatencyMs,
      errorMs: round3(frozenMs),
      detail: { reason: reason ?? 'unknown', frozenMs: round3(frozenMs) },
    });
    this.emit('stateChange', { state: 'playing', perfMs: nowPerfMs });
    this.emit('bufferEnd', { reason, perfMs: nowPerfMs, mediaMs: resumeMediaMs, frozenMs });

    let appliedCommand: Command | null = null;
    while (this.pending.length > 0) {
      const command = this.pending[0];
      if (!command) {
        break;
      }
      this.pending.shift();
      const reBuffered = this.applyCommand(command, nowPerfMs);
      appliedCommand = command;
      if (reBuffered) {
        break;
      }
    }
    return { resumed: true, reason, appliedCommand, finalState: this.state };
  }

  // ------------------------------------------------------------ 暂停 / 恢复

  pause(nowPerfMs: number = this.clock.now()): void {
    this.dispatch({ kind: 'pause', issuedPerfMs: nowPerfMs, seq: this.nextSeq() });
  }

  resume(nowPerfMs: number = this.clock.now()): void {
    this.dispatch({ kind: 'resume', issuedPerfMs: nowPerfMs, seq: this.nextSeq() });
  }

  /** 用户拖动：最高优先级的位置命令。 */
  userSeek(targetMediaMs: number, nowPerfMs: number = this.clock.now()): void {
    this.dispatch({
      kind: 'userSeek',
      targetMediaMs,
      issuedPerfMs: nowPerfMs,
      seq: this.nextSeq(),
    });
  }

  /** 自动追直播：低优先级，与用户操作冲突时让行。 */
  catchUp(targetMediaMs: number, nowPerfMs: number = this.clock.now()): void {
    this.dispatch({
      kind: 'catchUp',
      targetMediaMs,
      issuedPerfMs: nowPerfMs,
      seq: this.nextSeq(),
    });
  }

  end(nowPerfMs: number = this.clock.now()): void {
    this.dispatch({ kind: 'end', issuedPerfMs: nowPerfMs, seq: this.nextSeq() });
  }

  /**
   * 命令统一入口。确定性仲裁规则：
   * 1. end 在任何状态立即生效并清空队列；
   * 2. buffering 期间命令一律 FIFO 入队，解冻后按序应用（缓冲期画面声音共同冻结）；
   * 3. 播放态用户位置命令（userSeek）抢占式取消所有排队/在途的 catchUp；
   * 4. catchUp 不取消用户命令；与 userSeek 目标冲突时记录 rejected；
   * 5. paused 状态下 resume 解冻，pause 幂等，位置命令立即重锚（保持暂停）。
   */
  private dispatch(command: Command): void {
    const nowPerfMs = command.issuedPerfMs;
    this.log.record({
      perfMs: nowPerfMs,
      event: command.kind,
      phase: 'received',
      state: this.state,
      mediaMs: this.getMediaMs(nowPerfMs),
      outputLatencyMs: this.outputLatencyMs,
      detail: commandDetail(command),
    });

    if (command.kind === 'end') {
      this.applyEnd(command);
      return;
    }

    if (this.state === 'buffering') {
      if (command.kind === 'userSeek') {
        this.removePendingByKind('catchUp');
      }
      this.pending.push(command);
      this.log.record({
        perfMs: nowPerfMs,
        event: command.kind,
        phase: 'queued',
        state: this.state,
        mediaMs: this.getMediaMs(nowPerfMs),
        outputLatencyMs: this.outputLatencyMs,
        detail: { ...commandDetail(command), queueLength: this.pending.length },
      });
      return;
    }

    this.applyCommand(command, nowPerfMs);
  }

  /**
   * 应用命令。返回 true 表示命令触发了新的缓冲（调用方应停止处理后续队列）。
   */
  private applyCommand(command: Command, nowPerfMs: number): boolean {
    switch (command.kind) {
      case 'pause':
        this.applyPause(command);
        return false;
      case 'resume':
        this.applyResume(command);
        return false;
      case 'end':
        this.applyEnd(command);
        return false;
      case 'userSeek':
      case 'catchUp':
        return this.applySeek(command, nowPerfMs);
      default: {
        const exhaustive: never = command;
        throw new Error(`unhandled command: ${String(exhaustive)}`);
      }
    }
  }

  private applyPause(command: Extract<Command, { kind: 'pause' }>): void {
    const nowPerfMs = command.issuedPerfMs;
    if (this.state === 'paused' || this.state === 'ended' || this.state === 'idle') {
      this.reject(command, nowPerfMs, `state=${this.state}`);
      return;
    }
    const mediaMs = this.getMediaMs(nowPerfMs);
    const previous = this.state;
    this.state = 'paused';
    this.anchor = { mediaMs, perfMs: nowPerfMs, rate: 0, outputLatencyMs: this.outputLatencyMs };
    this.log.record({
      perfMs: nowPerfMs,
      event: 'pause',
      phase: 'applied',
      state: previous,
      mediaMs,
      outputLatencyMs: this.outputLatencyMs,
      detail: { seq: command.seq },
    });
    this.emit('stateChange', { state: 'paused', perfMs: nowPerfMs });
  }

  private applyResume(command: Extract<Command, { kind: 'resume' }>): void {
    const nowPerfMs = command.issuedPerfMs;
    if (this.state !== 'paused') {
      this.reject(command, nowPerfMs, `state=${this.state}`);
      return;
    }
    const mediaMs = this.anchor.mediaMs;
    this.state = 'playing';
    this.anchor = { mediaMs, perfMs: nowPerfMs, rate: 1, outputLatencyMs: this.outputLatencyMs };
    this.log.record({
      perfMs: nowPerfMs,
      event: 'resume',
      phase: 'applied',
      state: 'paused',
      mediaMs,
      outputLatencyMs: this.outputLatencyMs,
      detail: { seq: command.seq },
    });
    this.emit('stateChange', { state: 'playing', perfMs: nowPerfMs });
  }

  private applyEnd(command: Extract<Command, { kind: 'end' }>): void {
    const nowPerfMs = command.issuedPerfMs;
    const mediaMs = this.getMediaMs(nowPerfMs);
    const dropped = this.pending.splice(0);
    const previous = this.state;
    this.state = 'ended';
    this.bufferReason = null;
    this.anchor = { mediaMs, perfMs: nowPerfMs, rate: 0, outputLatencyMs: this.outputLatencyMs };
    this.log.record({
      perfMs: nowPerfMs,
      event: 'end',
      phase: 'applied',
      state: previous,
      mediaMs,
      outputLatencyMs: this.outputLatencyMs,
      detail: { seq: command.seq, droppedCommands: dropped.length },
    });
    this.emit('stateChange', { state: 'ended', perfMs: nowPerfMs });
  }

  private applySeek(command: SeekCommand, nowPerfMs: number): boolean {
    const currentMediaMs = this.getMediaMs(nowPerfMs);

    // 自动追直播与用户意图冲突：用户拖动/暂停优先，catchUp 让行。
    if (command.kind === 'catchUp') {
      const userIntent = this.pending.some((c) => c.kind === 'userSeek') || this.state === 'paused';
      if (userIntent) {
        this.reject(command, nowPerfMs, 'userIntentWins');
        return false;
      }
    }

    const errorMs = command.targetMediaMs - currentMediaMs;
    if (Math.abs(errorMs) < 0.001) {
      this.log.record({
        perfMs: nowPerfMs,
        event: command.kind,
        phase: 'rejected',
        state: this.state,
        mediaMs: currentMediaMs,
        outputLatencyMs: this.outputLatencyMs,
        errorMs: round3(errorMs),
        detail: { reason: 'noOp', seq: command.seq },
      });
      return false;
    }

    // 目标位置未缓冲：进入 buffering(seek)，命令保留在队列最前等待数据。
    if (!this.isBuffered(command.targetMediaMs)) {
      if (command.kind === 'userSeek' && this.state !== 'buffering') {
        this.removePendingByKind('catchUp');
      }
      this.enterBuffering('seek', nowPerfMs);
      this.pending.unshift(command);
      this.log.record({
        perfMs: nowPerfMs,
        event: command.kind,
        phase: 'queued',
        state: 'buffering',
        mediaMs: this.getMediaMs(nowPerfMs),
        outputLatencyMs: this.outputLatencyMs,
        errorMs: round3(errorMs),
        detail: { reason: 'awaitData', targetMediaMs: command.targetMediaMs, seq: command.seq },
      });
      return true;
    }

    const previous = this.state;
    const rate = this.state === 'paused' ? 0 : 1;
    this.anchor = {
      mediaMs: command.targetMediaMs,
      perfMs: nowPerfMs,
      rate,
      outputLatencyMs: this.outputLatencyMs,
    };
    this.log.record({
      perfMs: nowPerfMs,
      event: command.kind,
      phase: 'applied',
      state: previous,
      mediaMs: command.targetMediaMs,
      outputLatencyMs: this.outputLatencyMs,
      errorMs: round3(errorMs),
      detail: { targetMediaMs: command.targetMediaMs, seq: command.seq, keptPaused: rate === 0 },
    });
    this.emit('anchorReset', {
      perfMs: nowPerfMs,
      mediaMs: command.targetMediaMs,
      rate,
      source: command.kind,
    });
    return false;
  }

  private reject(command: Command, nowPerfMs: number, reason: string): void {
    this.log.record({
      perfMs: nowPerfMs,
      event: command.kind,
      phase: 'rejected',
      state: this.state,
      mediaMs: this.getMediaMs(nowPerfMs),
      outputLatencyMs: this.outputLatencyMs,
      detail: { reason, seq: command.seq },
    });
  }

  private removePendingByKind(kind: CommandKind): number {
    const before = this.pending.length;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const command = this.pending[i];
      if (command && command.kind === kind) {
        this.log.record({
          perfMs: command.issuedPerfMs,
          event: command.kind,
          phase: 'rejected',
          state: 'buffering',
          mediaMs: this.anchor.mediaMs,
          outputLatencyMs: this.outputLatencyMs,
          detail: { reason: 'preemptedByUser', seq: command.seq },
        });
        this.pending.splice(i, 1);
      }
    }
    return before - this.pending.length;
  }

  // ----------------------------------------------------- 输出延迟（蓝牙）突变

  /**
   * 输出设备延迟变化（有线 -> 蓝牙耳机等）。
   * 规则：媒体时间锚点按“同一外部时刻、同一媒体位置”重锚，
   * 延迟量仅作为音频调度补偿，不允许改变声画各自的媒体位置。
   * 冻结态同样更新锚点上的延迟字段，恢复后自动使用新延迟。
   */
  latencyChange(info: LatencyInfo): void {
    const nowPerfMs = info.perfMs;
    const previousLatency = this.outputLatencyMs;
    const deltaMs = info.outputLatencyMs - previousLatency;
    if (Math.abs(deltaMs) < 0.001) {
      return;
    }
    const mediaMs = this.getMediaMs(nowPerfMs);
    this.outputLatencyMs = info.outputLatencyMs;
    this.anchor = {
      mediaMs,
      perfMs: nowPerfMs,
      rate: this.anchor.rate,
      outputLatencyMs: info.outputLatencyMs,
    };
    this.log.record({
      perfMs: nowPerfMs,
      event: 'latencyChange',
      phase: 'applied',
      state: this.state,
      mediaMs,
      outputLatencyMs: info.outputLatencyMs,
      errorMs: round3(deltaMs),
      detail: {
        baseLatencyMs: round3(info.baseLatencyMs),
        previousLatencyMs: round3(previousLatency),
      },
    });
    this.emit('latencyChange', {
      perfMs: nowPerfMs,
      mediaMs,
      outputLatencyMs: info.outputLatencyMs,
      baseLatencyMs: info.baseLatencyMs,
      deltaMs,
    });
    this.emit('anchorReset', {
      perfMs: nowPerfMs,
      mediaMs,
      rate: this.anchor.rate,
      source: 'latencyChange',
    });
  }

  // ------------------------------------------------------- 缓冲区间 / 直播边缘

  /**
   * 更新已缓冲区间与直播边缘位置（由数据喂给层调用）。
   * 返回当前播放位置是否已经欠载，供控制器决定是否进入 buffering(underrun)。
   */
  updateBufferedRange(
    fromMediaMs: number,
    toMediaMs: number,
    liveEdgeMediaMs: number,
    nowPerfMs: number = this.clock.now(),
  ): { underrun: boolean; lagMs: number } {
    this.bufferedFromMs = fromMediaMs;
    this.bufferedToMs = toMediaMs;
    this.liveEdgeMs = liveEdgeMediaMs;
    const mediaMs = this.getMediaMs(nowPerfMs);
    const lagMs = Math.max(0, liveEdgeMediaMs - mediaMs);
    const underrun = this.state === 'playing' && mediaMs >= toMediaMs;
    this.log.record({
      perfMs: nowPerfMs,
      event: 'bufferRange',
      phase: 'received',
      state: this.state,
      mediaMs,
      outputLatencyMs: this.outputLatencyMs,
      errorMs: round3(lagMs),
      detail: {
        fromMediaMs: round3(fromMediaMs),
        toMediaMs: round3(toMediaMs),
        liveEdgeMediaMs: round3(liveEdgeMediaMs),
        underrun,
      },
    });
    return { underrun, lagMs: round3(lagMs) };
  }

  /** 数据层报告数据就绪：若处于缓冲且条件满足则解冻，并继续处理排队命令。 */
  notifyDataAvailable(nowPerfMs: number = this.clock.now()): BufferEndResult | null {
    if (this.state !== 'buffering') {
      return null;
    }
    const head = this.pending[0];
    // seek 缓冲必须等队首目标数据到位；其余缓冲（underrun/background/initial）
    // 先恢复，再由 endBuffering 处理排队命令，必要时重新进入 seek 缓冲。
    if (
      this.bufferReason === 'seek'
      && head
      && (head.kind === 'userSeek' || head.kind === 'catchUp')
      && !this.isBuffered(head.targetMediaMs)
    ) {
      return null;
    }
    if (this.bufferReason !== 'seek' && this.getMediaMs(nowPerfMs) > this.bufferedToMs) {
      return null;
    }
    return this.endBuffering(nowPerfMs);
  }

  /** 追直播策略的纯函数判定：返回建议目标位置，null 表示无需追。 */
  planCatchUp(
    policy: CatchUpPolicy,
    nowPerfMs: number = this.clock.now(),
  ): { targetMediaMs: number; lagMs: number } | null {
    if (this.state !== 'playing') {
      return null;
    }
    const lagMs = this.getLiveEdgeLagMs(nowPerfMs);
    if (lagMs <= policy.thresholdMs) {
      return null;
    }
    const mediaMs = this.getMediaMs(nowPerfMs);
    const targetMediaMs = Math.min(this.liveEdgeMs - policy.withinMs, mediaMs + policy.stepMs);
    if (targetMediaMs <= mediaMs) {
      return null;
    }
    return { targetMediaMs: round3(targetMediaMs), lagMs: round3(lagMs) };
  }

  /** 调试用：查看冻结期间排队命令（返回副本）。 */
  pendingCommands(): readonly Command[] {
    return [...this.pending];
  }

  snapshot(nowPerfMs: number = this.clock.now()): ClockSnapshot {
    return {
      state: this.state,
      mediaMs: round3(this.getMediaMs(nowPerfMs)),
      outputLatencyMs: this.outputLatencyMs,
      anchor: { ...this.anchor },
      liveEdgeLagMs: round3(this.getLiveEdgeLagMs(nowPerfMs)),
      bufferedToMs: round3(this.bufferedToMs),
    };
  }

  private nextSeq(): number {
    return ++this.seq;
  }
}

/** 判断状态是否冻结媒体时间。 */
export function isFrozen(state: PlaybackState): boolean {
  return FROZEN_STATES.has(state);
}

function commandDetail(command: Command): Record<string, string | number | boolean> {
  if (command.kind === 'userSeek' || command.kind === 'catchUp') {
    return { seq: command.seq, targetMediaMs: round3(command.targetMediaMs) };
  }
  return { seq: command.seq };
}

/** 时钟对外事件定义，渲染侧通过订阅联动而不是自行计时。 */
export type ClockEvent =
  | 'stateChange'
  | 'bufferStart'
  | 'bufferEnd'
  | 'anchorReset'
  | 'latencyChange';

export interface ClockEventMap {
  stateChange: { state: PlaybackState; perfMs: number };
  bufferStart: { reason: BufferReason; perfMs: number; mediaMs: number };
  bufferEnd: {
    reason: BufferReason | null;
    perfMs: number;
    mediaMs: number;
    frozenMs: number;
  };
  anchorReset: { perfMs: number; mediaMs: number; rate: number; source: string };
  latencyChange: {
    perfMs: number;
    mediaMs: number;
    outputLatencyMs: number;
    baseLatencyMs: number;
    deltaMs: number;
  };
}
