# LAN Relay

电竞馆局域网内的单源多屏中继。制作机只推一路本地 FLV/RTMP，训练室各终端从**最新关键帧**加入观看；源流断开、本机网络断开、客户端处理不过来会分别诊断，不共享阻塞点。

整个项目可离线运行：服务端只用 Node.js 标准库，前端 TS 由 Node 的 `stripTypeScriptTypes` 按需转换为 JS，没有 npm 依赖，也不下载任何媒体资源。模拟制作机和观看端都由本地 Canvas/WebCodecs/WebAudio 代码产生。

## 快速开始

```bash
# Node.js 24（需要原生 TypeScript type stripping）
npm start
```

打开：

- `http://localhost:8080`：控制台与实时状态
- `http://localhost:8080/simulator.html`：Canvas + WebCodecs + WebAudio 模拟制作机
- `http://localhost:8080/viewer.html`：WebCodecs/Canvas 或 MSE/fMP4 观看端
- `http://localhost:8080/api/status`：机器可读状态 JSON

先点模拟制作机的“开始出流”，再打开任意多个观看页。观看端会自动连接、从当前 GOP 的关键帧开始解码，并在断线后指数退避重连。

## 接入真实制作机

TCP `1935` 端口会按首字节自动识别裸 FLV 或 RTMP：

```bash
# 裸 FLV over TCP
ffmpeg -re -i match.mp4 -c copy -f flv tcp://127.0.0.1:1935

# 标准 RTMP 推流
ffmpeg -re -i match.mp4 -c copy -f flv rtmp://127.0.0.1/live/match

# 局域网另一台制作机（替换中继地址）
ffmpeg -re -i match.mp4 -c copy -f flv rtmp://192.168.1.20/live/match
```

中继不做转码，只解 FLV tag 并重排为观看端消息：

- 视频：H.264 AVC，保留 `AVCDecoderConfigurationRecord`
- 音频：AAC、MP3 或 FLV 线性 PCM
- 浏览器模拟源：WebCodecs H.264 + WebAudio 44.1 kHz PCM

RTMP 实现覆盖握手、chunk stream、AMF0、`connect/createStream/publish` 和 AVC/AAC 消息，足够 FFmpeg/OBS 的本地推流场景。

## 故障与背压语义

| 现象 | 判据 | 行为 |
| --- | --- | --- |
| 客户端慢 | 服务端单连接队列超水位，或浏览器解码/缓冲积压 | 只清空该客户端的媒体队列，跳到下一关键帧；其他连接继续 |
| 本机网络断开 | `navigator.onLine=false`、WS 关闭、6 秒无心跳 | 本机指数退避重连，恢复后重新请求最新 GOP |
| 源流没了 | 制作机 TCP 关闭，或 5 秒无媒体 | 中继保持在线，观看端显示源中断；源重连创建新代次 |

关键隔离点：

- 入站解析、GOP 缓存、广播都在事件循环内做非阻塞入队，不等待任何慢 socket。
- 每个观看连接有独立 `SocketPeer` 队列，超过 `CLIENT_QUEUE_BYTES` 只丢自己的媒体，不触发全局限流。
- 丢弃后进入 `needsKeyframe`，下个视频关键帧前自动补发当前 AVC/AAC 配置。
- GOP 环形缓存只保留最近 `GOP_CACHE_COUNT` 个 GOP，总字节不超过 `GOP_CACHE_BYTES`；单个超大 GOP 会被整体丢弃，等下一关键帧，内存不会无限增长。
- 新观看者先收到 `hello`，再收到视频/音频配置，然后收到当前 GOP 的关键帧及后续帧。
- 源代次 `generation` 递增。旧源即使因为半开连接晚到数据，也会被代次检查拒绝。
- 服务端每 15 秒发 WebSocket ping；浏览器每 500 ms 回报播放队列。源与客户端生命周期分别记在 `/api/status`。

