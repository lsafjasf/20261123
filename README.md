# Timeline Normalizer

把不同部门交来的 EDL (CMX3600) 与 FCPXML（混着 23.976 / 25 / 29.97 drop-frame）
整理成统一的逐帧内部结构，识别变速、转场与缺失素材，并在导回 EDL 前列出
会丢失的能力。输入输出有可视化对照（自包含 HTML 报告）。

## 运行环境

- Node.js >= 22.13（直接用内置 type-stripping 运行 TypeScript，无第三方包）
- 查看器：浏览器 Canvas / WebCodecs / WebAudio / MediaSource，全部本机处理

## 用法

```sh
node src/cli.ts normalize <文件.edl|文件.fcpxml...> \
    [--project-rate 25] [--rate 23.976] [--media-dir DIR] [--out report]
```

- `--project-rate`：统一项目帧网格（如 `25`、`23.976`、`29.97df`）；缺省取输入中最多见的声明帧率
- `--rate`：EDL 的缺省帧率（EDL 本身不带帧率；`FCM: DROP FRAME` 会强制 29.97 DF）
- `--media-dir`：按 reel/片段名在本目录内匹配素材，用于缺失素材检测

## 输出（--out 目录）

- `normalized.json`：统一逐帧模型（项目网格上的整数帧位置 + 源帧率入出点 + 速度段）
- `analysis.json`：变速（恒定/斜坡/冻结/倒放）、转场、缺失素材、帧率 conform 清单
- `losses.json`：导回 EDL 会丢失/降级的能力（斜坡变速、多视频轨、字幕、连接片段等）
- `<片名>.edl`：导出的 CMX3600（恒定变速写 M2 行，溶解/划像写 D/W）
- `report.html`：自包含可视化对照报告，浏览器直接打开

## 报告内容

- 统一时间线（项目网格）与每个输入文件的逐轨对照，点击片段看帧级详情
- 检测结果表：变速 / 转场 / 缺失素材 / 帧率转换
- EDL 能力丢失表（lost / degraded 两级）
- 素材预览：选择本地文件，WebCodecs 抽缩略图、WebAudio 画波形、MediaSource 播放

## 测试

```sh
node --test 'test/*.test.ts'
```

## 结构

- `src/core/`：有理数运算、时间码（含 drop-frame）、统一模型、归一化
- `src/parse/`：EDL 解析、内置迷你 XML 解析、FCPXML 解析
- `src/analyze/`：变速 / 转场 / 缺失素材 / conform 检测
- `src/export/`：EDL 导出 + 能力丢失报告
- `viewer/`：Canvas 可视化查看器（TypeScript，构建期内联进报告）
- `samples/`：23.976 EDL、25fps FCPXML、29.97 DF EDL 样例
