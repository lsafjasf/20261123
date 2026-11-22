# take-comp · 多 take 句子级配音拼接台

配音演员录了 N 个 take，最终成品可能由「A 的第一句、C 的第二句…」拼成。
本工具把多个 take 按句子对齐，逐句比较**口型节奏 / 情绪 / 噪声底**，点选后
拼成连续音轨：切点落在气口（呼吸）最安静处，接缝用短交叉淡化消除爆音，
并且**每段都记得自己来自哪个 take**。改任何一句都是非破坏性的——其它
位置采样级不变。

**零第三方依赖、完全离线**：TypeScript 源码，Node.js 标准库服务器
（`node:http` / `node:fs` / `node:module` 类型擦除，免构建），前端只用
WebAudio / WebCodecs / Canvas / MediaSource。

## 运行

```bash
node tools/make-demo-takes.ts   # 可选：生成 12 条演示 take 到 takes/
node server.ts                  # → http://localhost:8080
```

把真实录音（wav/mp3/ogg/flac/m4a/aac）放进 `takes/`，在页面里点
「加载 takes/」；或不启动服务器直接「打开本地文件」。

测试：`npm test`（Node 24+，原生运行 TypeScript，无需安装任何东西）。

## 工作流

1. **切句与对齐** — 每个 take 先做 VAD 切句（噪声底自适应阈值 + 迟滞，
   气口靠周期性检测剔除，不作为句子），再按句序/DTW 跨 take 对齐。
2. **比较矩阵** — 行=句子、列=take。每格显示波形与四个指标：
   - `±%` 时长偏差、`♪` 节奏包络相关（口型节奏）
   - `情` 情绪差异（响度/基频/音域/频谱质心加权距离）
   - `噪` 句前气口处的噪声底 dB
   点击单元格 = 选用该 take 并立刻试听（含气口把手）。
3. **拼接** — 每句锚定在参考 take 的固定时间线位置上（按语音起始点对齐），
   切点取句间气口能量最低处；接缝叠加等功率短交叉淡化（默认 12 ms，可调）。
4. **溯源** — 拼接时间线上每段按来源 take 着色并标注 `S句·Ttake`；
   「保存工程」把每句选择写入 `project.json`，可随时读回继续改。
5. **导出** — WAV（PCM16）或 AAC（WebCodecs 编码 → ADTS），AAC 导出后
   自动经 MediaSource 试听。

## 非破坏性保证

每句在成品时间线上的位置只取决于参考时间线，与其它句选了哪个 take
无关。因此改第 k 句时，只有第 k 段 ± 一个淡化长度内的采样会变化，
其余位置逐采样一致（`test/comp.test.ts` 里有位精确回归测试）。

## 结构

```
server.ts               Node 标准库服务器：静态服务 + TS 即时转译 + takes/工程 API
src/shared/dsp.ts       分帧能量、VAD 切句、气口谷值切点、基频、频谱质心（纯函数）
src/shared/align.ts     跨 take 句子对齐（索引对齐 + DTW 兜底）
src/shared/metrics.ts   节奏/情绪/噪声底指标
src/shared/comp.ts      固定时间线拼接计划 + 等功率交叉淡化渲染 + 溯源
src/shared/wav.ts       WAV 编解码
src/app/                浏览器端：Canvas 矩阵/对比/时间线视图、WebAudio 试听、
                        WebCodecs AAC 导出、MediaSource 试听
tools/make-demo-takes.ts 生成 12 条带不同节奏/情绪/噪声底的合成 take
test/                   node:test 单元与集成测试（无需浏览器）
```

`src/shared/*` 不依赖 DOM，同一套代码既跑在浏览器也跑在 Node 测试里。
