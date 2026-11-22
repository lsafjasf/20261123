# 统一媒体时钟 · 会议直播声画同步引擎

针对会议直播在**暂停、切后台、蓝牙耳机延迟变化**时出现的声画分离问题，
用一个统一媒体时钟（`MediaClock`）独占驱动播放状态与时间线：

- 缓冲 / 暂停 / 切后台时，画面与声音在**同一 PTS 一起冻结**；
- 恢复后从冻结的**同一位置**继续，不跳变、不静音追赶；
- 蓝牙耳机延迟突变只改变音频调度补偿，**不允许改变声画各自的媒体位置**；
- 用户拖动与自动追直播冲突时按**确定性优先级规则**仲裁；
- 每个事件的触发顺序、缓冲状态、媒体时间与误差都写入结构化日志。

技术限定：TypeScript、Node.js 标准库、WebCodecs、WebAudio（AudioWorklet）、
Canvas、MediaSource。**零第三方依赖、零外部服务，完全离线可用。**

## 目录结构

```
src/
  core/                 平台无关的时钟内核（可在 Node 直接测试）
    types.ts            领域类型：状态、命令、锚点、日志条目
    media-clock.ts      统一媒体时钟：状态机 + 时间锚点 + 确定性仲裁
    event-log.ts        结构化事件日志（seq 单调递增）
    file-log-sink.ts    Node 侧 JSONL 文件日志
    virtual-clock.ts    虚拟单调时钟（测试）/ performance.now 封装
  media/                媒体管线（同样平台无关）
    jitter-buffer.ts    音视频共用的 PTS 排序抖动缓冲
    frame-scheduler.ts  纯函数渲染调度：render / wait / skip 与误差量化
    sync-engine.ts      唯一驱动循环，串联时钟、缓冲、渲染器
    synthetic-source.ts 离线合成源（正弦 PCM + 视频帧，无网络）
    media-types.ts
  browser/              浏览器适配层
    audio-worklet.ts    AudioWorklet 精确播放循环（冻结即挂起）
    web-audio-renderer.ts  WebAudio 渲染 + outputLatency 轮询
    canvas-video-renderer.ts Canvas 渲染，冻结保留最后一帧
    webcodecs-decoder.ts   WebCodecs 解码封装
    media-source-transport.ts MediaSource 段管理与直播窗口回收
    live-session.ts     会话装配：所有外部事件的统一入口
    demo-main.ts        离线演示页控制器
  server/dev-server.mjs Node 标准库静态服务器（.ts 即时类型擦除）
scripts/
  typecheck.mjs         零依赖可擦除性闸门
  replay-scenario.mjs   Node 离线场景回放，产出 JSONL 日志
test/                   node:test 单元与端到端测试（29 个）
index.html              离线演示页
```

## 快速开始

要求 Node.js >= 22.6（开发与验证使用 Node 24，原生运行 TypeScript）。

```bash
npm test                 # 运行全部 node:test 测试（零依赖）
npm run check            # 校验所有 .ts 均为可擦除 TypeScript
node scripts/replay-scenario.mjs   # 离线事件链回放，写 artifacts/replay-log.jsonl
npm run serve            # 启动 http://localhost:8080/ 演示页
```

演示页完全离线：数据来自 `SyntheticSource` 本地合成，不请求任何外部地址。
服务器对 `.ts` 文件用 Node 内置 `stripTypeScriptTypes` 即时擦除，
浏览器以普通 ESM 加载，无需实验标志、无需打包器。

## 统一时间模型

整条管线只有一个时间事实源。`MediaClock` 维护时间锚点：

```
mediaMs(now) = anchor.mediaMs + (now - anchor.perfMs) * anchor.rate
```

- `rate = 1`：正常播放，媒体时间随外部单调时钟（`performance.now` 语义）推进；
- `rate = 0`：缓冲 / 暂停 / 结束，媒体时间恒定，画面与声音共同冻结；
- 输出延迟（蓝牙耳机 `outputLatency`）是**独立字段**，只参与音频提前调度，
  不并入媒体时间，因此延迟突变时执行“同一外部时刻、同一媒体位置”的重锚，声画位置都不动。

音频与视频渲染在每个 tick 读取**同一个 `currentMediaMs`**，
`FrameScheduler` 分别决策，杜绝两条独立时钟漂移。

## 状态机与确定性规则

状态集合：`idle -> buffering -> playing <-> paused`，以及 `ended`。

**缓冲冻结**

- `underrun`：播放位置追平缓冲边缘，进入缓冲并固化当前 PTS；
- `background`：页面切后台主动冻结，音频挂起、Canvas 保留最后一帧；
- `seek`：拖动目标未缓冲，命令保留在队列最前等待数据；
- `initial`：起播缓冲。
- 缓冲期间所有命令 FIFO 入队；`endBuffering` 从冻结 PTS 恢复后按序应用。

