# Frame Lens

本地 24 → 60 fps 运动补偿帧插值预览器。运行时零第三方依赖，不上传素材；TypeScript 配合 Node.js 标准库构建，浏览器侧只使用 Canvas、WebAudio、WebCodecs 和 MediaSource。

## 启动

```bash
npm start
```

默认访问 `http://localhost:4173`。端口被占用时可指定：

```bash
PORT=4399 npm start
```

Node 24 内置的类型剥离功能负责把 `src/**/*.ts` 编译到 `public/js`，不需要安装 TypeScript 或其他 npm 包。

## 功能

- 24 → 60 fps 有理时间轴：每个输出帧按 `timestampUs` 严格递增，24 fps 源帧相位按 0、0.4、0.8、0.2… 精确推进。
- 擦除对比、原片、插值和差异四种视图；可拖动中线。
- 前后向块匹配运动估计，前向/后向一致性检查；不可信区域不做软混合，直接选择最近一侧源帧，避免快速运动拉出大片重影。
- 遮挡/冲突边缘以橙色叠加显示；可按最大位移、遮挡阈值和分析块大小调节。
- 局部 ROI：只在框选区域启用完整插值，外部回到最近源帧；支持强度和羽化。
- 逐帧读数：源帧对、源时间、输出时间、相位、相邻输出帧间隔和 µs 级误差。
- 程序生成的平移 + 旋转序列，自动测量帧间隔、时间戳误差、帧序、遮挡覆盖和旋转区 MAE。
- 本地导出 60 fps VP8 WebM。WebCodecs 编码、内置 WebM 封装，随后用 MediaSource 回放；也可直接下载。
- 原始音轨通过 WebAudio 主时钟同步播放；导出的 WebM 为静音视频。

## 测试

```bash
npm test
```

使用 `node:test` 和断言模块，覆盖：

- 24→60 fps 输出帧数、精确间隔、时间戳舍入误差、单调性和重复时间戳。
- 合成平移 + 旋转序列相对最近帧保持的误差收益。
- 3× 快速运动时的硬回退与遮挡比例上限。
- ROI 外像素必须等于最近源帧。
- WebM 的 EBML/VP8 封装结构。

## 实现要点

- `src/core/motion.ts`：多尺度块匹配，粗层全局搜索、细层引导搜索，块级中值平滑。
- `src/core/interpolation.ts`：双向时间采样、前后向运动一致性、遮挡判定、ROI 权重和硬回退。
- `src/core/timeline.ts`：24→60 输出调度与时间统计。
- `src/core/synthetic.ts`：可解析的平移 + 旋转测试场景及前景遮罩。
- `src/core/webm.ts`：最小 EBML/WebM 封装器。
- `src/browser/`：本地取帧、WebAudio 时钟、Canvas 渲染、导出和 MediaSource 回放。

## 本地视频约束

- 输入按 24 fps 采样；导入后最多分析前 6 秒（144 帧）。
- 分析/预览尺寸受限于 384×216，以控制内存和单线程插值耗时；显示端平滑放大。
- 所有解码后的帧和编码结果只留在当前标签页内存与 Blob URL 中。
