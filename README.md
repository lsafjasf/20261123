# MP4 粗剪（尽量不重编码）

纯本地运行的采访 MP4 粗剪工具：标记删除区间、拼接待保留段，**能不重编码就不重编码**。
不连接云服务，零第三方依赖 —— 只有 TypeScript + Node.js 标准库 + 浏览器原生
WebCodecs / WebAudio / Canvas / MediaSource 级能力。

## 运行

```bash
node build.mjs        # 用 Node 内置 stripTypeScriptTypes 把 src/ 编译到 public/js/
node server.ts 8080   # 打开 http://localhost:8080
```

测试：

```bash
node test/roundtrip.ts                 # 合成 MP4 全链路单元测试
node test/e2e-real.ts in.mp4 out.mp4   # 真实文件端到端（可配合 ffprobe 校验）
```

## 使用流程

1. 打开 MP4（H.264 + AAC）。时间轴上灰色刻度是关键帧。
2. 源片模式下单击时间轴定位，用「在此刻开始/结束删除区」标记删除区间。
3. 「生成剪辑方案」进入成片模式：
   - **非关键帧切点**会逐段标黄，必须显式选择「吸附到上一/下一关键帧」（无损）
     或「转码该段」（WebCodecs 仅重编码该段视频，音频仍无损拷贝）。
     吸附到上一关键帧的候选不会越过上一保留段结尾（避免内容重叠）。
   - 片尾不足一帧的残帧会被丢弃并在段备注中明示。
   - 方案面板实时显示**最终时长**、**是否真正无损**、音画最大累计偏差。
4. 所有切点确认前「生成文件」不可用；点击后还需二次确认才生成。
   导出文件自动下载，并可同时保存到服务器 `exports/`。

## 技术要点

- **无损切割**：直接拷贝样本（H.264 access unit / AAC frame），重写
  stts/ctts/stss/stsc/co64/stsz 样本表；B 帧重排由 ctts（必要时 v1 负偏移）保留；
  首帧 CTS 偏移与 AAC priming 用 elst 校正，展示起点归零。
- **多段拼接的音画时间基准**：视频（如 15360）与音频（如 44100）各自在自己的
  时间基上取整，采用逐段累计漂移反馈（Bresenham 式）决定每段音频帧数，
  拼接处累计偏差收敛在半个 AAC 帧（≈11.6ms）以内，方案面板可见。
- **转码段**：WebCodecs 解码自前一个关键帧、精确重编码 [start, end)，
  新 avcC 作为第二个 stsd 条目写入（按 desc-run 分 chunk），与无损段混排。
- **预览**：WebCodecs 解码 → Canvas 渲染，WebAudio 作主时钟保证音画同步；
  预览即最终拼接结果（输出时间轴）。

## 已知限制

- 视频仅支持 H.264（avc1/avc3），音频仅支持 AAC（mp4a）；其他编码会在加载时报错。
- 无损切点必须在关键帧（闭合 GOP 假设）；开放式 GOP 的源请选转码。
- 字幕/章节等附加轨道不拷贝。
