# 精确媒体时间轴

这个项目修复“成片画面比参考母版越来越晚”的时间轴漂移，并把检查结果从
“格式化秒数”改成**绝对帧号 + 绝对采样号 + 比例残差**。

实现只用 TypeScript、Node.js 标准库和浏览器原生 WebCodecs、WebAudio、
Canvas、MediaSource。没有第三方包，不访问网络。

## 根因

原来的错误链路是把逐帧时长先四舍五入到毫秒：

```text
30000/1001 fps
1000 / (30000/1001) = 33.366666... ms
Math.round(...)     = 33 ms
第 n 帧时间          = n * 33 ms
```

`33 ms` 比真实帧长短 `0.366666... ms`，误差随帧号线性增长。到第 3000 帧，
误差是 `1100 ms`；到第 1,000,000 帧，误差约 `366.667 s`。如果显示帧率或
时间基也不一致，误差还会更大。旧检查器把时间格式化成秒，掩盖了
“差几帧/几采样的绝对位置”这个问题。

四舍五入发生的准确环节是：

1. 容器帧时长被转成浮点毫秒；
2. 逐帧时长被取整成整数毫秒；
3. 取整后的时长被累加为下一帧时间；
4. 检查器只显示格式化秒数。

修复后，前三个环节都不再存在。唯一允许量化的位置是平台输出边界：
WebCodecs 整数微秒、Canvas 显示帧、WebAudio 输出采样、MediaSource 秒参数。
每次都从**绝对比例时间**计算一次并保留残差，不累加已量化的时长。

## 数据模型

所有存储值都是约分后的 `bigint` 比例：

- 源帧率：例如 `30000/1001`
- 显示帧率：例如 `24000/1001`
- 音频采样率：例如 `48000`
- 编辑时间：秒的精确比例，例如 `1001/10`
- 帧位置：整数绝对帧号
- 音频位置：整数绝对采样号

MP4 探测直接读取 `mvhd/mdhd` 的 `timescale`、`stts` 的样本时长和 `elst`
编辑项，因此 `90000 / 3003` 会保存成 `30000/1001`，不会先变成 `29.97`。
VFR 轨道不会被伪装成单一帧率。

## 运行

需要 Node.js 24 或更新版本（使用内置 TypeScript 类型擦除）。

```bash
npm test
npm run check
npm run prove
npm run build
npm run demo
```

浏览器打开 `http://127.0.0.1:4173/`。界面可以：

- 对 1 亿帧长度生成切点、字幕和音频事件；
- 显示最大帧残差和最大采样残差；
- 用 Canvas 画出绝对显示帧位置；
- 用 WebAudio 按绝对输出采样编号播放点击；
- 显示 WebCodecs 微秒时间戳和 MediaSource 帧定位计划。

还可以用 CLI 检查清单：

```bash
npm run checker -- examples/long-sequence.json --audit
```

输出示例：

```text
sourceFps=30000/1001 displayFps=30000/1001 audioSampleRate=48000
cut-1001s cut edit=1001s displayFrame=30000 frameResidual=0 audioSample=48048000 sampleResidual=0
...
PASS: 3/3 events; maxFrameResidual=30/1001 frame; maxSampleResidual=0 sample; zero global offset accepted
```

清单格式：

```json
{
  "sourceFps": "30000/1001",
  "displayFps": "30000/1001",
  "audioSampleRate": "48000",
  "events": [
    { "id": "cut-1", "kind": "cut", "at": "1001", "sourceFrame": "30000" },
    { "id": "sub-1", "kind": "subtitle", "start": "1001", "end": "1002" },
    { "id": "audio-1", "kind": "audio", "at": "1001", "end": "1002" }
  ]
}
```

`globalOffset`、`globalOffsetMs`、`manualOffset`、`syncOffset` 会被直接拒绝。
切点给出 `sourceFrame` 时，编辑时间必须精确等于该源帧的时间；不相等会报告
失败，而不会自动加偏移。

## 长序列证明

`test/regression.test.ts` 构造 12,000 个混合事件，跨度
`100,000,000` 帧（NTSC 下约 38.6 天）：

- 所有切点/字幕的 `displayFrame` 残差为 `0`；
- 所有音频事件的采样残差都在 `[-1/2, 1/2] sample` 内；
- 第 1,000,000 帧仍精确映射到显示帧 `1,000,000`；
- 同一帧对应音频采样 `1,601,600,000`，残差为 `0`；
- 没有全局偏移，也没有随长度增长的累计项。

同一测试还重放了旧算法：第 3000 帧已偏 `1100 ms`，证明误差来源与量级。

也可以直接运行：

```bash
npm run prove
```

它会再次生成 12,000 个事件并输出：

```text
PASS long sequence over 100000000 frames
events=12000 cuts=4000 subtitles=4000 audio=4000
maxFrameResidual=0 frame
maxSampleResidual=2/5 sample
frame 1000000: edit=100100/3s display=1000000 (residual=0) sample=1601600000 (residual=0)
legacy rounded frame duration=33ms; drift at frame 1000000=-366.667s
global offset: none
```

## 代码入口

- `src/time/rational.ts`：约分 bigint 有理数、显式取整策略、十进制仅用于显示
- `src/time/timeline.ts`：源帧、显示帧、音频采样与编辑时间的绝对换算
- `src/media/mp4/probe.ts`：从 MP4 容器读取精确帧率、采样率和编辑项
- `src/media/webcodecs.ts`：绝对微秒时间戳与解码帧对齐
- `src/media/webaudio.ts`：按绝对输出采样编号调度
- `src/media/canvas.ts`：以显示帧为键的 Canvas 呈现
- `src/media/mediasource.ts`：按显示帧定位 MediaSource
- `src/checker/`：精确清单检查和 CLI
- `src/diagnostics/rounding.ts`：四舍五入阶段审计与旧算法重放

`Rational.toPlatformNumber()` 只允许在浏览器 API 强制要求 `number` 时使用；
语言层的比较、排序、切点和检查全部使用比例。
