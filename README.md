# 4K 带重叠分块 GPU 滤镜管线

纯本地、零第三方依赖：TypeScript + Node.js 标准库 + WebCodecs + WebAudio + Canvas +
WebGL2 + MediaSource。不安装 npm 包、不连接云端。

## 解决的问题

旧方案先把 4K 缩到 1080p 再算滤镜，细纹与边缘永久丢失。本管线保持原始分辨率，
按帧切成带重叠边界（halo）的分块，每块在 GPU 上组合亮度、锐化、畸变：

- 整帧源纹理永不降采样，分块只改变 viewport，不改着色器数学。
- 所有计算基于“整帧归一化坐标”，同一像素在任意分块（含 halo）结果一致。
- halo 覆盖锐化卷积半径（本实现 3x3 unsharp，需 1px，默认 halo=16 留余量）。
- 奇数尺寸用 `floor(i*size/n)` 切边界，核心区首尾相接、铺满整帧。
- 滚动浏览器对任意一块懒渲染，进入视口即显示最终拼接画面。

## 目录

- `shared/tiling.ts` — 分块网格、halo 裁剪、奇数尺寸切分、显存估算（纯函数，Node/浏览器共用）。
- `shared/filters.ts` — 亮度+锐化+畸变的 CPU 参考实现与坐标数学。
- `shared/shader.ts` — 与 CPU 等价的 GLSL 300 es（同一坐标函数 => 重叠区一致）。
- `web/gl.ts`、`web/tileRenderer.ts` — WebGL2 program/FBO/计时查询与逐块渲染。
- `web/tileViewer.ts` — IntersectionObserver 分块懒渲染与滚动定位。
- `web/exportPipeline.ts` — 逐帧分块处理、重叠一致性实测、逐块耗时/显存统计、拼接编码。
- `web/webmMuxer.ts` — 纯 TS EBML/WebM 封装（定长 Segment，MSE 可寻址）。
- `web/mp4Demuxer.ts` — 纯 TS ISO-BMFF 解封装，喂 WebCodecs `EncodedVideoChunk`。
- `web/msePlayer.ts`、`web/audioEngine.ts`、`web/syntheticSource.ts` — MSE 回放、WebAudio、合成细纹素材。
- `web/app.ts`、`web/main.ts`、`web/index.html` — 应用主控与界面。
- `server.mjs` — 仅用 `node:http`/`node:module.stripTypeScriptTypes` 的静态服务器，实时去类型提供 `.ts`。
- `tests/` — `node:test` 单测（分块覆盖、奇数拼接、重叠一致、WebM 结构、导出循环）。

## 运行

```bash
node server.mjs            # 默认 http://localhost:8080/web/index.html
npm test                   # 等价 node --test --experimental-strip-types tests/*.test.ts
```

浏览器需支持 WebGL2 与 WebCodecs（Chrome/Edge 113+）。界面可改宽高（含 1921×1081
奇数样例）、网格、halo 与三项滤镜；“导出并统计”产出逐块墙钟/GPU 耗时与显式显存，
并通过 MediaSource 即时回放、提供 WebM 下载。

## 统计口径

- 墙钟：每块 `performance.now()` 包裹 draw + `gl.finish()`。
- GPU 耗时：`EXT_disjoint_timer_query_webgl2`，驱动不支持时显示 `—`。
- 显式显存：源纹理 + 各块 FBO 颜色面按 RGBA8 字节记账；浏览器无标准显存总量 API，
  故以管线自身分配量为准（`allocatedBytes`/`peakBytes`）。
- 重叠一致性：相邻块 FBO 在 halo 交集上逐像素比对，报告最大/平均差（理论为 0）。
