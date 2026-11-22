# Spliceframe

现场音乐会片段的无缝播放清单生成器。它不按固定毫秒裁剪，而是逐段解析 AAC/MP4 的编码预滚、有效时长和尾部填充；没有足够证据的片段会进入单独的待核验区。

运行环境只使用 Node.js 标准库、TypeScript、WebCodecs、WebAudio、Canvas 和 MediaSource。没有 npm 依赖、远程字体、分析脚本或网络请求。

## 运行

```bash
npm start
```

打开 `http://127.0.0.1:4173`。端口占用时会自动向后寻找可用端口，也可手动指定：

```bash
PORT=4174 npm start
```

离线检查与测试：

```bash
npm run check
npm test
```

`npm start` 会先把 `src/*.ts` 通过 Node 内置的 `stripTypeScriptTypes` 转成浏览器可加载的 ES modules，再由标准库 HTTP 服务器托管 `public/`。要求 Node.js `>=22.13`。

## 样例

仓库自带 8 个真实 AAC-LC 编码片段，来自同一段连续合成鼓点：

- 6 段保留精确 MP4 `edit list`，可验证预滚与尾部填充。
- 2 段移除 `edit list`/`iTunSMPB`，且首尾都处于连续鼓点中，因此必须单列，不能猜测裁剪点。
- 切点故意不落在 AAC 帧边界，片段长度和尾填充都不同。
- 当前结果：`29.00 s` 可播放、`5` 个接缝、`10/10` 次 WebAudio 跳接缝通过。

编码样例已提交在 `public/fixtures/`。正常构建、测试和播放不需要 ffmpeg；只有重新生成样例时才需要 `tools/synth-fixtures.mjs` 和系统 ffmpeg。

## 判定链

1. `src/mp4.ts` 解析 ISOBMFF：`stsd/esds`、`stts/stsc/stsz/stco`、`mdhd/mvhd`、`edts/elst`，并尝试识别 `iTunSMPB`。
2. `src/decoder.ts` 用 WebCodecs 解码全部 AAC 帧，保留编码器预滚和尾帧；WebCodecs 不可用时退回 WebAudio，并识别容器是否已替我们完成裁剪。
3. `src/analyzer.ts` 计算：
   - 预滚样本 = `elst.media_time` 换算到采样率；
   - 有效样本 = `elst.segment_duration` 换算到采样率；
   - 尾填充 = 解码总样本 − 预滚 − 有效样本。
4. 以下情况不确认：没有容器时间证据、首尾处于连续音频、元数据与解码总样本冲突、或只有静音包络而没有精确边界。
5. 仅拼接已确认片段的有效区间；未被确认的片段不进入 `pcm`/播放清单，并在独立区域展示原因。

波形静音检测只作为证据展示，不会因为“像静音”就自动裁出精确样本。

## 验收

- 接缝连续性：对拼接后的 PCM 计算 `|s[n] − s[n−1]|`，与接缝两侧邻域步长和高频二阶差分比较；当前 5 个接缝全部通过。
- 跳接缝十次：界面使用 `OfflineAudioContext` 实际执行 `AudioBufferSourceNode.start(0, seamOffset)`，每轮渲染接缝前后 128 个样本，并验证输出接缝差与清单一致。浏览器实测 `10/10 PASS`。
- MediaSource：对每段生成 fMP4 编码 reference，实际追加到 `MediaSource`/`SourceBuffer` 验证容器可寻址。无缝拼接仍由 WebAudio 执行，因为 MSE 无法保证跨独立编码片段的样本级 edit 精度。

## 结构

- `src/mp4.ts` — MP4 解复用、AAC 配置与 edit list。
- `src/decoder.ts` — WebCodecs 解码、WebAudio 回退、MSE 探测。
- `src/analyzer.ts` — 裁剪证据链、播放清单、接缝审计。
- `src/app.ts` — 播放器、Canvas 时间轴、界面与跳接缝验收。
- `tests/core.test.mjs` — 真实 M4A 样本表、动态填充、未确认单列、接缝与十次跳接缝测试。
- `tools/build.mjs` — 零依赖 TypeScript 构建。
