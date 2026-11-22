# 会议录音体检（meeting-audit）

两小时会议录音不用人盯：自动找出亚秒级的掉字、爆音、持续削波、异常空白、
持续噪声，音乐片段单独归类不误报，所有异常都能在波形上点击跳转。

完全离线运行，零第三方依赖：TypeScript 源码 + Node.js 标准库 +
浏览器 WebCodecs / WebAudio / Canvas / MediaSource。

## 运行

```bash
node build.mjs        # 编译 src/*.ts -> public/js/*.js（Node 24 内置类型擦除）
node server.mjs       # http://localhost:8080
```

打开页面后选择本地录音文件（或点"载入示例"加载 `public/demo.wav`）。
文件不离开本机，解码分析全部在浏览器内完成。

## 检测能力

| 类型 | 判定 | 默认阈值 |
| --- | --- | --- |
| 掉字 | 语音中间的短暂丢失 | 30ms ~ 1s |
| 爆音 | 单点瞬时跳变 | 相邻采样差 ≥ 0.5，≤ 50ms |
| 持续削波 | 连续满幅失真 | ≥ 0.1s |
| 异常空白 | 整段静音 | RMS ≤ -50dB 且 ≥ 2s |
| 持续噪声 | 高谱平坦度稳态声 | 平坦度 ≥ 0.45 且 ≥ 1s |
| 音乐 | 调性/谐波持续段 | 平坦度 ≤ 0.12 且 ≥ 2s（信息项，不计故障） |
| 正常停顿 | 其余短静音 + 白名单命中 | — |

- **白名单**：任何静音类片段可"标为正常停顿"，按时长区间生成规则，
  存入 localStorage，之后同类停顿自动豁免。
- **增量重算**：特征（能量/谱平坦度/跳变等，FFT 级计算）只算一次并缓存。
  改帧级阈值时，利用原子条件单调性只重算"判定可能翻转"的候选窗口
  （侧栏显示实际重算窗口数）；改时长阈值或白名单时帧掩码不变，
  只重跑分段合并。

## 支持格式

- **WAV**：直接解析 PCM，流式处理，内存有界（推荐，2 小时无压力）
- **MP3**：自解析帧 + WebCodecs `AudioDecoder`
- **M4A/MP4**：自带极简 MP4 解复用（moov/stbl 样本表）+ WebCodecs AAC 解码
- 其他格式（≤100MB）：回退 WebAudio `decodeAudioData`

播放：M4A/WebM 走 MediaSource 分片追加（可拖动、内存有界），
WAV/MP3 用 Blob URL 原生播放。

## 测试

```bash
node test/run.mjs
```

合成含 7 种已知事件的 34 秒信号，验证检测、白名单与增量重算，
并生成 `public/demo.wav` 供页面试用。

## 结构

```
build.mjs        离线构建（node:module.stripTypeScriptTypes）
server.mjs       静态服务器（含 Range 支持）
src/types.ts     类型与默认阈值
src/dsp.ts       FFT / 功率谱 / 流式重采样
src/features.ts  10ms 分帧特征提取（流式，PCM 不留存）
src/detectors.ts 帧级检测器（原子条件合取，支持候选窗口增量重算）
src/segments.ts  帧掩码 -> 语义片段（掉字/爆音/空白/噪声/音乐/停顿）
src/store.ts     阈值/白名单变更的增量重算编排
src/demux.ts     WAV/MP3/MP4 容器解析
src/decoder.ts   WebCodecs 解码 -> 16kHz 单声道流
src/player.ts    MediaSource / Blob 播放
src/waveform.ts  Canvas 全览 + 细节波形
src/main.ts      UI 主控
```
