# 直播讲课音频处理链

浏览器本地实时音频处理：**降噪 → 清晰度 → 限峰**，面向直播讲课场景。

- 运行时零第三方依赖、零云服务：TypeScript 源码由 Node 24 内置的
  `module.stripTypeScriptTypes` 转译（`build.js`），服务器仅用 Node 标准库。
- 前端使用 WebAudio（AudioWorklet）、Canvas、MediaRecorder + MediaSource。

## 运行

```bash
npm run build     # src/*.ts -> public/*.js
npm start         # 静态服务器，默认 8080，PORT 环境变量可改
npm test          # DSP 冒烟测试（Node 中模拟 AudioWorklet 环境）
```

浏览器打开 `http://localhost:8080`（麦克风权限要求 localhost 或 HTTPS）。

## 功能要点

- **链顺序可拖动**：三个处理器卡片支持 HTML5 拖拽排序，实时生效。
- **单模块旁路**：每个卡片有旁路开关与参数滑杆。
- **预设**：顺序/旁路/参数整体存入 localStorage，可命名、应用、删除。
- **设备断开不错位**：所有 DSP 常驻同一个 AudioWorklet，设备拔出只摘除
  输入源节点，链配置原样保留；同一设备重新插入后自动重连。
- **测试信号**：呼吸声（验降噪）、敲击声（验限峰）、长元音 /a/（验清晰度），
  由 OfflineAudioContext 程序化渲染，循环播放。
- **延迟显示**：实时显示 处理链 + 渲染量子 + 输出设备 的总延迟（ms）。
- **失效条件**：页面底部列出各模块的失效条件与顺序建议。

## 结构

```
server.js        Node 标准库静态服务器
build.js         TS -> JS 转译（Node 内置 API，无第三方包）
src/worklet.ts   DSP：谱减降噪 / 临场感 EQ / 前视限幅
src/main.ts      UI、设备热插拔、测试信号、预设、可视化、录制回放
public/          页面、样式与构建产物
test/dsp-test.mjs  DSP 冒烟测试
```
