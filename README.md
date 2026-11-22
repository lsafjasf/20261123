# 离线 LUT 视频调色台

纯 TypeScript 实现的浏览器端 3D LUT 视频调色工具。**零第三方运行时依赖**，仅使用 Node.js 标准库与浏览器原生
WebCodecs、WebAudio、Canvas、MediaSource 能力，全程可离线运行。

## 功能

- **3D LUT 套用**：支持 Adobe/Resolve 风格 `.cube` 与通用 `.3dl`，三线性插值，输入域可配置。
- **强度调节**：原图与调色结果按 0..1 线性混合，强度 0 严格等于原图。
- **前后对比**：关闭 / 擦拭滑块 / 左右分屏三种模式，原始帧始终保留未调色副本。
- **越界与过曝标记**：统计并高亮过曝削波（洋红）、LUT 输出越界（青色）、非法采样（红色）。
- **颜色节点时间线**：时间线上放置多个颜色节点，节点间用 smoothstep 平滑过渡强度并对 LUT 做交叉混合。
- **确定性导入**：LUT 文本先归一化（去注释、统一空白与换行）再做 SHA-256，同一文件反复导入得到相同 id，
  注册表幂等去重；解析结果与平台无关。
- **顺序可解释**：内置对比器量化 `A→B` 与 `B→A` 的差异，并解释 LUT 串联合成为何通常不可交换。
- **三种画面源**：WebCodecs 硬解（首选）、MediaSource + `<video>` 回退、无需素材的离线合成画面。

## 目录结构

```
src/
  core/      平台无关的纯逻辑（解析、采样、调色管线、时间线、顺序解释、SHA-256）
  media/     EBML/WebM 解封装、WebCodecs 引擎、MSE 回退、WebAudio 拉流、合成源
  render/    Canvas 渲染器（对比、分屏、高亮）
  main.ts    UI 控制器
luts/        内置示例 LUT（恒等、暖调、青橙、黑白、.3dl）
tests/       Node 内置 test runner 单元与集成测试
scripts/     零依赖构建脚本与静态服务器
```

## 运行

需要 Node.js >= 22.6（使用内置 TypeScript 类型擦除，无需安装 tsc 或任何依赖）。

```bash
npm test            # 运行测试（node --test，零依赖）
npm run build       # 将 src/*.ts 擦除类型输出到 dist/
npm run serve       # 启动 http://localhost:8080 静态服务器（支持 Range/MSE）
```

浏览器打开 `http://localhost:8080/`：

1. 点击「使用离线合成画面」即可立即体验，或导入 WebM（VP8/VP9/AV1 + Opus/Vorbis）。
2. LUT 库已内置示例，也可拖入自己的 `.cube` / `.3dl`。
3. 在时间线上添加颜色节点，拖动强度与过曝阈值，切换前后对比模式。
4. 在「顺序解释」面板选择两个 LUT，量化并阅读顺序差异说明。

## 确定性与顺序原理

- **幂等导入**：归一化文本经纯 TS 实现的 SHA-256（`src/core/hash.ts`）得到稳定 id，浏览器与 Node 结果一致，
  不依赖 `crypto.subtle` 的异步环境。空白、注释、CRLF/LF 差异不会产生新条目。
- **为何顺序敏感**：串联两个 LUT 等价于函数复合——先 A 后 B 是 `B(A(x))`，先 B 后 A 是 `A(B(x))`。
  三线性插值得到的色调映射是非线性的，函数复合一般不满足交换律；仅当其中之一为恒等映射或二者线性相容时
  才可交换。`src/core/orderExplain.ts` 在规则网格上采样，给出平均/最大色差与差异点占比。

## 浏览器能力降级

- 支持 WebCodecs：`VideoDecoder`/`AudioDecoder` 解码，AudioContext 时钟做 A/V 同步。
- 不支持 WebCodecs 但支持 MediaSource：用 SourceBuffer 原生解码，Canvas 抽帧复用同一套调色管线。
- 两者皆不可用：仍可使用离线合成画面完整体验全部调色与时间线能力。

## 约束

- 运行时零第三方库；`package.json` 无 dependencies，构建与测试仅用 Node 标准库。
- TypeScript 采用可擦除语法（无 parameter property、无 const enum 运行时引用），便于零编译器构建。
