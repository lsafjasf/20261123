# 碰撞事件确定性混音器

物理引擎会连续产生碰撞事件（硬币轻响、木箱与玻璃同时落地……），声音不能无限叠加到爆音。
本项目实现一个**由碰撞速度与材质驱动**的混音器：

- 事件带发声优先级，相似音色按“音色族”轮换而不是无限叠音；
- 总线峰值超限时逐级压低次要声音，对话与危险提示走独立总线，始终清楚；
- 末端 brick-wall 限制器保证输出永不超过 `CEILING_DB`（默认 -1 dBFS）；
- **固定 seed + 固定事件流 => 逐位相同的 PCM / WAV / 指标输出**；
- 纯 TypeScript，仅用 Node.js 标准库与浏览器内置 WebCodecs、WebAudio、Canvas、MediaSource，**零第三方包、完全离线**。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/core/rng.ts` | mulberry32 确定性 RNG 与 32 位哈希 |
| `src/core/types.ts` | 事件/材质/总线类型、优先级、混音常数与速度曲线 |
| `src/core/synth.ts` | 6 种材质的参数化碰撞音色（模式叠加 + 滤波噪声） |
| `src/core/scheduler.ts` | 音色族配额、同族轮换、优先级抢占、调度日志 |
| `src/core/mixer.ts` | 三总线、侧链 ducking、过载二级 ducking、块级前瞻限制器 |
| `src/core/scenario.ts` | seed 驱动的确定性碰撞事件流 |
| `src/core/wav.ts` | 纯 TS 的 WAV/PCM16 编码器 |
| `src/browser/webm-muxer.ts` | 纯 TS WebM(EBML)/Opus 流式封装器 |
| `src/browser/encode-pipeline.ts` | WebCodecs `AudioEncoder` + MediaSource 流水线 |
| `src/browser/webaudio-player.ts` | WebAudio `AudioBuffer` 播放（回退路径） |
| `src/browser/visualizer.ts` | Canvas 总线峰值与保护增益曲线 |
| `src/node/render.ts` | 离线渲染 CLI，输出 WAV + 指标/调度 JSON |
| `src/node/server.ts` | 零依赖静态服务器，内置即时 TS 类型擦除 |
| `test/` | `node:test` 单元测试（14 个） |

## 运行

需要 Node >= 22.13（验证使用 Node 24，原生执行 `.ts`，无需编译步骤）。

```bash
npm test
node src/node/render.ts --seed 20261123 --duration 12 --rate 14 --out artifacts/mix
PORT=8080 node src/node/server.ts
# 浏览器打开 http://localhost:8080/demo/
```

渲染产物：

- `artifacts/mix.wav`：16-bit 48 kHz 立体声，同参数两次运行 sha256 相同；
- `artifacts/mix.metrics.json`：每块总线峰值、侧链/过载/限制器增益与事件清单；
- `artifacts/mix.schedule.json`：每个事件的接受/轮换/抢占/忽略记录。

## 混音决策链

1. **可听性门槛**：碰撞速度低于 `MIN_AUDIBLE_SPEED` 的普通事件忽略；危险提示无视门槛。
2. **速度映射**：`velocityToGain` 用 tanh 软拐点把速度映射到增益，高速不炸、低速有细节；亮度同步映射。
3. **音色族轮换**：材质归入 metal/wood/glass/stone/rubber/voice 六族，每族有并发配额（`FAMILY_QUOTA`）。配额满时替换同族中包络最靠后的声音；若同族全是更高优先级声音，则丢弃当前事件并记录 `stolen`。
4. **总线路由**：普通碰撞 -> `sfx`（可被压低）；危险提示 -> `danger`；对话 -> `dialogue`，后两者 `duckable=false`。
5. **侧链 ducking**：对话/危险总线出现信号（带 250 ms hold）时，`sfx` 平滑压到 -12 dB，释放 180 ms。
6. **过载二级 ducking**：master 峰值超过 -3 dBFS 时，可压低总线再压 -8 dB。
7. **限制器**：块级前瞻峰值包络，统一增益 + 硬安全限幅，输出永不超过 -1 dBFS。

## 确定性保证

- 所有随机来自 `Rng`（mulberry32，整数回绕用 `Math.imul`/`Uint32Array`），发声体私有种子 = `hash32(mixerSeed, eventId, hashString(family))`；
- 事件按 `(time, id)` 稳定排序，发声体加入与渲染顺序固定，不依赖 Map 迭代顺序或墙钟；
- 平滑器是固定系数一阶包络，逐块浮点运算顺序固定；指标与调度日志随渲染一同产出；
- 测试“同 seed + 同事件流输出逐位一致”直接比较两次渲染的每个 Float32 采样。

## 浏览器技术栈

- 服务器用 Node 内置 `module.stripTypeScriptTypes` 把 `.ts` 擦成 ESM JS 下发（源码刻意只用可擦除语法：无 enum、无参数属性）；
- 支持时走 WebCodecs `AudioEncoder`(Opus) -> 自研 WebM 封装 -> MediaSource 播放与下载；
- 不支持 WebCodecs 时回退到 WebAudio `AudioBuffer` 播放，音频仍来自同一份确定性 PCM；
- Canvas 只渲染指标，不参与音频计算，因此不改变可复现性。
