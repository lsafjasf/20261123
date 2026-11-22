# 工地延时摄影工作台

把工地固定机位连拍数月的照片序列，对齐、去闪烁后导出为延时视频。
纯 TypeScript + Node.js 标准库 + 浏览器原生 API（WebCodecs / WebAudio /
Canvas / MediaSource），**零第三方依赖**。

## 运行

```bash
node tools/make-sample-photos.ts   # 可选：生成 72 帧合成样例（含相机漂移与曝光闪烁）
node server.ts                     # 需要 Node >= 22.13（原生剥离 TS 类型）
# 打开 http://localhost:8080
```

把自己的照片放进 `photos/`（png/jpg，按文件名排序即时间序），刷新页面即可。

## 功能

- **锚点对齐**：在参考帧上点击放置地面锚点（默认预置 3 个，右键删除）。
  每帧用 NCC 模板匹配找到对应点，最小二乘拟合**仅平移 + 均匀缩放**
  （不旋转，缩放限幅 0.85–1.15，只保留有依据的运动）。
- **曝光平滑**：对数亮度（EV）序列分解为宽窗中值趋势（真实昼夜变化，
  保留）与高频闪烁（去除，校正限幅 ±1.5EV）。
- **帧控制**：每帧可「跳过」或「停留 +N」（导出时重复 N 帧）。
- **预览**：Canvas 实时渲染对齐+校正结果，WebAudio 时钟驱动逐帧播放
  （带节拍音）；侧栏实时显示对齐残差曲线与曝光曲线（实测/趋势/校正）。
- **导出**：WebCodecs 编码 VP9/VP8 → 手写 EBML 封装为 WebM，经
  MediaSource 即时回放；同时落盘 `export/`：
  - `timelapse.webm` 视频
  - `seq_XXXX_srcYYYY.png` 校正后帧序列
  - `report.json` 完整报告（每帧变换/残差/EV）
  - `anomalies.csv` 异常清单（对齐失败/残差过大/曝光限幅/用户跳过）

## 结构

```
server.ts                    Node 标准库 HTTP 服务：静态文件、TS 在线转译、导出 API
tools/make-sample-photos.ts  合成样例照片生成器（含 PNG 编码器、ground-truth.csv）
tools/selftest.ts            算法自测（模板匹配/相似变换/曝光分解/EBML）
src/client/
  main.ts      UI 装配：预览、锚点交互、帧列表、播放、导出
  pipeline.ts  加载 → 对齐 → 曝光校正 → 输出计划（跳过/停留）
  align.ts     灰度金字塔、NCC 模板匹配、平移+缩放最小二乘
  exposure.ts  EV 测量、中值趋势分解、闪烁校正
  chart.ts     Canvas 折线图（残差 / 曝光曲线 + 播放游标）
  webm.ts      手写 EBML/WebM 封装器（文件 + MSE 分段）
  encoder.ts   WebCodecs VideoEncoder 管线
```

浏览器端 `.ts` 由服务器用 `node:module` 的 `stripTypeScriptTypes`
按需转译（仅使用可擦除语法），无需任何构建步骤。