**拖动与追直播冲突仲裁（全部可从日志复盘）**

1. `end` 在任何状态立即生效并清空队列；
2. 缓冲期命令一律入队，解冻后按序执行；
3. 用户拖动（`userSeek`）**抢占式取消**所有排队 / 在途的自动追直播（`catchUp`），
   被取消的 `catchUp` 写 `rejected / preemptedByUser`；
4. 暂停态下到达的 `catchUp` 直接 `rejected / userIntentWins`，不破坏用户位置；
5. 追直播采用步长化策略（`thresholdMs / stepMs / withinMs`），目标不越过直播边缘；
6. 跳转目标未缓冲时进入 `buffering(seek)`，数据就绪后在目标位置解冻。

**蓝牙耳机延迟变化**

- `WebAudioRenderer` 轮询 `AudioContext.outputLatency`，突变时上报 `latencyChange`；
- 时钟按当前媒体位置重锚并记录延迟差（`errorMs = 新延迟 - 旧延迟`）；
- 冻结态同样更新锚点延迟字段，解冻后音频自动使用新补偿值。

## 事件日志契约

每个事件产出一条 `LogEntry`，`seq` 严格单调递增，
因此同一毫秒内的事件也能确定先后顺序：

```ts
interface LogEntry {
  seq: number;              // 全局触发顺序
  perfMs: number;           // 外部单调时钟读数
  event: string;            // userSeek/catchUp/bufferStart/bufferEnd/latencyChange...
  phase: 'received' | 'queued' | 'applied' | 'rejected' | 'scheduled';
  state: PlaybackState;     // 事件瞬间的播放状态
  mediaMs: number;          // 当前媒体时间
  outputLatencyMs: number;  // 当前输出延迟
  errorMs: number;          // 跳转误差 / 延迟差 / 呈现误差 / 冻结时长
  detail: Record<string, string | number | boolean>;
}
```

- 浏览器：`MemoryLogSink` + 页面日志面板实时展示；
- Node：`FileLogSink` 或 `scripts/replay-scenario.mjs` 落盘 JSONL；
- 渲染事件 `audioRender / videoRender` 的 `errorMs` 为帧 PTS 与统一时钟的呈现误差，
  正值偏早、负值迟到；跳帧记录 `audioSkip / videoSkip`。

## 浏览器装配关系

```
MediaSourceTransport (压缩段 append/remove、直播窗口回收)
        |  Encoded*Chunk
        v
WebCodecsDecoder -- MediaFrame{ptsMs} --> JitterBuffer（音视频共用，PTS 排序）
                                                  |
        MediaClock（唯一状态/时间事实源）<-- SyncEngine.tick()
                                                  | 同一 currentMediaMs
                   +------------------------------+------------------------------+
                   v                                                             v
        FrameScheduler(audio)                                       FrameScheduler(video)
                   |                                                             |
                   v                                                             v
  WebAudioRenderer + AudioWorklet                         CanvasVideoRenderer（冻结保留末帧）
  （outputLatency 补偿 / suspend）
```

- 演示页用 `SyntheticSource` 替代真实网络，保持 `MediaTransport` 接口一致；
  接入真实会议流时只需把 `MediaSourceTransport` 输出的段交给 `WebCodecsDecoder`。
- `LiveSession` 是唯一事件入口：暂停、恢复、拖动、切后台、延迟上报全部经它交给时钟仲裁。

## 测试

`node:test` 直接运行 TypeScript，共 31 个用例：

- `media-clock.test.ts`：状态机、冻结 / 恢复、暂停、拖动、仲裁、延迟突变、追直播计划；
- `jitter-buffer.test.ts` / `frame-scheduler.test.ts`：PTS 排序、窗口裁剪、调度与误差；
- `sync-engine.test.ts`：声画共同冻结、切后台、欠载、自动追直播、迟到跳帧；
- `e2e-session.test.ts`：组合事件链与全局日志顺序 / 缓冲耗时复盘；
- `file-log-sink.test.ts`：JSONL 落盘日志的顺序与可解析性。

## 设计约束与说明

- 全部源码是**可擦除 TypeScript**：不使用 `enum`、`namespace`、参数属性、装饰器，
  Node 与浏览器都能在无编译步骤下运行；`npm run check` 作为闸门守护该约束。
- 离线环境无法安装 `typescript` 包，因此未内置 `tsc --noEmit`；
  联网时可执行 `npx -p typescript tsc --noEmit`，仓库已附 `tsconfig.json`（strict）。
- 浏览器原生 API（WebCodecs / AudioWorklet / MediaSource）需要对应运行时支持；
  核心时钟与管线逻辑不依赖 DOM，已在 Node 用虚拟时钟完整测试。
- 演示页音频在首次点击“开始直播”时创建 / 恢复 `AudioContext`，符合浏览器自动播放策略。
