# 手柄输入 ↔ 视频帧 对齐标注台

团队有一份手柄输入日志（JSONL）和一段玩家录制视频。录制中存在**暂停、掉帧、
可变帧率（VFR）**，且日志与视频的**时间零点不同**。本工具通过**启动动作**与
**连续输入**建立锚点，计算**分段局部帧映射**，允许**人工修正不可靠区间**；
播放器叠加**按键、连招窗口与置信度**，最终导出**标注视频（WebM）**与
**逐事件表（CSV/JSON）**。

全程离线：TypeScript + Node.js 标准库 + WebCodecs / WebAudio / Canvas /
MediaSource。**零第三方依赖**（无 node_modules），WebM 封装器为自研 EBML 实现。

## 快速开始

```bash
node --test                          # 运行核心算法测试（Node 24+，直接跑 .ts）
node scripts/build.ts                # 类型擦除构建浏览器模块 → public/app/
node src/cli/main.ts serve           # 启动离线标注台 http://localhost:8080/
```

浏览器中点「演示模式」即可一键生成含暂停/掉帧/VFR 的演示视频与配套日志，
走通「扫描帧索引 → 确认锚点 → 导出」全流程。

## 工作流

1. **载入素材**：视频文件 + 手柄日志（`.jsonl`，每行 `{"t":毫秒,"btn":"A","state":"down|up"}`）。
2. **扫描帧索引**：用 `requestVideoFrameCallback` 枚举每一帧的真实呈现时间，
   得到 VFR/掉帧/暂停都安全的 帧号↔PTS 索引；PTS 大跳变自动识别为录制暂停。
3. **建立锚点**：从日志自动检测「启动动作」（开头静默后的首个输入簇）与
   「连续输入」（节奏稳定的同键连打）作为候选；在视频上逐帧定位对应画面后确认。
   暂停两侧、低置信区间可随时补**人工锚点**。
4. **局部映射**：相邻锚点间分段线性映射 `video = a·log + b`；冗余锚点做残差检验，
   冲突锚点自动降权剔除；跨暂停、锚点稀疏、外推区间自动降置信度并打标。
5. **回看校验**：播放器叠加当前按键、连招窗口倒计时、置信度条；时间轴按段着色，
   可点击跳转；事件提示音由 WebAudio 播放。
6. **导出**：
   - 标注视频：Canvas 逐帧合成 → WebCodecs 编码 → 自研 EBML 封装为 WebM，
     并经 MediaSource 回放校验；
   - 逐事件表：`events.csv`（日志 ms、键、沿、视频 ms、帧号、段、置信度、标记）；
   - 映射：`mapping.json`（段、锚点、冲突记录），可回灌复用。

## 命令行（离线批处理）

```bash
node src/cli/main.ts gen-demo --out-dir demo          # 生成演示日志/帧表/锚点/连招
node src/cli/main.ts sync \
  --log demo/log.jsonl --frames demo/frames.json \
  --anchors demo/anchors.json --combos demo/combos.json \
  --out-dir demo/out                                  # → mapping.json / events.csv / events.json / combos.json
```

`frames.json` 为 `[pts毫秒...]` 或 `{"pts":[...]}`，由标注台扫描帧索引后得到。

## 目录结构

```
src/shared/    纯逻辑：日志解析、锚点检测、分段映射、置信度、连招、WebM 封装、演示数据
src/web/       浏览器端：播放器(rVFC 帧索引)、叠加层、导出管线、UI
src/cli/       Node CLI：serve / sync / gen-demo
scripts/       构建（node:module 类型擦除，零依赖）
tests/         node:test 单元测试
public/        标注台页面（构建产物在 public/app/）
```

## 设计要点

- **不假设恒定帧率**：所有换算基于逐帧 PTS；帧号查找为二分 `pts <= t`。
- **暂停建模**：PTS 间隙 > max(4×中位帧长, 250ms) 记为暂停；跨暂停且无锚点
  夹逼的段降置信度，提示人工在暂停两侧补锚点。
- **置信度传播**：段置信度 → 事件置信度 → 叠加层/CSV 逐条可见，不可靠区间
  一目了然并允许人工修正（修正即新增/删除锚点，映射即时重算）。
