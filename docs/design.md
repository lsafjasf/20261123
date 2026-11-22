# 设计说明

## 1. 为什么核心管线不用 WebCodecs / WebAudio / MediaSource

需求的硬约束是“重新拼回去与原始样本完全一致”。WAV 内是未压缩整数 PCM，
拆分本质上只是按字节偏移复制 `data` chunk 的子区间，不涉及任何编解码：

- WebCodecs 的 `AudioDecoder`/`AudioEncoder` 面向压缩编解码，对 PCM 的支持
  依赖实现，且可能改变容器/封装，无法用来证明样本逐字节不变。
- WebAudio 的 `decodeAudioData` 输出浮点 `AudioBuffer`，8/16/24-bit 整数 PCM
  会经过量化转换，仅适合试听，不适合无损拆分。
- MediaSource 面向流式容器播放，不提供样本级随机切片能力。
- Canvas 与音频样本处理无关。

因此核心管线只用 `node:fs`、`node:crypto` 等标准库做字节级流式复制与哈希；
`src/cdcue/preview.ts` 在检测到浏览器环境时，才用 WebAudio + Canvas 做
波形/试听预览，并明确标注“不参与无损管线”。本 Node 构建没有全局
WebCodecs/WebAudio，该模块不会被 CLI 加载。

## 2. 时间轴与区域划分

CD 时间码 `MM:SS:FF` 以 1/75 秒为一帧。索引转样本：

```
sample = cdFrame * sampleRate / 75
```

要求 `sampleRate` 能被 75 整除，否则一个 CD 帧无法对应整数个样本，直接报
`CUE_INDEX_INVALID`。44.1 kHz、48 kHz、96 kHz 等常见抓轨采样率都满足。

区域按“曲目”而不是“每个索引”切分：

1. 第一首曲目最早索引之前的样本构成 `hidden-leadin`（HTOA）。
2. 每首曲目从它最早的索引开始（有 `INDEX 00` 就是 pregap 起点，否则
   `INDEX 01`），结束于下一曲最早索引；最后一曲到文件末尾。
3. `INDEX 02+` 不切文件，只作为曲内标记写入 manifest 和 `split.cue`。
4. 所有区域长度之和必须等于源 WAV 的总样本数，否则直接报错，杜绝漏样本。

`PREGAP`/`POSTGAP` 指令表示要合成源 WAV 中不存在的静音，无法做到字节精确，
因此显式拒绝并提示改用内嵌的 `INDEX 00`。

## 3. 偏移修正语义

偏移只加到“索引标记”上，物理边界样本 0 与 `frameCount` 固定：

- 负偏移把边界向文件头移动：受限于第一个索引不能小于 0。
- 正偏移把边界向文件尾移动：受限于最后一个索引必须小于文件长度。
- 修正后要求所有边界严格递增、曲目区域非零长度，否则报错。
- 因为物理首尾不动、区域仍是 `[0, N)` 的一个划分，输出 PCM 拼接后天然
   覆盖且仅覆盖源数据区一次，这是字节精确的结构性保证，而不是“尽量像”。

## 4. WAV 处理

- 仅接受小端 RIFF/RF64 + WAVE + PCM（format 1；WAVE_FORMAT_EXTENSIBLE
  时读取 sub-format）。拒绝 RIFX 大端、压缩格式、8/16/24/32-bit 之外的位深。
- 校验 `blockAlign == channels * bitsPerSample/8` 与 `byteRate` 一致性，
  data 长度必须是 blockAlign 的整数倍，拒绝半帧尾部。
- RF64 通过 `ds64` chunk 取 64 位 data 长度；单个输出 WAV 超过约 4 GiB
  （RIFF 32 位尺寸上限）时报 `IO_ERROR`，不静默截断。
- 复制以固定大小块（默认 4096 帧）流式进行，内存占用与文件大小无关。

## 5. 校验与哈希

- 拆分时维护一个 SHA-256，按写入顺序喂入所有输出的真实 PCM 字节（不是
  “哈希的哈希”），同时对源 WAV data 区独立算一次哈希，两者必须相等。
- `verify` 不信任拆分过程：重新解析每个输出 WAV 的头部、帧数和格式，
  逐文件比对 manifest 记录的 SHA-256，再流式拼接出重组哈希与源哈希比对；
  任一输出被改动都会失败。源文件缺失时退化为只验证输出间一致性并说明。

## 6. 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/cdcue/cue.ts` | CUE 词法/语法解析、MSF 换算、曲目与索引校验 |
| `src/cdcue/wav.ts` | RIFF/RF64 解析、fmt/data 校验、截断检测 |
| `src/cdcue/planner.ts` | 索引→样本、偏移修正、区域划分与边界校验 |
| `src/cdcue/writer.ts` | WAV 头写入、流式字节复制、区间哈希 |
| `src/cdcue/splitter.ts` | 拆分编排、manifest 与 split.cue 生成 |
| `src/cdcue/verifier.ts` | 独立重解析 + 流式重组哈希校验 |
| `src/cdcue/cli.ts` | `split`/`verify`/`inspect` 命令与错误码退出 |
| `src/cdcue/preview.ts` | 可选浏览器 WebAudio/Canvas 预览（非无损路径） |
