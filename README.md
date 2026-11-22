# 本地视频素材筛选系统

面向素材库的长视频筛查工具：自动识别**全黑、静止、明显抖动**内容，按镜头切分并把镜头
稳定分配给同事，输出剪辑可直接使用的标签与时间码清单。全程本地运行，无任何第三方运行时
或构建依赖。

- 后端：TypeScript + Node.js 标准库（`node:http` / `node:fs` / `node:crypto` / `node:test`）
- 浏览器：WebCodecs、WebAudio、Canvas、MediaSource，原生 ES Module，无打包步骤
- Node 24 原生擦除类型直接运行 `.ts`，不需要 `tsc`、不需要 `npm install`

## 快速开始

```bash
# 1. 跑全部单元测试（24 个，含双端引擎一致性、SHA-256 对齐、断点续扫）
node --test "test/*.test.ts"

# 2. 程序化样本全流程演示（生成 8 类误判样本并导出清单）
node src/server/cli.ts demo --data-dir ./.scan-data

# 3. 启动本地服务，浏览器打开 http://localhost:8787
node src/server/cli.ts serve --data-dir ./.scan-data --port 8787

# 4. 查看可续扫任务 / 导出镜头总表
node src/server/cli.ts resume --data-dir ./.scan-data
node src/server/cli.ts export --data-dir ./.scan-data --out ./exports
```

浏览器页面操作：选择视频文件 → 开始/继续扫描 → 分析并生成清单 → 下载 CSV/EDL。
「样本实验室」按钮用 WebCodecs 现场合成黑场/静止/抖动/硬切/叠化样本并跑检测断言。

## 目录结构

```
src/
  shared/            浏览器与 Node 共享的纯逻辑内核（无 IO、无时间副作用）
    config.ts        版本化检测阈值 + 引擎版本 + 稳定哈希
    types.ts         帧指标/区间/检查点等数据契约
    timecode.ts      非丢帧 SMPTE 时间码
    engine.ts        黑场/静止/抖动/镜头检测（确定性纯函数）
    exporters.ts     labels/segments/shots CSV + CMX3600 EDL
    sha256.js        零依赖流式 SHA-256（与 node:crypto 逐字节一致）
  server/            Node 端
    store.ts         检查点、批次幂等写入、原子落盘、指标重建
    pipeline.ts      分析流水线与清单导出
    http.ts          node:http 服务（静态托管 + JSON API）
    fixtures.ts      8 类程序化测试样本（覆盖误判）
    cli.ts           demo / serve / resume / export
  web/               浏览器端（原生 JS ESM）
    index.html, styles.css, app.js
    lib/
      scanner.js       逐帧采样编排 + 断点续扫
      metrics.js       Canvas 灰度/黑场/帧差/块运动向量
      audio.js         WebAudio RMS
      mse-loader.js    MediaSource 加载（失败回退 blob:）
      sample-generator.js  WebCodecs 编解码样本合成
      engine.js        检测引擎浏览器镜像（与 TS 内核同算法）
test/                node:test 单元测试
```

## 检测逻辑与阈值

所有阈值集中在 `src/shared/config.ts` 并带版本号 `ENGINE_VERSION`；分析结果记录引擎版本与
参数哈希（FNV-1a），任何阈值调整都必须升版本，旧检查点会拒绝混用续扫。

- **黑场**：帧内亮度低于 16 的像素占比 ≥ 98% 判黑帧；连续 ≥ 0.5s 成段，允许穿插 1 帧非黑
  （抗单帧闪白）。近黑欠曝画面因占比不达标不会误判。
- **静止**：帧间平均差 ≤ 2 且块运动 ≤ 0.75 并持续 ≥ 1s；黑场帧通过交叉信号排除，不会被
  重复标成静止；极缓慢运镜因块运动持续存在而不触发。
- **抖动**：12 帧滑窗内，块运动幅度 ≥ 6 且方向无序占比 ≥ 0.45 的帧占比 ≥ 60%。平滑平移
  运动方向一致（无序度低），不会误判为抖动。
