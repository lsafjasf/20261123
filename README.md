# NIMBUS 离线受控播放原型

一个完全本机运行的培训视频受控播放演示。清单、片段级密钥轮换、短时许可、离线缓存校验和错误收敛均由 TypeScript + Node.js 标准库 + 浏览器原生 API 完成，不包含第三方运行依赖、云服务或外部媒体。

## 运行

要求 Node.js 24+，以及支持 WebCodecs、MediaSource、WebAudio、Canvas 的 Chrome/Edge。

```bash
npm start
```

打开 `http://127.0.0.1:4317`。可通过 `PORT=5000 npm start` 更换端口。

首次联机启动时，浏览器会：

1. 读取本地清单与 30 秒许可策略。
2. 从 Node 授权端取得 ECDSA 签名的许可证和两代 AES-128-GCM 密钥。
3. 用 Canvas 绘制画面、WebAudio 合成音轨、WebCodecs 编码 VP8/Opus。
4. 自行封装 WebM，按片段 AES-GCM 加密并写入 IndexedDB。
5. 通过 MediaSource 逐片段解密、校验并播放。

媒体生成通常需要数秒，进度会显示在播放器中央。

## 可验证行为

- **中途轮换**：第 3 个片段切换到 `epoch-02-b`。每次切换都会检查片段与密钥代次，轮换事件会显示在右侧密钥账本和事件记录中。
- **暂停过期**：许可窗口 30 秒，暂停和后台停留继续计时。暂停到过期后再点继续，会停在 `LICENSE_EXPIRED` 错误页。
- **离线硬闸门**：点击“模拟断网”后，播放仍只从 IndexedDB 读取。离线重载时引导流程不会请求 `/api/*`；缓存不完整或缺少许可证明会拒绝启动。应用壳由 Service Worker 缓存，本地 Node 服务不可达时也能重新打开应用并自动回退到缓存校验。
- **失败不白屏**：点击“下一片段切换失败”后，片段预取会抛出受控错误，页面切换为完整错误屏，而不是留下空播放器。
- **缓存重建**：在线时可清除 IndexedDB 并重新生成所有媒体与密钥材料。

右侧状态卡同时显示许可倒计时、密钥代次、缓存片段数、加密载荷大小和实时事件。

## 结构

- `server/index.ts`：Node 标准库 HTTP 服务、静态资源与许可 API。
- `server/licensing.ts`：会话、密钥派生、许可证签名与片段绑定。
- `server/course.ts`：清单与许可策略。
- `client/bootstrap.ts`：联机预热、离线引导、许可缓存与缓存复用判断。
- `client/generate.ts`：Canvas/WebAudio/WebCodecs 媒体生成、WebM 封装和片段加密。
- `client/player.ts`：MediaSource 播放、片段预取、许可闸门、哈希校验和失败收敛。
- `client/db.ts`：IndexedDB 缓存与不可导出设备包装密钥。
- `client/sw.ts`：应用壳离线缓存；API 请求不会被离线缓存替代。
- `client/app.ts`：界面状态机、错误页和故障演练。
- `scripts/build.mjs`：使用 Node 24 内置 TypeScript 类型剥离 API，无编译依赖。

## 测试

```bash
npm test
```

测试覆盖清单约束、密钥代次轮换、ECDSA 许可证签名、会话过期、片段绑定和签名篡改拒绝。

如果本机有可用的 Headless Chrome DevTools 端口，可额外运行浏览器冒烟测试：

```bash
node scripts/cdp-smoke.mjs
SMOKE_MODE=fault node scripts/cdp-smoke.mjs
SMOKE_MODE=expiry node scripts/cdp-smoke.mjs
SMOKE_MODE=offline node scripts/cdp-smoke.mjs
```

脚本默认连接 `127.0.0.1:9222`，应用端口默认 `4317`，并生成 `/tmp/nimbus-*.png` 截图。

## 原型边界

这是一套可执行的控制流原型，不是生产级 DRM。设备包装密钥用于避免在 IndexedDB 中直接持久化片段密钥，但同源恶意脚本、浏览器调试权限或已控制的操作系统仍可能读取内存。真实部署还需要操作系统密钥库、远程证明、播放器完整性保护和更强的许可证撤销机制。
