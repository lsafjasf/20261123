# 拟音轨工作室 · Foley Frame Sync

为动画预览建立拟音轨的离线工具：按帧范围与合成音效生成提示点（cue），
在任意帧率下得到**采样精确**的触发点，支持逐采样微调与重叠，导出的清单
重新载入后位置**逐位一致**。

零外部依赖：TypeScript 源码由 Node 24 内置的类型擦除直接运行/构建，
浏览器端只用 WebCodecs、WebAudio、Canvas、MediaSource 平台 API。

## 运行

```sh
npm start          # 构建 public/js 并启动 http://localhost:8046
npm test           # node --test（27 项单元测试）
npm run build      # 仅构建浏览器端 JS
```

## 同步模型（为什么重载后位置不变）

- 帧率以有理数存储（`fpsNum/fpsDen`，如 30000/1001），采样率整数。
- 帧 N 的触发采样 = `ceil(N · sampleRate · fpsDen / fpsNum)`，用 BigInt
  精确取整——即"属于该帧的第一个采样"，声音绝不早于画面帧，且
  `sampleToFrame(frameToSample(N)) === N` 严格成立（见 `src/shared/timebase.ts`）。
- 提示点只存整数：`frame` + `offsetSamples`（可负，用于逐采样微调）。
  浮点秒从不落盘，因此导出 → 重载是字节级不动点
  （`src/shared/cuelist.ts` 的 `verifyRoundTrip`）。
- 播放时 AudioContext 时钟是唯一主时钟，画面帧与音频调度都从它经
  整数换算派生，不存在需要"修复"的录音时钟漂移——合成器即事实来源。

## 使用流程

1. 选帧率（23.976–60，含 NTSC 拉降），用走带键或时间轴定位；
   在时间轴上拖拽或输入入点/出点选择帧范围。
2. **对齐画面事件生成**：脚步、皮球碰撞、开门（锁舌/吱呀/撞门）自动
   吸附到参数化动画的事件帧；也可按固定间隔或在播放头手动添加。
3. 在清单表格里逐帧/逐采样微调、调节增益；同一帧可叠任意多条 cue。
4. 导出 JSON 清单（或保存到服务器 `data/`），重载验证一致性；
   **渲染 WAV** 用 OfflineAudioContext 混出整条拟音轨。
5. **录制动画预览**：Canvas → VideoFrame → VideoEncoder(VP9/VP8)
   → 手写 EBML 复用 → MediaSource 播放，全程离线。

## 结构

```
src/shared/    timebase.ts（帧↔采样精确换算）cuelist.ts（清单模型/序列化）scene.ts（参数化动画+事件）
src/client/    transport/scheduler（走带与预读调度）synth/render（合成与混音）
               animator/timeline（Canvas 画面）webmMux/recorder（WebCodecs→MediaSource）
server/        server.ts（静态服务 + 清单存取，仅 Node 标准库）
test/          node:test 单元测试（时基、清单往返、场景事件、复用器）
```
