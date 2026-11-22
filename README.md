# 竖映 / Portrait Cut

离线把 16:9 横屏访谈重构成 9:16 竖屏。素材、字幕、环境声、画面和最终编码全部由程序生成，没有外部素材、网络请求或第三方库。

## 启动

```bash
npm start
```

打开 `http://127.0.0.1:4173`。需要支持 WebCodecs、WebAudio、Canvas 和 MediaSource 的 Chromium 浏览器（Chrome / Edge 111+）。

```bash
npm test
```

测试覆盖生成素材、逐句时间、字幕格式、主体/手势安全裁切、平移全过程、WebM 双轨封装、CRC32 zip 和逐镜参数导出。

## 编辑流程

1. 左侧逐句选择镜头，时间线或 `←` / `→` 逐帧查看。
2. 在右侧 16:9 源画幅拖动**主体框**或**关键手势**框；空白处拖动可直接重画。
3. 在竖屏监看中拖动十字标记设置**运动目标**，或使用水平/垂直滑杆。
4. 调整构图缩放与镜间平移时长。安全区开启时，主体框、手势区和字幕永远不会被硬裁。
5. 打开「导出交付包」，生成视频、WebVTT、逐镜 JSON 与 README，并下载单个 `.zip`。

快捷键：`Space` 播放/暂停，`←` / `→` 逐帧，`Shift+←/→` 半秒步进，`↑` / `↓` 上一镜/下一镜。

## 安全裁切

- 输出固定为 1080×1920、30 fps，源素材固定为程序化 1920×1080。
- 每镜保存主体框、手势框、运动目标、缩放、缓动和平移区间。
- 主体与关键手势的并集始终被约束在裁切窗内；当并集宽于竖屏裁切窗时自动缩小主体并使用模糊背景填充，而不是裁掉内容。
- 镜间平移在当前句结束前完成，下一句开始时构图已经就位，避免关键手势在平移途中出画。
- 字幕固定在画幅宽度 86% 内并自动换两行。

## 交付物

`portrait-cut-delivery.zip` 包含：

- `portrait-master.webm`：VP8 视频 + Opus 单声道音频，1080×1920，30 fps。
- `captions.zh-CN.vtt`：逐句 WebVTT 字幕。
- `edit-parameters.json`：每镜主体框、手势区、运动目标、裁切窗、缩放、平移窗口、安全校验和代码参数。
- `README.txt`：可直接随片交付的说明。

WebM 由 `src/webm.ts` 直接封装 WebCodecs 的 `EncodedVideoChunk` / `EncodedAudioChunk`；预览通过 `MediaSource` 挂载同一份文件。

## 代码结构

- `server.ts`：Node.js 标准库静态服务器，并使用 `node:module` 的 `stripTypeScriptTypes` 直接提供浏览器 TypeScript 模块。
- `src/content.ts`：程序生成的六句访谈、人物位置、字幕和手势。
- `src/crop.ts`：安全裁切、缓动、镜间平移。
- `src/draw-source.ts` / `src/render-portrait.ts`：Canvas 横屏素材与竖屏合成。
- `src/audio.ts`：WebAudio 程序化环境声与语音节奏。
- `src/exporter.ts` / `src/webm.ts` / `src/zip.ts`：WebCodecs 编码、WebM 多轨封装和交付包。
- `src/app.ts` / `src/export-ui.ts`：编辑交互与交付界面。

除 Chromium 提供的 WebCodecs、WebAudio、Canvas、MediaSource API 外，运行时只使用 TypeScript 与 Node.js 标准库。
