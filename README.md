# Sample-safe audio device migration

一个无第三方依赖的网页播放器示例，修复耳机/扬声器切换时的丢样、重复小段、
视频慢半拍和不可恢复状态。核心逻辑是 TypeScript，测试直接由 Node.js 标准库
运行；浏览器侧使用 WebAudio、AudioWorklet、WebCodecs、Canvas 和 MediaSource。

## 运行

要求 Node.js 24+（直接执行 TypeScript 和 `node:test`）。

```bash
npm test
npm start
```

打开 `http://127.0.0.1:4173`。`npm start` 会先用 Node 内置的
`stripTypeScriptTypes` 把 `src/**/*.ts` 构建到 `dist/src`，再启动零依赖静态
服务器。

演示页面：

- Play/Pause 后可直接切换输出设备、采样率和单/立体声布局；
- 播放中拖动进度条会合并请求并递增 generation；
- 设备被拔掉或上下文进入 `interrupted` 时状态变为 `interrupted`，`Recover`
  从最后确认的源帧重建；
- `public/demo-video.mp4` 是本地生成的无声 H.264 测试片段，通过 MediaSource
  装载，再以 `VideoFrame` 画到 Canvas；没有该文件时自动退回 Canvas 动画。
  该资产已包含在仓库中，运行时不依赖 ffmpeg。

## 为什么不会丢样或重复

播放位置保存在**源样本帧域**，类型为约分后的 `Fraction`。设备采样率和声道
布局是渲染参数，不是时间原点。

迁移协议：

```text
playing old sink
  -> old worklet fades out (source frames still advance)
  -> handoff returns exact source cursor + output frame count
  -> old AudioContext closes
  -> new sink opens at the same cursor
  -> new worklet fades in and continues
```

控制器状态机串行化这些操作。迁移期间的新 seek 会更新 `seekRevision`，迁移任务
在看到新 revision 后不会采用旧 handoff 边界。每次 sink/seek 都带
`generation`，旧 worklet 的迟到进度不会回写新 transport。

## 自动复现

`npm test` 当前包含 9 个测试：

| 场景 | 断言 |
| --- | --- |
| 同采样率耳机→扬声器 | 输出区间逐帧连续，拼接样本等于源样本，不重复 |
| 48k 立体声→44.1k 单声道 | 1001 帧处 handoff，下一块严格从 `1001` 开始，覆盖到 `5801` |
| 暂停后切设备 | 位置保持、状态仍为 paused，恢复后从原帧播放 |
| 播放中设备消失 | `interrupted`/`recoverable`，保留 `resumeIntent` 与位置 |
| 暂停中设备消失 | 恢复后仍为 paused，不擅自播放 |
| 播放中拖动 | 旧位置后续样本不会再进入输出 |
| 迁移中拖动 | seek 目标胜过旧 handoff 边界，没有回放旧段 |
| 新设备打开失败 | 保留可恢复位置，recover 后继续 |
| AudioWorklet | 淡出后才回传边界，新实例从同一边界淡入 |

说明：物理 DAC/蓝牙链路延迟不在样本级测试范围内；测试证明的是进入音频图表的
源样本覆盖唯一且连续。

## 代码结构

- `src/core/fraction.ts`：源帧分数位置与时间换算。
- `src/core/pcm-source.ts`：连续 PCM 时间轴与声道映射。
- `src/core/source-renderer.ts`：源采样率到设备采样率的确定性插值。
- `src/core/playback-controller.ts`：迁移、暂停、设备丢失、seek 的可恢复状态机。
- `src/browser/pcm-player.worklet.ts`：实时源帧渲染、generation、淡入淡出和边界回报。
- `src/browser/pcm-audio-sink.ts`：AudioContext/`setSinkId`/worklet 适配。
- `src/browser/media-source-surface.ts`：MediaSource 装载与 `VideoFrame` 绘制。
- `src/browser/main.ts`：Canvas 播放器 UI 和请求合并。
- `tests/`：Node 标准库复现，不依赖浏览器或 npm 包。

根因的完整分析见 [docs/root-cause.md](./docs/root-cause.md)。

## 浏览器约束

- 设备级 `AudioContext.setSinkId()` 和 AudioWorklet 需要较新的 Chromium 系浏览器；
- 浏览器可能把请求的声道数钳制到 `destination.maxChannelCount`，实际值会显示在
  “transport” 卡片中；
- 自动播放策略要求先点击 Play 才会 `resume()` 音频上下文；
- 设备被系统移除时，WebAudio 上下文可能进入 `interrupted`；此时无法再做优雅
  淡出，但 transport 位置和恢复意图仍然保留。
