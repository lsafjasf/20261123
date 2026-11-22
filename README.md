# cdcue — 字节精确的整轨 WAV/CUE 拆分器

把一张老 CD 抓出来的整轨 PCM WAV（配 CUE 表）拆成单曲 WAV，完整保留
pregap、`INDEX 00/01/02…` 和隐藏前导（hidden lead-in / HTOA），支持读取
偏移修正，并在任何长度不足或索引异常时显式报错。所有单曲的 PCM 数据按序
重新拼接后与原始 WAV 的数据区逐字节一致（SHA-256 校验）。

仅使用 TypeScript + Node.js 标准库，无第三方依赖、无云服务。Node >= 22.6
可直接运行 `.ts`（类型擦除），本仓库在 Node 24 上开发验证。

## 命令

```bash
# 拆分（默认输出到 ./cdcue-out）
node src/cdcue/cli.ts split --cue image.cue --out out --force

# 只查看区域/索引规划，不写文件
node src/cdcue/cli.ts inspect --cue image.cue

# 独立校验：重新解析每个输出 WAV 并流式拼接比对哈希
node src/cdcue/cli.ts verify --manifest out/cdcue-manifest.json
```

## 偏移修正

`--offset` 只移动 CUE 索引边界，物理文件边界（样本 0 与文件末尾）固定不动，
因此无论怎么修正，全部输出拼回去仍是原来的全部样本：

- 裸数字按样本计：`--offset=-120`（负值用等号形式 `--offset=-120`）。
- `f`/`msf` 后缀按 CD 帧计（1 帧 = 1/75 秒），按当前采样率换算成样本：
  44.1 kHz 下 `--offset=+1f` 等于 `+588` 样本。
- 偏移后任何索引落到 `[0, 文件长度)` 之外、与其它边界重合或导致零长度曲目，
  都会以 `OFFSET_INVALID` / `LENGTH_INSUFFICIENT` 明确报错。

## 输出

- `00-hidden-leadin.wav`：仅当第一首曲目的首个索引之前存在样本时生成。
- `NN.wav`：每首曲目一个文件，从该曲最早的索引（有 `INDEX 00` 即 pregap
  起点，否则 `INDEX 01`）开始，到下一曲最早索引结束；曲内 `INDEX 02+`
  作为标记保留在 manifest 与 `split.cue` 中，不额外切文件。
- `split.cue`：每个输出 WAV 一条 `FILE`，索引为相对该文件的修正后 MSF。
- `cdcue-manifest.json`：源格式、偏移、每段起止样本、每段与整体 SHA-256。

## 错误码

所有可预期错误都抛出带稳定前缀的 `CdcueError`，CLI 以退出码 1 结束：

| 代码 | 含义 |
| --- | --- |
| `CUE_SYNTAX` | CUE 语法/引号/编号格式错误、缺 FILE 或 TRACK |
| `CUE_UNSUPPORTED` | 多 FILE、非 WAVE/非 AUDIO、`PREGAP/POSTGAP`（无法字节精确） |
| `CUE_INDEX_INVALID` | 缺 INDEX 01、索引非递增/不连续、采样率无法整样本对齐等 |
| `WAV_PARSE` | 非 RIFF/RF64、非 PCM、fmt 不一致、位深不支持等 |
| `WAV_TRUNCATED` | 声明长度超过实际文件、读取被截断 |
| `LENGTH_INSUFFICIENT` | 索引/偏移超出 WAV 长度，或重组字节/哈希不一致 |
| `OFFSET_INVALID` | 偏移非整数、把边界推出有效区间或造成零长度区域 |
| `IO_ERROR` | 文件读写失败、输出超过 4 GiB RIFF 限制 |

## 测试

```bash
node --test test/selftest.ts test/cli-e2e.ts
```

测试在临时目录合成已知 PCM，覆盖 pregap、隐藏前导、曲内索引、正负偏移、
截断 WAV、异常 CUE、非整除采样率，以及篡改输出后 verify 必须失败。

设计细节与浏览器 API 的取舍见 `docs/design.md`。
