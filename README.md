# Framelock

离线双画幅烧录字幕工作台。同一套字幕时间轴分别输出 **1920×1080（16:9）** 与 **1080×1920（9:16）**，字幕先渲染为独立透明层，再与每个视频帧合成。原始 AAC 编码包不经过 WebAudio，直接复用并封装回 MP4。

## 快速开始

```bash
npm start
# 打开 http://127.0.0.1:4173
```

要求 Node.js ≥ 22.13（使用内置 `stripTypeScriptTypes` 构建浏览器模块）。项目没有任何 npm 依赖，不访问云端；浏览器需要支持 WebCodecs、OffscreenCanvas、MediaSource 与 WebAudio。推荐最新版 Chrome / Edge。

页面首屏会自动载入 `samples/demo-course.mp4`，也可拖入自己的 **H.264/AVC MP4 + AAC** 课程视频。字幕可直接粘贴 SRT/VTT、导入文件或点击列表定位。

## 输出

- `双版本`：依次导出 16:9、9:16 两个 MP4，并各自生成逐帧映射 JSON。
- `16:9 烧录` / `9:16 烧录`：单独输出一个画幅。
- `导出两种版面检查图`：生成两张大图 PNG + `layout-metrics.json`，包含安全区、文本盒、主体框、行宽、边距与主体重叠率。

仓库内已附检查产物：

- `artifacts/layout-check-16x9.png`
- `artifacts/layout-check-9x16.png`
- `artifacts/layout-metrics.json`

运行 `npm run artifacts` 可重新生成 SVG 源图与指标；PNG 由页面中的同一 Canvas 渲染器导出。

## 帧对应规则

1. 解码 PTS 以源 MP4 的 edit list 为基准，字幕判断使用精确的帧时间戳，而不是播放器回调时间。
2. 字幕区间为 `[startUs, endUs)`，显示该帧的条件是 `startUs <= framePtsUs < endUs`。
3. 输出帧时间戳直接取解码帧 PTS；字幕层在编码前按同一个 PTS 计算当前句与高亮句。
4. 导出后重新解析输出 MP4，并比较源帧/输出帧时间戳；帧数或映射误差超过容差会中止导出。
5. 每个输出版本附带逐帧 JSON：`index`, `outputPtsUs`, `sourcePtsUs`, `cueId`, `activeSentenceId`, `lineCount`, `fontSize`。

首帧为视频时间轴原点（源视频 edit list 已应用），不会对字幕做“整体提前/延后”补偿。

## 原音轨约束

- AAC 编码包从源 MP4 的 sample table 读取后原样写入新 MP4，不重采样、不重编码、不做响度处理。
- WebAudio 只用于预览监听；导出链路完全不读取预览音频。
- 封装前后分别对全部音频包计算 SHA-256，写入逐帧映射 JSON；不一致时导出立即失败。
- AAC edit list（编码预滚/裁切）会保留，容器中的可听时长与源文件一致。

## 排版

排版内核在 `src/shared/layout.ts`，预览、导出、检查图共用：

- 16:9 安全区 6.4% / 7.0%，基准字号 56px，最多 2 行，底部内边距 78px。
- 9:16 安全区 7.4% / 8.0%，基准字号 50px，最多 3 行，底部内边距 211px。
- Canvas `measureText` 做真实字体度量；中文按字、西文按词换行，避免标点落到行首，并在双行时做宽度平衡。
- 宽度不足时按 2px 步进缩字至下限；仍溢出时显示告警并截断。
- 背景样式：底板、玻璃、描边、无底。活动句以强调色、底光和短下划线逐句高亮。
- 主体框可选择“讲师在左/竖屏在上”或“主体占下半区”；自动模式比较候选位置与主体框的重叠面积，在安全区内选择上置、下置或左右避让。
- 竖屏先把 16:9 画面按 94% 宽 FIT 到上方，再用模糊、压暗的原画面铺满背景；横屏保持原画幅 contain。

## 技术结构

```text
src/shared/       字幕解析、句子时间、Canvas 无关排版、帧时间轴
src/client/mp4/   MP4 box/sample table 解析、AVCC 解码配置、MP4 封装
src/client/       Canvas 字幕层、逐帧合成、WebCodecs 导出、MSE 预览
src/server.ts     Node 标准库静态服务器，支持 Range
scripts/          无依赖 TS 构建与检查图产物
src/tests/        时间边界、排版、MP4/AAC 不变量测试
```

构建把 TypeScript 类型语法剥离为浏览器原生 ESM，不打包、不联网。MP4 封装器支持 H.264 视频轨与 AAC 音频轨；输出视频由 WebCodecs `VideoEncoder` 重编码为 AVC，音频轨按源样本透传。

## 验证

```bash
npm test
```

测试覆盖：

- SRT 时间码与 `[start, end)` 帧边界；
- 16:9 / 9:16 安全区约束与主体避让；
- 活动句高亮范围；
- MP4 sample table 读取；
- 420 帧视频、658 个 AAC 包完整重封装；
- 封装前后 AAC 包 SHA-256 一致、源输入字节不变。

## 已知边界

- 输入视频限定为 H.264/AVC MP4；HEVC/AV1 未提供解码配置解析。
- 只取第一条视频轨和第一条音频轨，不处理 DRM、多轨混音或字幕内嵌流。
- 浏览器端导出受 `VideoEncoder.isConfigSupported` 能力约束；不支持 AVC 编码的浏览器会给出明确错误，不会退化为实时录屏。
- 当前为单页离线工作台，不保存项目文件；刷新后需重新载入素材。