## 可配置项

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HTTP_PORT` | `8080` | HTTP/WS 端口 |
| `RTMP_PORT` | `1935` | FLV/RTMP TCP 入站端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `GOP_CACHE_BYTES` | `25165824` (24 MiB) | 服务端 GOP 缓存硬上限 |
| `GOP_CACHE_COUNT` | `3` | 保留 GOP 数 |
| `CLIENT_QUEUE_BYTES` | `8388608` (8 MiB) | 单观看连接应用层队列上限 |
| `DEBUG_RTMP` | 未设置 | 设为 `1` 打印 RTMP 命令诊断 |

所有限制都是硬上界，不会因观看人数或源码率自动扩张。默认最多 128 个观看连接。

## 播放端实现

观看页有两种本地播放模式，可随时切换并自动重新请求关键帧：

1. **WebCodecs / Canvas**：二进制 AVC 帧送入 `VideoDecoder`，解码结果画到 Canvas；AAC 用 `AudioDecoder`，PCM 直接交给 WebAudio 的 `AudioContext`。
2. **MSE / fMP4**：本地迷你 MP4 封装器把 H.264 样本打成 `ftyp/moov/moof/mdat`，通过 `MediaSource` + `SourceBuffer` 播放；AAC 走独立音轨，PCM 仍由 WebAudio 输出。

没有 `MediaSource`、`VideoDecoder` 或 H.264 编码支持时，页面会明确显示不可用原因，不会静默黑屏。

## 协议摘要

观看连接：`ws://<relay>:8080/ws`

文本控制消息：

- `hello`：客户端 ID、源状态、服务端限制
- `source`：源上线/下线、代次、协议、重连次数
- `track-config`：轨道元数据
- `diag`：源、GOP 缓存、所有客户端与自身队列诊断

二进制媒体消息固定 24 字节头：

```text
0..3   magic "EFR1"
4      version
5      kind: 1=video config, 2=audio config, 3=video, 4=audio
6      flags: 1=keyframe, 2=GOP start, 4=replay
7      reserved
8..15  PTS milliseconds (float64 LE)
16..19 duration milliseconds (float32 LE)
20..23 sequence (uint32 LE)
24..   AVC/AAC/PCM payload
```

`/source` 是模拟制作机使用的 FLV-over-WebSocket 入站；真实制作机使用 TCP `1935`。

## 验证

```bash
npm test
```

测试覆盖：

- AMF0 命令与对象往返
- 分片 FLV 的 AVC 尺寸解析、AAC 配置、关键帧与 PTS
- GOP 缓存字节上界和超大 GOP 丢弃
- 新观看者 `config → latest keyframe` 顺序
- 单客户端写失败隔离
- 源重连代次
- 慢客户端队列溢出、丢媒体、等待关键帧与恢复
- RTMP 消息被任意大小 TCP 分片切开时，音视频时间戳与样本数不漂移

已在本机额外验证：

- FFmpeg RTMP 推流（AVC + AAC）进入中继，GOP 缓存与状态 API 正常
- FFmpeg 裸 FLV/TCP 推流，协议自动识别正常
- Node 内置 WebSocket 客户端收到 `hello → 视频配置 → 音频配置 → 带关键帧标记的最新 GOP`
- 观看端生成的 fMP4 视频/音频片段可被 `ffprobe` 识别为 H.264/AAC
- Chromium 实测 WebCodecs/Canvas 和 MSE/fMP4 两条播放路径，MSE 音视频轨均进入同一时间窗
- 浏览器模拟源实测 30 FPS H.264 编码与 44.1 kHz PCM 出流

## 边界

- 面向可信局域网，不含鉴权、TLS 或公网暴露防护。
- 中继只处理 FLV/RTMP 与 H.264/AAC/PCM，不做编码转换。
- 浏览器 MSE 的 AAC 支持取决于平台；不支持时请使用 WebCodecs 模式。
- 自动播放策略可能要求页面上一次点击才能启用声音；观看页提供明确的“启用 WebAudio 声音”按钮。
