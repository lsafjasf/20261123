# 车载语音丢包修复台

针对网络短时丢包导致的“突然静音/音频断裂”，在接收端用缺口前后的样本重建一段**等时长**的过渡音频。算法会区分真实停顿、语音丢失、音乐边界和采样率边界，并把每个补齐区间、分析指标和算法状态写入可导出的诊断账本。

项目只使用 TypeScript、Node.js 标准库和浏览器原生 WebCodecs / WebAudio / Canvas / MediaSource，没有第三方运行时依赖、构建依赖或云服务。

## 快速开始

要求 Node.js `>= 22.13`（使用 Node 内置的 TypeScript 类型擦除能力）。

```bash
npm start
# 打开 http://127.0.0.1:4173
```

```bash
npm test       # 13 个 Node 原生测试
npm run check  # 构建 + 测试
npm run build  # 只构建到 dist/
```

无需 `npm install`。`npm start` 会先构建，再用 Node 标准库 HTTP 服务托管 `dist/`。

## 算法路径

1. **包完整性**：检查空通道、长度不一致、`NaN/Inf`、异常静音声道。立体声中一个损坏声道可由健康声道重建；单声道整包不可用时按相邻有效包补齐。
2. **时间线检测**：同时使用序号缺口和 `timestampUs` 差异，连续丢包合并为一个区间；乱序/重复包拒绝并记录重同步事件。
3. **缺口分析**：取缺口前后约 24 ms 的上下文，计算 RMS、归一化相关、基频周期、过零率比和电平差。
4. **分类与填充**：

| 分类 | 判据 | 处理方法 |
| --- | --- | --- |
| `true-pause` | 两端都低于停顿阈值 | 精确静音，不把停顿“补成声音” |
| `music-boundary` | 两端活跃但相关低 / 基频或过零率跳变 | 前后纹理等功率交叉淡化 |
| `speech-loss` | 两端活跃且音色/基频连续 | 前向基频延续 + 后向基频延续，线性交叉淡化 |
| `onset-boundary` | 仅后侧活跃 | 缺口尾部短淡入 |
| `offset-boundary` | 仅前侧活跃 | 缺口头部短淡出 |
| `rate-boundary` | 采样率发生变化 | 预先重采样前侧上下文，再做双端短过渡 |

5. **时长约束**：输出帧数始终等于检测到的缺口帧数。超过 `maxConcealMs`（默认 120 ms）的连续缺口只补两端短过渡，中段明确静音并记入 `mutedFrames`，不会无限拖长或循环最后一块音频。
6. **可观测性**：每个区间保存 `analysis`、`transitions`、`classification`、`method`、`stateBefore`、`stateAfter`；顶层 `events` 保存逐事件状态快照，`state` 是最终状态。

默认参数位于 `src/core/dsp.ts` 的 `DEFAULT_OPTIONS`，可通过 `repairPackets(packets, overrides)` 覆盖。

## 代码接口

```ts
import { repairPackets } from "./src/index.ts";

const report = repairPackets(receivedPackets, {
  maxConcealMs: 120,
  edgeBlendMs: 8
});

report.packets;   // 已接收包 + origin: "concealed" 的补齐包
report.intervals; // 每个补齐区间及前后状态快照
report.events;    // channel-repaired / corrupt-packet / rate-change / gap-repaired
report.state;     // 最终算法状态
report.stats;     // 包数、缺口数、补齐帧、静音帧、采样率切换等
```

实时接入时可保留一个有效包作为前瞻：当前包到达后处理“上一有效包 → 当前包”之间的缺口；若当前包整包损坏，则等下一个有效包到达后提交该窗口。离线/测试路径可直接调用 `repairPackets`。

渲染与导出：

```ts
import { encodeWavPcm16, renderReport } from "./src/index.ts";

const repaired = renderReport(report, 48000);
const wavBytes = encodeWavPcm16(repaired.channels, repaired.sampleRate);
```

`renderReport(report, rate, true)` 会把补齐包置零，用于对比“未修复”版本。

## 浏览器诊断台

页面提供：

- 综合场景与单独场景切换：真实停顿、音乐边界、240 ms 连续丢包、采样率切换、单声道/整包损坏。
- Canvas 双层波形：上为未修复接收流，下为修复流；补齐区间按分类着色，点击可定位。
- WebAudio 试听修复流与未修复流。
- 区间账本、事件流、最终状态快照、完整区间 JSON 检查器。
- WAV 与诊断 JSON 本地导出。
- WebCodecs 将修复音频编码为 Opus，`src/media/webm.ts` 做最小 WebM 封装，再交给 MediaSource 播放；不支持时回退到 WAV/WebAudio。

## 测试覆盖

`tests/repair.test.ts` 覆盖：

- 连续丢包合并、补齐帧数与左右过渡；
- 真实停顿保持静音且总时长不变；
- 音乐边界使用等功率交叉淡化；
- 单声道损坏、立体声单通道损坏、整包不可用；
- 采样率切换及跨采样率缺口；
- 超长连续丢包封顶但不改变时长；
- 诊断 JSON 可序列化；
- WAV RIFF 头与 Opus WebM 基本结构；
- 综合演示流同时触发停顿、边界、连续丢包、损坏和采样率路径。

额外用 `ffprobe/ffmpeg` 验证过真实 Opus 包封装的 WebM 可被识别为 `opus/48000Hz` 并正常解码（该检查不进入自动测试，避免要求系统安装 ffmpeg）。

## 目录

```text
src/core/       丢包检测、完整性检查、分析、补齐、WAV/渲染
src/demo/       浏览器诊断台与合成车载语音场景
src/media/      Opus-in-WebM 最小封装器
tests/          Node 原生测试
scripts/        零依赖类型擦除构建与静态服务
```
