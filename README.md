# BeatCut · 节拍切点旅行片编辑器

一条八段旅行片按故事排好后，让切镜跟着音乐重拍走，但不在每拍硬切。
画面、节拍、音轨共用同一条秒级时间线，支持片段强弱、最短停留、可选入点，
切点可单条拖动且其他切点不联动，并在导出前核对人物说话不被拦腰切断。

**技术约束已满足**：只用 TypeScript、Node.js 标准库以及浏览器的
WebCodecs、WebAudio、Canvas、MediaSource；无任何第三方 npm 依赖、无云服务。

## 运行

```bash
npm start            # 等价于 node --experimental-strip-types src/server/server.ts
# 打开 http://localhost:5173/ （端口可用 PORT 环境变量覆盖）
npm test             # 运行全部 Node 内置测试
```

Node ≥ 22.6（开发环境为 Node 24）。服务器用 `node:module` 的
`stripTypeScriptTypes` 即时把 `.ts` 擦成浏览器可执行的 ESM，因此不需要构建步骤，
也没有引入打包器或 TypeScript 编译器包。代码只使用「可擦除」的 TS 语法。

## 操作流程

1. 点「载入内置 demo」即可获得一条带 112 BPM 鼓点、两段模拟说话的音轨和 8 段画面，
   无需任何外部素材；也可以「导入音频」分析真实音乐。
2. 右侧设置每个片段的**强弱**、**最短停留**与**可选入点**，以及重拍偏好、吸附窗口。
3. 系统用动态规划给出切点：只在收益足够的节拍上切，重拍优先，弱片段更少打断。
4. 在时间线顶部拖动三角手柄可**单条移动切点**，其余切点对象保持原引用、绝不联动；
   手动切点标记为 `manual`，重新规划时保留。右侧面板可单条复位或移到说话安全位置。
5. 「切点检查」实时列出问题：`speech-split`（说话被切断）、`too-short`、`out-of-range`。
6. 导出 VP9+Opus 的 `.webm`（经 MediaSource 预览）以及 CSV / JSON 切点表。

## 架构

```
src/core/        与 DOM 无关的纯算法（Node 可直接单测）
  types.ts       共享领域模型，统一秒级时间坐标
  timeline.ts    时间换算、二分查找、节拍吸附
  planner.ts     动态规划切点规划 + 单条拖动/复位（最短停留硬约束）
  speech.ts      能量+过零率 VAD、说话区间、切点校验、安全替代位置
  cutlist.ts     CSV(UTF-8 BOM)/JSON 切点表
  webm.ts        手写 EBML/WebM 元素编码
  muxer.ts       cluster 状态机，合并音视频 chunk
src/audio/
  dsp.ts         onset 通量、自相关估 BPM、节拍网格与重拍标记（纯函数）
  webaudio.ts    decodeAudioData / OfflineAudioContext 适配层
  wav.ts         零依赖 PCM16 WAV 编码
  demo.ts        合成鼓点+人声的 demo 素材
src/ui/
  canvas-render.ts  Canvas 逐帧画面（片段配色、节拍闪点、时间码）
  timeline-view.ts  三轨道时间线与切点命中测试/拖动
  state.ts          不可变 reducer，集中所有编辑动作与校验
  exporter.ts       WebCodecs 编 VP9/Opus + WebM 封装 + MediaSource 预览
  main.ts           DOM 接线、播放循环、导出
src/server/      node:http 静态服务 + .ts 即时类型擦除
tests/           node:test 内置测试，覆盖规划、DSP、VAD、封装、状态流、HTTP
```

## 关键设计

- **不每拍都切**：把「第 k 个片段边界落在哪个节拍」建成 DP，阶段是片段边界而不是节拍；
  代价由偏离自然边界距离、节拍强度/重拍、片段强弱偏好组成，最短停留是不可违反的转移约束。
- **单条拖动隔离**：`dragCut` 只替换命中的那一条 `CutPoint`，其余对象原样返回；
  拖动受相邻两段最短停留夹取，并在吸附窗口内贴节拍。
- **语音保护**：VAD 用 RMS 能量 + 过零率区分谐波人声与镲片/底鼓瞬态，配合 hangover
  合并和最短区间过滤；切点落在说话区间内即报 `speech-split`，并给出区间前/后的安全位置。
- **统一时间线**：所有数据以秒为唯一坐标，导出时再转微秒（WebCodecs）、毫秒（WebM）
  或采样数（音频），避免画面、节拍、音轨各自为政。
- **零依赖导出**：WebCodecs 输出的 chunk 字节直接喂给手写 EBML 封装器生成可播放 WebM。

## 浏览器要求

需要支持 WebCodecs（Chrome/Edge 108+ 等 Chromium 内核）。若环境不支持，
切点表（CSV/JSON）与全部规划、校验功能仍可使用，导出视频时会给出明确报错。
