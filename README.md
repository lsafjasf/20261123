# 野径直播：本机 90 秒关键帧回放

面向户外直播的本地回放原型：直播编码持续运行，最近 90 秒只写入浏览器内存；按下回放时从关键帧开始生成独立 WebM 片段，再交给 `MediaSource` 播放。不依赖 npm 包、CDN、云存储或外部服务。

## 运行

要求 Node.js 22.13+，推荐 Chrome / Edge 116+：

```bash
npm start
```

打开 `http://127.0.0.1:4173`。不需要执行 `npm install`，项目没有第三方依赖。

- 默认只监听 `127.0.0.1`，可通过 `HOST`、`PORT` 修改。
- 点击“开始直播”会请求本机摄像头和麦克风；拒绝权限时自动使用 Canvas 演示画面和 WebAudio 合成环境声。
- 直播仍在继续时回放不会暂停主编码。回放片段也可从历史表下载为本地 `.webm` 文件。

## 数据流

```text
Canvas / camera
      │
      ├─ VideoFrame ──► WebCodecs VideoEncoder (VP8) ─┐
      │                                               ├─ 90s keyframe ring
WebAudio / microphone                                  │
      └─ AudioWorklet ─► AudioData ─► AudioEncoder ───┘
                                      (Opus)

按下回放
  ring.snapshot() ─► 深拷贝 + Transfer ─► Web Worker
  Worker: VP8/Opus chunks ─► 本地 WebM 封装
  Main: ArrayBuffer ─► Blob + MediaSource ─► video
```

关键实现：

- `src/ring-buffer.ts`：只保存完整 GOP；时间窗口和内存预算淘汰都以整个 GOP 为单位。窗口以关键帧对齐，可能比 90 秒多出不超过一个 GOP。
- `src/live-recorder.ts`：约 30fps Canvas 编码、每 2 秒强制关键帧、AudioWorklet PCM 采集与 Opus 编码。
- `src/webm-muxer.ts`：零依赖 Matroska/WebM 封装，按毫秒时间轴重排 VP8 与 Opus。
- `src/replay-worker.ts`：在独立 Worker 中完成封装，主线程继续编码和更新直播画面。
- `src/app.ts`：MediaSource 回放、互斥重复点击、缓冲水位和每次回放区间历史。

## 可靠性约束

- **按关键帧取回**：快照强制以 `key` 帧开头；测试会拒绝任何首帧不是关键帧的片段。
- **只淘汰完整 GOP**：不会为了压时间或压内存而切断活动 GOP。
- **存储满/码率突增**：内存超预算时先丢最旧完整 GOP；如果唯一活动 GOP 自身超预算，仍完整保留，并在页面标记“活动 GOP 超预算”。压力达到 82% 时编码器提前请求下一个关键帧。
- **快照隔离**：点击回放时立刻复制所有 chunk 字节，再把副本转移给 Worker。之后直播继续写入或淘汰缓冲，都不会改写正在封装的片段。
- **重复点击**：互斥锁与递增 `requestId` 阻止并发封装和过期结果覆盖；重复点击只提示，不触碰环形缓冲。
- **主直播不中断**：封装在 Worker 中进行；主线程只做快照和 MediaSource 装载。
- **本地资源**：服务端 CSP 限定 `'self'`，Worker、AudioWorklet、模块和媒体都来自本机；不存在远程连接。

## 页面信息

- 缓冲水位：已保留秒数、90 秒标尺、完整 GOP 数量、最旧关键帧序号、内存占用与音频帧数。
- 编码状态：实时估算码率、视频帧数、跳过帧数、音频来源。
- 回放区间：每次生成记录绝对本地时间段、时长、起始关键帧、数据量、状态与下载链接。

## 验证

```bash
npm test        # 环形缓冲、淘汰、快照隔离、突发码率、WebM 结构
npm run check   # 上述测试 + TS 转译 + 本机 HTTP 服务检查
```

开发中还使用本机 `ffprobe` 对真实 VP8/Opus 帧生成的片段做过验证：容器识别为 `vp8 + opus`，可完整解码。`ffprobe` 仅用于验证，不是项目依赖。

## 浏览器说明

- 需要安全上下文；`127.0.0.1` / `localhost` 可直接使用摄像头。
- 依赖 `VideoEncoder`、`AudioEncoder`、`AudioWorklet`、`MediaSource`。不支持 WebCodecs VP8/Opus 或 WebM MediaSource 的浏览器会显示错误；Safari 不建议用于本项目。
- 环形缓冲保存在页面进程内存，刷新页面即释放；下载过的 WebM 由浏览器保存。
