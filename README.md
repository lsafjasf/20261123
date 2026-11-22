# 课程混音本地检查器

在本机比较课程混音在几种播放条件下的对白可懂度、掩蔽与削波风险。对白、音乐、效果声可分别开关/调增益，并标出发生掩蔽或削波的时段。

> **重要声明：所有播放条件都是近似经验模型（heuristic approximation），由本地 DSP 估算，不是真机测量，也不替代专业声学测量或母带质检。** 报告与界面中都会持续显示该声明。

## 设计约束

- 只用 TypeScript + Node.js 标准库；浏览器只用内建 WebCodecs / WebAudio / Canvas / MediaSource 能力检测。
- 无外部依赖、无 npm install、无云服务；音频只在本机处理，不上传。
- 不强制把所有内容压成同一响度来“过关”。默认不做响度归一化；可选的“响度对齐”仅加一个统一静态增益用于监听 A/B，**不改变分轨平衡**，并在报告中明确标注。

## 快速开始

需要 Node.js 24+（使用内置 TypeScript 类型擦除，无需编译步骤）。

```bash
# 启动本地界面
npm start
# 打开 http://localhost:8127

# 命令行：内置演示信号
npm run analyze -- --demo --json report.json --markdown report.md

# 命令行：自己的 WAV 分轨（可只给部分）
npm run analyze -- \
  --dialogue examples/dialogue.wav \
  --music examples/music.wav \
  --effects examples/effects.wav \
  --markdown report.md

# 自测与测试
npm run selftest
npm test
```

分轨开关通过很大的负增益（-96 dB）表示静音，分析帧始终对齐，不会因为缺轨产生时间错位。

## 近似播放条件

所有参数（分带响应、底噪、限幅阈值、高/低通截止）都是面向设备类别的工程经验值，定义在 `src/shared/devices.ts`：

- `monitor-headphones`：近似平坦的监听耳机参考链。
- `phone-speaker`：手机小喇叭，低频滚降、2–6 kHz 峰、输出受限。
- `car-cabin`：行驶座舱，路噪/风噪抬高底噪、高频受限。
- `laptop-speaker`：轻薄笔记本，动态范围小、易触发限幅。

## 检测口径（均为近似模型）

- **掩蔽**：Hann 窗 STFT 汇总到 12 个 Bark 风格频带；先做语音活动门限（静默/停顿段不算掩蔽），再用简化 SII 思路计算对白频段相对“音乐+效果+环境底噪”的可听度比例与掩蔽占比，连续超阈值才合并成带起止时间的事件。
- **硬削波**：渲染信号在该条件的硬削波阈值之上连续出现的时段。
- **限幅介入（soft clip）**：信号持续越过限幅器天花板、动态被压缩的时段。
- **响度**：BS.1770 风格 K 加权 + 双门限门控的积分 LUFS、400 ms 短期最大、4x 过采样真峰 dBTP、峰均比。

阈值集中在 `src/shared/devices.ts` 的 `ANALYSIS_CONFIG`，可按经验调整；调整后应重跑 `npm test`。

## 代码结构

- `src/shared/`：Node 与浏览器共用的纯 TS 分析核心（DSP、STFT、掩蔽/削波、响度、WAV 编解码、设备模型、演示信号）。
- `src/cli/`：命令行入口、Markdown 报告、自测。
- `src/server/`：零依赖 HTTP 服务，按需对浏览器端 TS 做类型擦除并把 `.ts` import 重写为可加载的 `.js?ts=1`。
- `src/browser/`：界面、WebAudio 播放图（实时预览同一近似设备链）、Canvas 时间线、报告导出。
- `test/`：基于 `node:test` 的测试。

## 浏览器解码说明

- WAV 优先走内置纯 TS 解析器（PCM 8/16/24/32 位与 32 位 float），保证本地确定性。
- 其它压缩格式回退到 WebAudio `decodeAudioData`；界面会显示当前环境 WebCodecs / MediaSource 能力检测结果。
- MediaSource 用于能力检测与说明；本地文件工作流不经过网络流，因此没有把它放进核心播放路径。

## 已知边界

- 没有真实硬件测量、没有心理声学实测标定，事件阈值是工程经验值。
- 重采样用线性插值，FFT 为自实现 radix-2，面向相对比较而非实验室精度。
- 浏览器实时播放图是分析链的近似预览，数值结论以离线分析报告为准。
