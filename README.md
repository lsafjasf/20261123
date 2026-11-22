# 影片多轨交付 QC 与对白优先混音工作台

面向一部影片的三条交付音轨（中文对白、英文对白、音乐说明/M&E）与一条
对白优先默认混音，提供离线轨道识别、时长检查、静音短尾检测、响度差异分析，
以及“切换语言不重启画面”的浏览器试听与 A/B 对比，并导出轨道矩阵与异常清单。

全部使用 **TypeScript + Node.js 标准库 + 浏览器原生
WebCodecs / WebAudio / Canvas / MediaSource**，**无任何第三方依赖**，可完全离线运行。

## 运行环境

- Node.js `>= 22.18.0`（内置 TypeScript 类型擦除，直接运行 `.ts`，无需构建）
- 现代 Chromium/Edge 浏览器（用于 WebAudio、MediaSource、WebCodecs）

## 目录结构

```
src/core/          与运行环境无关的纯算法内核（Node 与浏览器共用）
  types.ts         领域类型与 QC 阈值默认值
  wav.ts           RIFF/WAVE 解析与 16-bit WAV 写回
  identify.ts      文件名 + 声道/内容佐证的轨道角色识别
  loudness.ts      EBU R128：K 加权、双门限积分响度、LRA、真峰、RMS
  silence.ts       头尾静音与内部静音窗口扫描
  mix.ts           对白优先侧链闪避默认混音（纯函数）
  analyze.ts       汇总识别/时长/响度/静音/响度差，产出报告
src/cli/           Node 命令行与离线 HTTP 服务
  main.ts          analyze / mix / samples / serve 子命令
  report.ts        JSON 与 CSV（轨道矩阵、异常清单）导出
  server.ts        node:http 静态服务、TS 即时擦除、分析 API
src/web/           浏览器应用
  engine.ts        常驻 AudioContext 增益路由，语言切换不重启
  waveform.ts      Canvas 波形与闪避包络绘制
  media-source.ts  零依赖 MP4 解复用 + MediaSource + WebCodecs 探测
  app.ts           页面主控、试听对比、导出
src/web/public/    index.html 与 styles.css
src/tools/         合成样例素材生成器
test/              node:test 单元测试
```

## 命令行用法

```bash
# 1. 生成带缺陷场景的合成 WAV（默认写入 samples/）
node src/cli/main.ts samples

# 2. 离线 QC 分析，导出 report.json / track-matrix.csv / anomalies.csv
node src/cli/main.ts analyze samples --out report

# 3. 渲染对白优先默认混音（中文 / 英文）
node src/cli/main.ts mix samples --lang zh --out report
node src/cli/main.ts mix samples --lang en --out report

# 4. 启动离线浏览器工作台（静态资源 + 分析 API）
node src/cli/main.ts serve samples --port 8080

# 5. 运行单元测试
node --test "test/*.test.ts"
```

也可使用 `package.json` 中的 `npm run samples|analyze|mix:zh|mix:en|serve|test`。

## QC 规则（阈值见 `src/core/types.ts`）

- 角色完整性：必须各有一条中文、英文、音乐说明；重复或无法识别会告警。
- 时长检查：以最长轨为参考，偏差超过 `durationToleranceSec`（默认 1s）报错/告警。
- 静音与短尾：可配静音门限与窗口；长尾静音超过上限、尾部静音低于短尾下限均告警。
- 响度：EBU R128 积分响度对齐目标（默认 -24 LUFS），真峰天花板默认 -1 dBTP。
- 响度差异：以最响轨为基准，轨间差超过 `maxInterTrackDeltaLu`（默认 3 LU）告警。

## 浏览器试听设计

- `AudioBufferSourceNode` 仅在加载/拖动进度条时建立；语言与混音模式切换只改
  `GainNode` 自动化，因此 `<video>` 与音频时钟持续运行，画面不重启。
- 语言按钮在中文/英文对白间切换；音乐说明轨常驻并被对白侧链闪避。
- “对白优先（闪避）/ 原始叠加”按钮用于默认混音与未处理叠加的 A/B 试听对比；
  每条轨道另提供 SOLO / MUTE / 增益推子，可单独试听。
- Canvas 实时绘制当前对白波形与音乐闪避包络，播放头随时间移动。
- MP4 优先经零依赖解复用器喂入 `MediaSource`，并探测 `WebCodecs` 解码能力；
  不支持时回退到原生 Blob URL，全程不发起任何网络请求。
- 页面可直接导出 `report.json`、`track-matrix.csv`、`anomalies.csv` 与当前语言的默认混音 WAV。

## 离线与零依赖说明

- 运行时只使用 Node 标准库（`node:fs`、`node:http`、`node:path`、`node:module` 等）。
- 浏览器端 `.ts` 由内置 `module.stripTypeScriptTypes` 即时擦除后作为 ESM 提供，无打包步骤。
- 不安装任何 npm 第三方包；`package.json` 仅声明脚本与模块类型。
