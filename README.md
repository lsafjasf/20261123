# 本地转码任务调度器

转码机同时跑上传、代理、成片输出时，一个大任务吃光内存会把做了一半的小任务全部拖垮。
本项目是一个**纯本地、零依赖、零云服务**的任务调度系统，按 CPU / 内存 / 临时磁盘配额排队，
支持优先级、取消、断点恢复、自动重试，并在资源挤占时把任务**安全暂停在检查点**，绝不留下半个文件。

技术栈严格限定为：TypeScript、Node.js 标准库、WebCodecs、WebAudio、Canvas、MediaSource。
不安装任何 npm 依赖（`dependencies` 为空），Node ≥ 22.13 原生执行 TypeScript。

## 快速开始

```bash
npm start          # 启动调度服务与控制台，默认 http://localhost:8080
PORT=8091 npm start
npm run demo       # 离线演示：大任务占资源 + 小任务排队 + 暂停恢复全过程
npm test           # 15 个单元/集成测试（node:test，串行执行）
```

打开浏览器访问控制台后，页面内的 WebCodecs Worker 会自动上线并领取 `transcode` 类型任务；
`upload` / `proxy` / `output` 三类任务由 Node 侧 `worker_threads` 执行。

## 目录结构

```
src/
  shared/protocol.ts        浏览器/Node 共享协议与类型（纯类型，可被 TS 剥离直接加载）
  server/
    config.ts               配额、目录、租约/退避/老化参数
    scheduler.ts            核心调度器：准入、压力暂停、重试、租约回收、产物合并
    priorityQueue.ts        带老化的优先级队列
    metrics.ts              /proc 采样 CPU/内存，目录扫描采样临时盘
    stateStore.ts           原子快照持久化 + 崩溃恢复 + 决策日志
    events.ts               类型安全事件总线
    httpServer.ts           原生 http + SSE，含浏览器 TS 即时转译
    demo.ts                 离线演示
    util/atomic.ts          原子写、分段合并、目录计量
    executor/
      executor.ts           执行器抽象与信号语义
      localExecutor.ts      worker_threads 执行池
      jobWorker.ts          线程内任务循环（chunk 边界检查暂停/取消）
      browserExecutor.ts    浏览器 WebCodecs Worker 的租约管理
  browser/
    index.html / styles.css 控制台
    app.ts                  SSE 实时同步、任务操作、提交表单
    chart.ts                Canvas 资源曲线（实际用量实线 + 调度预留虚线）
    transcodeClient.ts      主线程 Worker 管理：claim/续租/信号/分段上传
    transcodeWorker.ts      OffscreenCanvas + VideoEncoder + OfflineAudioContext
    webmMuxer.ts            手写 EBML/WebM 复用器（ArrayBuffer/DataView）
    msePreview.ts           MediaSource 分片播放产出的 WebM
test/                       node:test 单元与集成测试
```

## 调度模型

- **配额准入**：每个任务声明 `cpu / memoryMB / tmpMB`，调度器每 500ms 扫描队列，
  只有三类资源的“已预留 + 本任务需求”都不超过整机配额时才准入；否则记录具体等待原因
  （`cpu-quota` / `memory-quota` / `tmp-disk-quota` / `max-concurrency` / `resource-pressure` 等）。
- **优先级 + 老化**：显式优先级高的先调度；任务每等待 4 秒等效优先级 +1，
  低优先级的小任务等久了也会反超，不会被大任务永久饿死。
- **资源挤占安全暂停**：监控发现预留量逼近配额阈值时，挑选内存申请最大、进度最低的运行任务，
  下发暂停信号；执行器只在 chunk 边界落盘检查点后停下，临时分段始终一致。
- **取消**：同样在 chunk 边界生效，执行器清理该任务的整个 staging 目录，正式产物目录不受污染。
- **断点恢复**：每个 chunk 完成即 fsync 分段并上报检查点；状态快照原子写盘。
  进程崩溃重启后，运行中的任务依据最后检查点恢复为 `paused`，一键恢复即可续跑。
- **重试**：执行失败按 1s、2s、4s… 指数退避重新排队，超过 `maxRetries` 才标记 `failed`。
- **不留半个文件**：正式产物永远先写同目录 `.tmp`/`.partial`，`fsync` 后 `rename` 原子到位；
  崩溃只可能残留 staging 临时分段，不会出现半个正式文件。
- **浏览器租约**：WebCodecs Worker 通过长轮询领取任务、每次进度回报续租 15s；
  页面崩溃或断网导致租约超时，任务自动带着检查点安全回收。

## 页面能看到什么

- **资源曲线**：Canvas 绘制 CPU / 内存 / 临时盘的实际用量（实线）与调度预留（虚线），
  压力区间红色高亮。
- **等待原因**：任务表为每个排队/暂停任务展示原因码与中文明细，
  右侧“调度决策流”按时间列出每次准入、暂停、退避与回收决策。
- **操作**：排队/运行中的任务可暂停，暂停态可恢复，任何非终结态可取消。
- **成片预览**：WebCodecs 产出的 WebM 通过 MediaSource 分片流式播放。

## 数据目录

运行后在工作目录生成 `data/`（已 gitignore）：

- `data/files/` 上传源文件
- `data/staging/<taskId>/` 任务级临时分段，完成或取消后清理
- `data/outputs/` 原子落地的正式产物
- `data/state/tasks.json` 状态快照，`data/state/decisions.log` 决策追加日志

## 设计约束与取舍

- 浏览器端 TypeScript 由 Node 标准库 `module.stripTypeScriptTypes` 即时转译后下发，
  因此源码只使用“可剥离”的 TS 语法（无参数属性、枚举等需要代码生成的特性）。
- WebM 复用器是面向本场景的最小 EBML 实现（VP9 + Opus 单流），可被 Chrome MediaSource 直接播放，
  不追求覆盖完整 Matroska 规范。
- 无浏览器环境时，后端三类任务与全部调度能力均可独立运行并被测试覆盖；
  WebCodecs 路径通过类型转译与接口契约保证正确性。
