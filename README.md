# 纪录片 Ken Burns 运镜工作台

把 18 张高分辨率照片与旁白做成缓慢推拉平移、带电影感交叉溶解的纪录片，而不是幻灯播放。
全程零第三方依赖：TypeScript + Node.js 标准库 + WebCodecs + WebAudio + Canvas + MediaSource，不接任何云服务。

## 需求如何被满足

- **平滑运镜而非幻灯**：每张照片在“可用画幅”内生成起止取景框，按三次缓入缓出插值，支持 `push-in`、`pull-out`、`pan`、`auto` 四种模式，见 `src/shared/camera.ts`。
- **转场不露边**：取景框在任意进度都被约束在 `usableFrame` 内且保持输出宽高比；转场用交叉溶解，两张图各自铺满画布，黑底仅在极端兜底时出现，几何约束由 `test/camera.test.ts` 与 `test/export-manifest.test.ts` 验证。
- **重点框**：起止取景框的中心范围同时受 `usableFrame` 与 `focusBox` 约束，保证重点区域始终在画面内。
- **旁白驱动停留、顺序不变**：`src/shared/timeline.ts` 按文本字数/音频长度延长单张停留，图片顺序严格沿用清单顺序，末段无尾部转场。
- **预览后导出**：页面先用 Canvas + WebAudio 实时预览；导出时用 WebCodecs 编码 VP9/VP8/AV1 与 Opus，自研零依赖 WebM 封装器（含 Cues 索引）封包，再通过 MediaSource 回放。
- **导出物**：`exports/*.webm` 视频，以及 `exports/*.json`，逐图给出入出时间、转场时长、起止裁切参数和过程裁切采样。

## 目录结构

- `src/shared/`：Node 与浏览器共用的纯逻辑（类型、几何、运镜、时间轴、EBML/WebM 封装器）。
- `src/web/`：浏览器端，Canvas 渲染、WebAudio 混音、WebCodecs 编码、MediaSource 回放与页面主控。
- `src/server/server.ts`：仅用 Node 标准库的 HTTP 服务，负责静态文件、TypeScript 即时类型擦除、项目读取与导出落盘。
- `tools/`：零依赖夹具生成器（PNG/WAV/项目清单）与语法检查器。
- `test/`：`node:test` 单元测试与基于假 Canvas/WebCodecs 的管线测试。
- `fixtures/`：18 张 3840×2160 测试图、逐段与整条旁白 WAV、`project.json`。

## 运行

要求 Node.js ≥ 23.6（使用原生 TypeScript 类型擦除，无需安装任何包）。

```bash
node tools/make-fixtures.ts   # 生成测试图片与音频（已附带生成结果时可跳过）
node tools/make-project.ts    # 生成 fixtures/project.json
npm test                      # 运行全部 node:test 用例
npm run check                 # 校验所有 TS 文件可被原生擦除器解析
npm start                     # http://localhost:8080
```

浏览器需要支持 WebCodecs（Chrome/Edge 桌面版）。打开页面后可播放预览、拖动时间轴检查，点击“导出 WebM 与参数”后可在页面内通过 MediaSource 回放，并从 `exports/` 下载视频与参数 JSON。

## 项目清单格式

`fixtures/project.json` 中每张图包含：

- `focusBox`：重点框，归一化坐标（0–1）。
- `usableFrame`：允许取景的最大安全范围，归一化坐标。
- `motion`：运镜模式。
- `narrationText` / `narrationSrc`：旁白文本与逐段音频。
- `narration.fullNarrationSrc`：可选的整条旁白，长度会参与延长总时长并混入导出音轨。

## 导出参数 JSON

每个段记录包含：

- `inPoint` / `outPoint`：该照片的进入与运镜结束时间（秒）。
- `transitionIn` / `transitionOut`：与相邻照片的交叉溶解时长。
- `startCrop` / `endCrop`：归一化裁切矩形。
- `cropSamples`：时间轴上的裁切采样，含绝对时间、进度与裁切矩形，可直接复现运镜。

## 零依赖说明

- WebM/EBML 封装为手写实现（`src/shared/ebml.ts`、`src/shared/webm-muxer.ts`），不使用 MP4/ffmpeg/任何 npm 包。
- 服务器只用 `node:http`、`node:fs`、`node:path` 与 `node:module` 的类型擦除 API。
- 测试只用 Node 内置 `node:test` 与 `node:assert`。
