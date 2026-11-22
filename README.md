# 体育回放 · 末段倒放（Reverse Replay）

普通播放器只能反向拖动播放头、音频会断。本工具把结束点前最近可解码位置
（关键帧）起的整段 GOP 解码出来，视频帧逆序、音频 PCM 逐样本倒放，两者
共用同一条 AudioContext 主时钟时间线，实现画面和声音一起倒着走。

零第三方依赖：TypeScript 源码由 Node 24 原生类型剥离直接运行 / 实时转译，
浏览器端只用 WebCodecs、WebAudio、Canvas、MediaSource。

## 运行

```bash
node server.ts          # http://localhost:8321/
```

页面中点「加载示例视频」（或打开本地 MP4），默认选中最后 2 秒，
可拖动起止滑杆调整区间，然后：

1. **准备倒放片段** — 从起点前最近关键帧解码，修剪到 [起点, 终点)，
   帧逆序 + 音频倒放，报告计划音画误差。
2. **播放 / 暂停** — 暂停后再播从播放头位置继续，不会重复已播片段；
   播完后需点「从头重播」才会重新开始。
3. **导出** — 逆序视频经 VideoEncoder 重编码为 fMP4（页面内用
   MediaSource 即时预览），同时下载 `reversed.mp4`、`reversed.wav`、
   `report.json`；报告也会保存到 `artifacts/export-*.json`。

## 导出报告内容

- `originalRange`：原视频时间范围（秒）
- `frameOrder`：输出帧顺序（输出序号、输出时间、源 CTS、时长、是否关键帧）
- `avError.planned`：时间线镜像对齐误差（max/mean/RMS，逐帧）
- `avError.measuredPlayback`：实际播放时测得的音画偏差

## 测试

```bash
bash tools/make_sample.sh   # 生成 media/sample.mp4（需 ffmpeg）
npm test                    # 或 node --test test/*.test.ts
```

测试用 ffprobe 交叉验证解复用器（CTS/B 帧重排/关键帧/edit list）和
fMP4 封装器，并覆盖倒放时间线、暂停续播定位、音频倒放、WAV 编码。

## 结构

- `server.ts` — 静态服务 + TS 实时转译 + 导出报告落盘（仅 Node 标准库）
- `src/shared/mp4.ts` — MP4 解复用（stts/ctts/stss/stsc/stsz/stco/elst）
- `src/shared/timeline.ts` — 倒放时间线与音画误差计算（纯逻辑）
- `src/shared/wav.ts` — PCM 倒放与 WAV 编码
- `src/app/decoder.ts` — WebCodecs 解码管线（关键帧定位 → 修剪）
- `src/app/player.ts` — 倒放播放引擎（音频主时钟 + Canvas 逐帧）
- `src/app/mux.ts` — 最小 fMP4 封装器（MediaSource / 下载）
- `src/app/exporter.ts` — 重编码导出与报告生成
