# codec-bench：素材浏览器编码组合实测台

上线前用**程序生成的画面**在各终端做**真实编码 + 解码 + 回放**，而不是只信
`isConfigSupported()` 返回的 `true`。全部代码为 TypeScript，运行时只需要
Node.js（>= 23.6，推荐 24）标准库与浏览器原生
WebCodecs / WebAudio / Canvas / MediaSource。**离线、零第三方依赖**。

## 快速开始

```bash
node test/selftest.ts                      # 纯 Node 自测（不需要浏览器）
node src/node/harness.ts --list            # 查看默认矩阵 48 组配置 id
node src/node/harness.ts --browser /path/to/chrome        # 默认矩阵 x 3 次重复
node src/node/harness.ts --full --browser /path/to/chrome # 全交叉矩阵 216 组
node src/node/harness.ts                   # 无浏览器参数：打印 URL，任意浏览器手动打开
```

报告输出到 `artifacts/report.json` 与 `artifacts/report.md`。
有任何失败或结论不稳定（flaky）的配置时进程退出码为 2，可直接做上线门禁。

## 覆盖维度

- **编码**：avc1（baseline/high）、hev1、vp09、av01、vp8
- **分辨率**：320x180 / 1280x720 / 1920x1080
- **帧率**：24 / 30 / 60
- **色度**：I420 / NV12 / I422 / I444（直接以对应格式的 YUV 平面构造 `VideoFrame`）
- **码率**：按分辨率与帧率自动推算（`defaultBitrateKbps`），矩阵 id 中可见

## 每组配置记录什么

- **首帧时间**：`decode()` 首块到首个解码帧输出（`ttffMs`），另有编码首块延迟
- **耗时**：帧生成 / 编码 / 解码 / MSE 回放各阶段墙钟时间
- **峰值内存**：运行期间 JS 堆峰值（`performance.memory`，Chrome 系）；
  Linux 下 harness 另记录浏览器进程组峰值 RSS（`peakProcessRssBytes`）
- **内容偏差**：解码帧与程序生成的参考帧逐帧对比（BT.601 参考转换），
  报告 MAE 与 PSNR（均值/最差帧），低于 `--min-psnr`（默认 18 dB）判失败
- **回放**：真实编码码流经内置纯 JS fMP4 复用器打包，走 MediaSource
  播放，校验 `canplay`、`currentTime` 推进与 `requestVideoFrameCallback`
- **时钟可信度**：WebAudio `AudioContext.currentTime` 对照 `performance.now()`，
  暴露 headless/后台标签页的计时器节流（`audioClockSkewMs`）

## 一致性判定

同一配置默认重复 3 次（`--repeat`）。每次运行一个独立页面加载（独立浏览器
进程），输入帧由确定性 PRNG 生成、逐字节一致。所有重复结论相同 →
`pass`/`fail`；不一致 → `flaky`，与 `fail` 一样使退出码为 2。

## 失败配置的最小复现

`artifacts/report.md` 为每个失败/flaky 配置给出：

```bash
node src/node/harness.ts --only <config-id> --repeat 3   # 自动复跑该配置
node src/node/harness.ts --only <config-id> --keep-server # 常驻服务，手动打开打印的 URL 复现
```

报告中同时附该配置的完整参数 JSON、失败阶段、错误信息与
`isConfigSupported` 声称值（用于对比"声称支持但实测失败"的情况）。

## 目录结构

```
src/shared/    纯逻辑：PRNG、矩阵、帧生成、指标、fMP4 复用器、结果聚合（Node 可测）
src/browser/   浏览器端：WebCodecs 管线、MSE 回放、WebAudio 时钟、运行入口
src/node/      harness：CLI、HTTP 服务（TS 实时剥离类型下发）、浏览器编排、报告
test/          自测（含模拟浏览器的 harness 端到端）
artifacts/     报告输出目录
```

## 说明与限制

- 浏览器端 TS 由 harness 用 `node:module.stripTypeScriptTypes` 实时剥离类型后
  下发，因此源码须保持"可擦除语法"（不用 enum/namespace/参数属性）。
- MSE 校验覆盖可装入 MP4 的编码（avc1/hev1/vp09/av01）；vp8 标记为 skipped。
- 手动模式（无 `--browser`）不设单轮超时；自动模式默认单轮 90 s（`--timeout-ms`）。
