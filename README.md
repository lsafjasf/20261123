# 婚礼四机位素材时间线核查与修复

婚庆收尾常见问题：换卡/断电导致时间戳空洞、片段进剪辑器黑帧、音画错位。
本工具把各机位片段按真实开机时刻排成一条可核查的全局时间线，标出
**重叠、空洞、非单调时间与累计漂移**；确认后重打整数时间戳，输出分片
fMP4 与逐样本**原值/新值对照表**。

## 核心原则：不把时间当浮点秒累加

所有时间以 `(ticks, timescale)` 有理数对表示，运算全程 `BigInt`：
第 n 帧时间戳 = 锚点 + n × 帧时长（**乘法直达，非累加**），误差恒小于
1 tick 且永不随时长增长。90000 刻度下 25fps（3600 tick/帧）与
29.97fps（3003 tick/帧）均为整数，六分钟素材逐帧零漂移（有测试断言）。

## 技术约束

- TypeScript + Node.js 标准库（Node >= 22.13，直接用类型擦除运行 `.ts`）
- 浏览器原生 WebCodecs / WebAudio / Canvas / MediaSource（验证页）
- **零第三方包、零云服务**：MP4 复用/解析、H.264(I_PCM)/AAC(静音)
  测试码流均为手工构造（`src/mp4.ts`、`src/h264.ts`、`src/aac.ts`）

## 使用

```bash
npm run gen -- --out demo                # 1. 程序化构造四机位故障素材
npm run align -- --manifest demo/manifest.json  # 2. 核查时间线
npm run repair -- --manifest demo/manifest.json --out repaired --yes  # 3. 确认后修复
npm test                                 # 全部测试（含 ffmpeg 解码验证，可跳过）
npm run serve                            # 浏览器验证页 http://localhost:8080/
```

修复产物：`repaired/<机位>/segNNN.mp4`（分片 fMP4，tfdt 为机位线绝对位置，
可直接落剪辑时间线）、`report.csv` / `report.json`（逐样本原值/新值/差值）。

## 注入的故障与修复策略

- 换卡空洞：保留墙钟空洞，不闭合（片段 tfdt 反映真实间隔）
- 断电截断：检出并标注 `TRUNCATED`
- tfdt 重复（非单调）：按帧号重打，计数 `NON_MONOTONIC_FIXED`
- 采样抖动 / 帧率误标（29.97 写成 30）：按声明帧率的有理数帧时长重打，
  六分钟收回约 0.36s 漂移
- 同机位重叠：默认裁掉后段头部样本（`TRIMMED_OVERLAP`，对照表可查）

## 目录

- `src/time.ts` 整数时间基元 · `src/mp4.ts` fMP4 复用/解析
- `src/h264.ts` `src/aac.ts` 手工测试码流 · `src/gen.ts` 素材生成
- `src/timeline.ts` 核查 · `src/repair.ts` 修复 · `src/cli.ts` 命令行
- `web/` 浏览器验证页 · `test/` node:test 测试
