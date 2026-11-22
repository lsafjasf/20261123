# 远程排练延迟分段测量工具

全本地、零第三方依赖的端到端音频延迟测量系统。通过「Canvas 闪光 + WebAudio
短促蜂鸣」同步标记，沿音频管线逐阶段打点，量化总延迟、抖动与丢样，并在报告中
明确指出最慢环节。

## 解决的问题

远程排练时，老师说完话到学生端听到回声存在明显延迟，但无法判断慢在哪个环节。
本工具把端到端链路拆成五段分别计时：

| 分段 | 起点 → 终点 | 含义 |
| --- | --- | --- |
| 采集 `capture` | T0 标记 → T1 采集 Worklet 检出蜂鸣 | 麦克风/音频输入耗时 |
| 处理 `process` | T1 → T2 处理 Worklet 输出 | 增益、滤波等 DSP 耗时 |
| 上传 `upload` | T3 编码完成 → T6 接收端收到帧 | 编码入队 + 网络 + 服务端中继 |
| 解码 `decode` | T6 → T7 SourceBuffer 完成解复用/解码 | WebM 解封装与 Opus 解码 |
| 声卡输出 `output` | T7 → T8 输出 Worklet 实际推动声卡 | 缓冲调度与声卡放音耗时 |

每个标记都带唯一轮次 ID 与序号，不同轮次的数据在服务端房间、状态存储、报告
三个层面物理隔离，关闭的轮次只读且拒绝迟到写入。

## 技术栈

- TypeScript（仅用可擦除语法，由 Node 内置 `stripTypeScriptTypes` 即时编译，无构建步骤）
- Node.js 标准库（`node:http`、`node:crypto`、`node:fs` 等），手写 RFC 6455 WebSocket
- WebCodecs `AudioEncoder`（Opus 编码）
- WebAudio `AudioWorklet`（采集检测、DSP、声卡输出检测）
- Canvas（同步闪光与趋势/柱状图）
- MediaSource + SourceBuffer（Opus-in-WebM 实时解复用解码）
- 无任何第三方 npm 依赖

## 运行

要求 Node.js >= 23.6（内置类型擦除；开发环境为 Node 24）。

```bash
npm start
# 自定义端口
PORT=9000 npm start
```

浏览器打开 `http://localhost:8080`，建议使用最新版 Chrome/Edge（需要
WebCodecs、MediaSource Opus 支持）。

### 典型测量流程

1. 发送端页面「新建轮次」，选择「我是发送端」，开始采集与发送。
2. 接收端在另一标签页或另一台机器上粘贴同一轮次 ID，选择「我是接收端」，
   开始接收与播放。
3. 发送端开启自动标记或手动打标记，每次标记同时触发闪光与蜂鸣。
4. 结束本轮后自动生成报告，也可随时「刷新报告」或导出 JSON。
5. 无麦克风的环境可勾选「单机环回模式」，蜂鸣直接注入采集节点，本机自发自收。

## 测试

```bash
npm test
```

测试覆盖协议编解码、WebSocket 帧、时钟同步、分析统计、WebM/EBML 复用、
端到端服务端中继与轮次隔离（使用 Node 全局 WebSocket 客户端）。

## 目录结构

```
src/
  shared/        浏览器与 Node 共用的纯逻辑（协议、WS、时钟、分析）
  server/        HTTP 静态服务、TS 擦除、WebSocket 中继、轮次存储
  client/
    audio/       AudioWorklet 处理器与标记生成器
    mux/         EBML/WebM 复用器
    sender/      发送端引擎（采集→处理→编码→复用→发送）
    receiver/    接收端引擎（接收→MSE 解码→声卡输出）
    transport/   WS 客户端封装、时钟桥
    ui/          状态存储、Canvas 图表、报告渲染
test/            node:test 测试
```

## 指标口径

- 总延迟：`T8 - T0`，即标记发射到声卡实际放音。
- 抖动：相邻标记同一分段耗时一阶差分的样本标准差。
- 丢样：序号缺口（网络/缓冲）、SourceBuffer 追加失败、输出 Worklet 欠载。
- 最慢环节：各分段平均耗时最大者，在报告柱状图与摘要中红色高亮。
- 时钟：NTP 风格四次时间点估计，取最小 RTT 样本的偏移，所有时间戳归一到
   服务端墙钟口径。
