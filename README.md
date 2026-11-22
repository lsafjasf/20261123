# sync-lab

独立收音机换电池后产生的时钟漂移不是单一固定偏移：本工具在**完全离线、零外部依赖**的前提下，用两台设备都录到的拍手声与环境声分段估计时变偏移曲线，给出每段置信度，自动避开静音与音乐段，支持逐段试听复核，并导出后期软件可读的时间拉伸/偏移表与已渲染 WAV。

技术栈严格限定为 TypeScript + Node.js 标准库 + 浏览器 WebCodecs / WebAudio / Canvas / MediaSource，无云端、无 npm 依赖、无构建产物。

## 快速开始

要求 Node.js >= 22.18（开发与自测环境为 Node 24，原生执行 `.ts`）。

```bash
npm run selftest      # 合成已知漂移信号，验证整条算法链路
npm run fixtures      # 在当前目录生成 camera.wav / recorder.wav 合成样例
npm run serve         # http://localhost:8080/ 打开浏览器工作台
```

无头 CLI（适合批处理）：

```bash
npm run analyze -- path/to/camera.wav path/to/recorder.wav ./out
```

输出到 `./out`：

- `recorder-aligned.wav`：按偏移曲线变采样渲染后的 16-bit WAV。
- `sync-keyframes.csv`：每秒关键帧 `time_sec,timecode,offset_ms,stretch_factor,curve_confidence`，可直接映射到后期时间重映射/关键帧。
- `sync-segments.csv`：分段起止、首尾偏移、斜率 `ms/s`、拉伸系数、置信度、残差与锚点数。
- `sync-windows.csv`：每个分析窗口的类别、可用性、偏移、相关 z 值、置信度。
- `sync-project.json`：完整工程（参数、窗口、锚点、分段、符号约定），可重新加载或二次处理。
- `sync-labels.txt`：HH:MM:SS.mmm 标签，可导入多轨编辑器做人工核对。

## 浏览器工作流

1. 分别载入机头参考音与独立机录音（WAV 直解；MP3/M4A/AAC/MP4 走 WebCodecs 解封装，失败自动回退 `decodeAudioData`）。
2. 调整窗口长度、跳幅、最大偏移、静音阈值、音乐周期性上限与最大分段数，点击“分析漂移”。
3. 上方 Canvas 为波形与排除区，下方为偏移曲线：黄点是拍手/瞬态，蓝点是环境声，紫色/灰色覆盖为音乐与静音，绿色折线为分段拟合。
4. 点击曲线或表格选择窗口，在“机头 / 原录音 / 修正后 / 叠加监听”之间切换，可循环当前窗口试听拍点是否合拢。
5. 对误判窗口执行“排除/恢复”后自动重拟合；也可停用不可信分段。确认无误后在底部导出。

## 算法与符号约定

1. 两轨降混到单声道并在需要时线性重采样到 16 kHz 做分析（渲染仍使用原始采样率）。
2. 滑动窗口提取 RMS、峰值、过零率、自相关周期性与频谱通量起振数。
3. 分类规则：低于静音阈值 → `silence`；高周期性且无明显起振 → `music`；多起振 → `transient`；其余为 `ambient`。静音与音乐窗口不参与互相关。
4. 可用窗口做 FFT 域 GCC-PHAT 广义互相关，峰值经抛物线亚采样插值，输出相关 z 值与 0–1 置信度（相关显著性、瞬态密度、波峰因子加权）。
5. 锚点做 IRLS 稳健加权线性拟合，并以 BIC 在最大分段数内搜索连续分段（分段边界处偏移连续，仅斜率变化）。
6. 偏移符号：`offset_ms > 0` 表示独立机同一声音比机头**更晚**出现。渲染时读取 `rec(t) = camera(t) + offset(t)`，即把独立机前移对齐机头；分段 `stretch_factor = 1 + slope_ms_per_sec / 1000`。

置信度含义：窗口级置信度反映该窗口相关峰的可信程度；分段级置信度再综合锚点密度与加权残差。低置信分段会在界面与 CSV 中明确标出，建议人工试听后再决定是否启用。

## 目录结构

```
src/shared/    浏览器与 Node 共用的纯算法内核（FFT、GCC、特征、拟合、渲染、WAV、导出）
src/server/    Node 标准库 HTTP 服务、无头 CLI、合成夹具与自测
src/browser/   WebCodecs 解码、WebAudio 试听、Canvas 交互与导出
```

服务器对浏览器请求的 `.ts` 使用 Node 内置 `stripTypeScriptTypes` 即时下发，因此无需打包器或外部包；所有运算均在本机完成。
