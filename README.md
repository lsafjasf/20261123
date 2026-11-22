# APEX / Tape Stop Event Desk

帧锚定的赛车撞击“磁带停转”音效工作台。页面完全离线运行，不使用第三方包，也不请求外部字体、图片或音频。

## 启动

需要 Node.js 24+。

```bash
npm start
```

默认地址是 `http://127.0.0.1:5173`。端口被占用时：

```bash
PORT=5180 npm start
```

服务器启动时会用 `node:module.stripTypeScriptTypes` 把 `src/*.ts` 构建为浏览器 ES 模块，写入 `public/js/`。

## 操作

- `IMPACT FRAME` 决定画面冻结帧；`START FRAME` 决定减速起点。
- 时间轴上的绿色 `START` 和橙色 `MUTE` 手柄可以直接拖动。
- `SNAP 4 BEATS` 按当前 BPM 把起点放到撞击前四拍。
- `− / +` 或键盘 `[` / `]` 按当前帧率移动起点一帧。
- `PREVIEW` 或空格试听。试听从减速前 1.4 秒开始，画面与 WebAudio 时钟同步。
- 打开 `AUTO AUDITION ON START EDIT` 后，拖动/修改起点会防抖重渲染并自动试听。
- `EXPORT PACKAGE` 生成 ZIP；若浏览器支持 WebCodecs，还会附带 Opus WebM 代理并实际挂载到 MediaSource。

## 帧率一致性

音频事件的主锚是绝对秒数，帧号只是当前视频帧率下的映射结果：

- 更改视频帧率只重算 `nearest frame(time × fps)`，不重建或重采样音频母版。
- 23.976 / 24 / 25 / 29.97 / 30 / 50 / 59.94 / 60 fps 共用同一组 `impactSample` 和 `startSample`。
- 页面 `FPS X-RAY` 展示每种帧率下的起止帧号；导出的 `event-map.json` 也包含完整 `fpsMap`。
- 测试会逐样本比较不同 fps 下的左右声道 PCM，要求完全相等。

## 声音模型

母版是 48 kHz、双声道、确定性程序音乐。减速段使用连续播放速率：

```text
rate(t) = 1 - (t - start) / (impact - start)
source(t) = start + (t - start) - (t - start)^2 / (2 × duration)
```

输出按 `source(t)` 线性插值读取母版，因此音高随速率连续下降。减速段末端有 4 ms 收零淡出，撞击样本本身及之后全部为 IEEE `+0.0`。渲染链没有混响、延迟、压缩器或撞击后的自动化尾巴。

## 导出内容

- `apex-tape-stop.wav`：48 kHz / 24-bit / stereo PCM，含 0.5 秒冻结保持长度的数字静音。
- `event-map.json`：撞击/起点/拍点穿越/终止淡出/最后非零样本等精确采样索引，以及跨帧率映射。
- `automation.csv`：减速区间逐样本 `rate / pitch_cents / source_sec / gain_db`。
- `tail-gate.txt`：对实际 Float32 渲染缓冲逐样本扫描后的尾音证明。
- `broadcast-proxy.webm`：可选的 WebCodecs Opus 代理。
- `bundle-info.json`：本次配置、采样映射、能力状态和打包说明。

## 尾音证明

`tail-gate.txt` 不是只声明“应该没有余音”，而是检查最终渲染数组：

1. 从 `impactSample` 到轨道末尾逐样本检查左右声道。
2. 要求非零样本数为 0、峰值为 0、撞击样本严格为 0。
3. 要求最后一个非零样本严格小于 `impactSample`。
4. 同一检查也写入 `event-map.json.tailProof`，并在页面 `TAIL GATE` 卡片显示。

## 技术结构

- TypeScript：`src/model.ts`、`src/synth.ts`、`src/export.ts`、`src/webm.ts`、`src/scene.ts`、`src/timeline.ts`、`src/app.ts`。
- Node.js 标准库：静态服务、构建、测试和 ZIP 生成。
- WebAudio：试听、时钟同步和撞击时增益硬静音。
- Canvas：赛车回放画面与事件时间轴。
- WebCodecs：`AudioEncoder` 生成 Opus。
- MediaSource：挂载导出的 WebM/Opus 代理并读回 duration，作为播放容器预检。

## 验证

```bash
npm test
```

测试覆盖：48 kHz 采样定位、跨帧率 PCM 恒等、速率/相位单调、拍点映射、撞击后全零、WAV 头与静音扫描、事件 JSON、逐样本 CSV、ZIP 目录完整性。
