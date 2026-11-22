# FRAME/SAFE — 档案胶片扫描时序修复

离线运行的胶片扫描修复工具。只用 TypeScript、Node.js 标准库与 Web 平台 API
（Canvas / WebCodecs / MediaSource / WebAudio），零外部依赖。

针对扫描胶片上的灰尘、毛发与竖划痕，利用前后帧做时序分析，只在可信区域修补，
绝不整帧降噪或模糊，颗粒在修补掩膜内按局部统计重新分布。

## 工作原理

- 瞬时污染（尘/毛发）：当前帧偏离时域中值、且前后帧同位置干净 → 掩膜内扩散修补 + 颗粒重注入。
- 竖划痕：相对长时参考的细竖直偏差、横向侧翼干净 → 横向插值修补。
- 运动物体：前后帧邻域变化（运动门控 + 持续度门控）→ 跳过，仅记录 `skipped-motion`。
- 可疑竖线：长时参考中仍存在的竖线（可能是画面内容）→ 锁定为内容，列入 `lockedLines`，永不修补。
- 画面固有竖线：全序列稳定存在 → 静默锁定，不进修补集。

运动物体穿过划痕时，交叉行被侧翼一致性检查排除，不会吃掉运动边缘。
序列边界帧使用单侧邻帧做运动门控。修补种子为确定性 PRNG，
同一输入必得同一输出，便于复查。

## Node CLI

```bash
node src/node/cli.ts --in frames/ --out out/ --name RIVER_ASH_R2_04 \
  --fps 24 --strength 0.78 --grain 0.96 \
  --disable 12,40-45 --manual-dir manual/
```

- `--disable`：逐帧关闭修复（原样输出，manifest 标记 `disabled`）。
- `--manual-dir`：人工修过的帧（文件名含帧号，如 `f0014.png`），
  替换管线输出并记入 `manual-frames/` 与 manifest。

输出（交付目录）：

```
out/
  sequence/<name>_repaired_F0001.png…   修复序列
  masks/F0007_mask.png…                 修补掩膜（白=修补像素）
  mask-manifest.json                    每帧每掩膜：类型/置信度/时序判定/颗粒统计
  manual-frames/                        人工帧 + edit-log.json
  README.txt                            交付说明
```

## 浏览器应用

```bash
node tools/build-web.mjs   # 用 Node 原生类型擦除构建 web/dist
node tools/serve.mjs 8080  # 打开 http://localhost:8080
```

功能：载入帧序列或视频 → 运行修复 → 修复后/原始/遮罩叠加预览 →
逐帧开关修复、标记并导入人工帧 → 导出 PNG 序列 zip、mask-manifest.json、
WebM（WebCodecs 编码 + 内置 EBML 封装，经 MediaSource 页面内回放校验；
播放走 WebAudio 时钟）。

## 测试

```bash
node test/synth.ts
```

合成已知真值的受损序列（尘、毛发、瞬时划痕、可疑竖线、运动物体、颗粒），
端到端跑 CLI 并断言 15 项：修补质量、颗粒不被磨平、内容线/运动物体零误伤、
改动严格限于掩膜、禁用帧原样、人工帧应用与记录、manifest 完整性。

## 目录

- `src/core/` 平台无关核心：时序分析、缺陷分类、修补、颗粒、manifest、zip
- `src/node/` Node 端：纯 zlib 的 PNG 编解码、CLI
- `web/` 浏览器应用（TS 源码 + 构建产物 dist/）
- `tools/` 构建与静态服务脚本
- `test/` 合成数据端到端测试

注意：管线将整段序列载入内存（约 8 MB/帧 @1600x1200）。长片请按镜头分段处理，
与交付惯例（如 F0080—0175 段）一致。