- **镜头切分**：硬切看单帧像素差 ≥ 28 且块运动与像素差比例合理（排除平移/抖动残余）；
  软切（叠化）要求窗口差呈「先升后降」拱形；短于 0.3s 的碎片镜头并入相邻镜头。

## 断点续扫与稳定性保证

- 文件身份用**内容 SHA-256**（共享 `sha256.js`，浏览器与 Node 结果一致），与路径无关，
  改名或换机器后仍能命中同一检查点。
- 帧指标按批次写 `state/<sha>/batches/*.ndjson`，检查点 `state.json` 采用临时文件 + rename
  原子写，中断不会留下半个文件。
- 批次按序号幂等：重复上传同序号直接忽略；跳号、断帧、采样步长不一致、引擎版本不一致
  全部服务端拒绝，防止指标序列被污染。
- 检测引擎是纯函数，时间戳由调用方注入；同样的指标 + 同样的配置必然产出同样的区间、时间码
  和同事分配（分配按 `sha256:起始帧` 哈希取模）。

## 剪辑清单

分析后在 `exports/<sha>/` 与浏览器下载按钮提供：

- `labels.csv`：文件级标签（black/still/shaky + 严重度 + 命中时长占比 + 出现次数）
- `segments.csv`：黑场/静止/抖动区间，含中英文类型、SMPTE 入出时间码、帧号、PTS、严重度
- `shots.csv`：镜头编号、入出时间码、时长、负责同事、镜头内命中标签
- `timeline.edl`：CMX 3600 非丢帧 EDL，可直接导入剪辑软件
- `analysis.json`：完整结构化结果

时间码统一为非丢帧 `HH:MM:SS:FF`，仅由帧号和标称帧率推导，重复扫描字节稳定。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 引擎版本与参数哈希 |
| GET | `/api/config` | 当前检测阈值 |
| GET | `/api/scans` | 全部扫描检查点（续扫位置） |
| GET | `/api/scans/:sha` | 单任务检查点 |
| POST | `/api/batches` | 上传一批帧指标（幂等） |
| POST | `/api/scans/:sha/complete` | 校验帧数并收尾 |
| POST | `/api/scans/:sha/analyze` | 运行确定性分析并落盘清单 |
| GET | `/api/results/:sha` | 读取分析结果 |
| GET | `/api/results/:sha/export/:file` | 下载 CSV/EDL/JSON |
| GET | `/api/results/master-shots.csv` | 跨文件镜头分配总表 |

## 浏览器能力映射

- **Canvas**：逐帧绘制 + `getImageData` 计算灰度、黑像素占比、帧间差与 16×16 块运动向量
- **WebAudio**：解码音轨并按帧时间窗计算 RMS（无音轨时降级为 0，不影响视频检测）
- **MediaSource**：本地文件经 SourceBuffer 喂入 `<video>`，容器不支持时自动回退 blob URL
- **WebCodecs**：样本实验室用 `VideoEncoder`/`VideoDecoder`/`VideoFrame` 合成并往返编解码

## 测试与误判覆盖

`src/server/fixtures.ts` 与浏览器样本实验室共同覆盖 8 类场景，均带期望断言：

1. 黑场中的单帧闪白不打断黑场，且不重复标静止
2. 近黑欠曝正常画面不误判黑场
3. 真静止长镜命中，恢复运动后区间正确结束
4. 极缓慢运镜不误判静止
5. 手持抖动命中
6. 平滑横移不误判抖动
7. 硬切 + 叠化 + 超短碎片镜头的切分与合并
8. 黑场/静止/抖动/硬切综合素材三类标签同时命中

## 已知边界

- 浏览器逐帧靠 `seek + Canvas` 精确采样，长视频耗时取决于磁盘与解码速度；可调大采样间隔。
- 块运动采用固定 16×16、±8 像素全搜索，刻意保持算法可解释与确定性，未引入光流等重模型。
- WebCodecs 编码容器在不同浏览器支持度不同，样本实验室优先 H.264（`avc1.42001E`）。
- 纯标准库未实现 MP4 解复用，真实文件解码交给浏览器原生管线；Node 侧只消费已采集指标。
