# GOP Frame Review

离线、逐帧精确的长 GOP 审片播放器。运行时只使用 TypeScript、Node.js 标准库，以及浏览器 WebCodecs、WebAudio、Canvas。没有第三方依赖、远程字体或 CDN。

## 运行

要求 Node.js 22.13+ 和支持 WebCodecs 的 Chromium 系浏览器。

```bash
npm start
```

打开 `http://127.0.0.1:4173`。可用 `PORT=4189 npm start` 换端口。

```bash
npm test
```

## 操作

- `←` / `→`：精确移动一帧，帧号以显示序为准
- `Shift + ←` / `Shift + →`：大幅跳转 10 帧
- `Space`：播放 / 暂停
- `Home` / `End`：首帧 / 尾帧
- 拖动时间轴：先显示目标 GOP 的 I 帧低清预览，停顿或松手后补最终帧
- 音轨按钮：独立切换 AudioDecoder 输入，不清空视频 GOP 缓存
- 打开本地视频：读取本地 MP4，不经过网络

## 实现要点

- `src/mp4.ts`：ISO BMFF / MP4 解复用，解析 `stts`、`ctts`、`stss`、`stsc`、`stsz/stz2`、`stco/co64`，支持字节范围读取。
- `src/timeline.ts`：将解码序 sample 映射为显示序帧号，记录每帧所属 GOP 与关键帧，处理 H.264 B 帧重排。
- `src/video-engine.ts`：从目标帧所在 GOP 起点解码，按显示帧号缓存；解码请求串行化，旧请求结果不会覆盖新目标。
- `src/gop-cache.ts`：按 GOP LRU 淘汰，带字节预算；当前显示帧固定，不能在重绘前被关闭。
- `src/thumbnails.ts`：独立关键帧解码器生成低清预览，不占用最终帧解码通道。
- `src/audio-engine.ts`：独立 AudioDecoder + WebAudio 调度，切音轨和静音不触碰视频缓存。
- `src/renderer.ts`：Canvas 双缓冲。窗口缩放只重绘已固定帧，不解码。

## 验证

`npm test` 覆盖：

- 真实演示 MP4 的解复用与双音轨 sample table
- B 帧显示序、GOP 映射、连续十次单帧导航
- chunk 时间戳起点与单调性
- GOP 缓存淘汰、字节预算、固定帧保护

本机若已启动带 CDP 的 Chrome，可额外运行端到端检查：

```bash
node --experimental-strip-types tools/browser-check.ts
```

该脚本验证首帧、十次单帧、Shift 跳转、切音轨、播放、窗口缩放、拖拽预览与最终帧落点，并检查浏览器控制台错误。默认连接 `127.0.0.1:9333` 和 `127.0.0.1:4173`，可用 `CDP_HOST`、`PAGE_URL` 覆盖。

演示素材为本地生成的 12 秒、12 fps、48 帧 GOP、双 AAC 音轨 MP4。
