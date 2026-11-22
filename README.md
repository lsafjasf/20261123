# 电竞多画面训练台（Esports Multiview Coach）

零依赖的 TypeScript 项目：同屏合成比赛主画面、选手摄像头、战术小地图三路信号，
支持随片段平滑变化的窗口布局、关键 HUD 实时遮挡报警、切镜不重置位置，
并通过 WebCodecs + 手写 WebM 封装导出视频与逐帧布局变化清单，最后用
MediaSource 回放导出文件并逐帧比对预览像素。

## 技术约束

全部满足，无外部 npm 包、无云服务：

- 语言：TypeScript（仅使用 Node 可擦除语法），运行时 Node.js 标准库
- 画面：Canvas 2D 合成
- 编码：WebCodecs（`VideoEncoder` / `AudioEncoder` / `VideoFrame` / `AudioData`）
- 音频：WebAudio（`AudioContext` 混音、`MediaStreamTrackProcessor` 取数）
- 回放校验：MediaSource + SourceBuffer
- 封装：手写 Matroska/WebM（EBML）封装器，无第三方 muxer
- 服务：Node `node:http`，内置 `node:module` 类型擦除在线转译浏览器 TS

## 运行

```bash
npm start          # 默认 http://localhost:8080 ，PORT=xxxx 可改端口
npm test           # 27 个 Node 内置 test runner 单测
```

浏览器打开后点击「载入内置合成信号」即可在无素材情况下走完整条流水线；
也可用每路信号源的文件选择器加载本地视频（`URL.createObjectURL`，不上传）。

## 操作

- 播放/暂停/单帧步进/帧拖动条，时钟显示帧号与秒
- 直接拖拽面板移动，拖右下角三角手柄缩放；松手即在当前帧写入关键帧
- 「在当前帧存关键帧」把当前布局固化到时间线
- HUD 区域以虚线框叠加在主画面上：绿色清晰、黄色部分遮挡、红色被挡住，
  顶部出现实时横幅报警，侧边栏显示每区覆盖率
- 「开始实时导出」后播放头归零并实时编码，到末帧自动封装，也可手动结束
- 导出后自动下载 `multiview-export.webm`，可再下载 `layout-manifest.json`
- 导出文件经 MediaSource 回放，按采样帧解码并与预览快照逐像素比对，
  报告最大/平均通道差与超差帧数

## 目录

- `src/shared/` 纯逻辑（布局引擎、几何、遮挡监测、切镜判定、校验统计、预设）
- `src/client/` 浏览器端（合成器、交互、编码、WebM、音频、MSE、UI 主控）
- `src/server/` 零依赖静态服务器与 TS 转译
- `test/` Node 内置测试运行器用例

## 关键设计

- **平滑布局**：布局由关键帧时间线驱动，片段间用 smoothstep 插值，过渡期间
  面板边框变橙；只有进入新关键帧片段才记一条 `layout-change`，插值不刷清单。
- **切镜不重置**：信号源与布局引擎解耦，换文件/切镜只替换面板绑定的源，
  播放头与布局时间线保持不动；切镜经缩略图灰度差分 + 冷却帧判定并记录 `cut`。
- **遮挡监测**：HUD 区以主面板局部坐标定义，随面板移动；其它两路作为遮挡体
  在画布归一化坐标系求交，边沿触发 `occlusion` / `occlusion-clear` 事件。
- **预览即导出**：预览与导出共用同一个 `Compositor.renderFrame`，导出只把同一
  画布包成 `VideoFrame`，不存在第二套渲染路径，从结构上保证画面一致。
- **帧号清单**：所有事件带帧号与秒，导出开始时重置全部边沿状态，避免重复。

## 浏览器端验证（环境无浏览器时的手工步骤）

本容器未安装 Chromium，浏览器专属 API 在 Node 单测中以纯逻辑 + 封装字节测试
覆盖。在本地 Chrome/Edge 中：

1. `npm start` 后打开页面，载入合成信号
2. 播放观察面板平滑移动、HUD 框颜色与报警横幅
3. 拖拽改布局，确认关键帧出现在片段列表
4. 开始导出并等待自动封装，确认下载 webm、清单 JSON
5. 查看右下角校验报告为「通过 — 导出与预览一致」
