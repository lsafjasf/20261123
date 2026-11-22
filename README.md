# 留白 Pause Studio

一个纯本地、零依赖的双轨 WAV 停顿编辑器。拖入音频后自动识别超过 800 ms 的低能量留白，将它压至约 250 ms；整段可做保持音高的变速，并按流媒体标准调整响度后导出新的 24-bit WAV。

原始文件只在浏览器内存中读取，不会上传、写回或覆盖。

## 运行

要求 Node.js 24 或更高版本（使用内置 TypeScript 类型剥离）。

```bash
npm start
```

打开 `http://localhost:4173`。不需要 `npm install`，项目没有任何第三方依赖，也不会发起外部网络请求。

其他命令：

```bash
npm test          # DSP、WAV 与完整导出链路测试
npm run check     # 前端 TypeScript 语法、HTML 绑定与离线约束检查
PORT=4199 npm start
```

## 功能

- 拖入一个双轨（立体声）WAV，或两个等长单轨 WAV；支持 8/16/24/32-bit PCM 与 32/64-bit float WAV。
- 10 ms 能量帧、分位数底噪估计、70 ms 空穴闭合和 22 ms 边界内缩，避免切到字头、尾音与呼吸。
- 每处自动停顿都可逐段试听、旁路、撤销、单独修改目标长度；支持全局撤销 `Ctrl/Cmd + Z`。
- 自动检测只处理低能量空白。笑声、语气词等非静音内容不会进入剪切区；有意义的留白可以直接旁路或撤销。
- 0.75× / 1.0× / 1.25× / 1.5× / 2.0× 整段变速，使用 STFT 相位声码器保持音高。
- 导出前按 ITU-R BS.1770 门控积分测响度，4× 插值估算真峰值，并用前瞻峰值限制器守住 −1 dBTP。
- 默认流媒体目标为 −14 LUFS，也可选择播客 −16 LUFS 或广播 −23 LUFS。
- 导出文件名为 `原名.pausecut-<LUFS>LUFS-<倍速>x.wav`，永远不会与源文件同名。

## 结构

```text
server.ts                    Node 标准库静态服务与运行时 TS 类型剥离
web/index.html              工作台界面
web/styles.css              Canvas 工作站视觉系统
web/src/app.ts              状态、交互、撤销、试听与导出流程
web/src/ui/waveform.ts      峰值缓存与 Canvas 时间线
web/src/ui/audio-engine.ts  WebAudio 播放、轨道静音和片段试听
web/src/core/wav.ts         WAV 解码、单轨配对与 24-bit 编码
web/src/core/detection.ts   停顿检测与置信度
web/src/core/render.ts      留白拼接、目标时长映射与相位声码器
web/src/core/loudness.ts    LUFS、真峰值与限制器
web/src/core/demo.ts        可重复的演示双轨素材
tests/                      Node 内置测试
```

## 处理顺序

1. 将每处 `active` 停顿的目标长度换算到源时间轴：`目标 ms × 倍速`，保留停顿两端并以短交叉淡入淡出衔接。
2. 对拼接后的整段做相位声码器时间伸缩；速度被烘焙进播放缓冲，因此浏览器预览和导出都保持音高。
3. 对成片重测积分响度，施加增益和 5 ms 前瞻限制器，再写出新的 24-bit PCM WAV。

## 边界

停顿检测基于能量与底噪，不做语义识别，因此“有意义留白”的判断最终仍由人决定。界面把每个自动判断都暴露为可检查片段，并允许逐段旁路或撤销；所有编辑都发生在内存中的新缓冲上。
