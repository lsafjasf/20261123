# vidpriv — 手机录像公开发布前的隐私清理

按类别清理手机录像里的拍摄地点、设备型号、聊天软件缩略图和旧剪辑记录，
**只改容器、不重编码音视频码流**，并用采样段 SHA-256 哈希证明码流未变；
同名旁路文件只提示不处理；无法确认安全的内容保留并给出建议，绝不静默删除。

技术栈严格限定为 TypeScript、Node.js 标准库，以及浏览器的
WebCodecs / WebAudio / Canvas / MediaSource / SubtleCrypto。
**无任何第三方 npm 包、无云服务、无网络请求。**

## 工作原理

### 1. 容器解析与分类
- 解析 ISO-BMFF / QuickTime 容器（`ftyp/moov/udta/meta/ilst/keys/uuid/...`），
  支持普通盒、`uuid` 盒、64 位 largesize 盒。
- 把隐私项映射到四个类别，每项带 `confirmed`（确认）或 `review`（待确认）置信度，
  以及删除风险等级：
  - `container-only`：仅容器元数据，删除不影响码流与时序，可自动处理。
  - `container-nonstandard`：厂商私有/非标准盒，默认保留待人工确认。
  - `breaks-timing`：如 `elst` 编辑时间轴，删除会改变播放时序，**永远不自动删除**。
- 识别 Adobe XMP（uuid `be7acfcb…`）内部的 GPS、设备、编辑历史字段；
  C2PA 内容凭证（uuid `d8fec3d6…`）因涉及来源证明，标记为待确认。

### 2. 仅容器改写（不重编码）
- 每个被删盒在**原字节位置**替换成等长的 `free` 盒，文件总长度不变。
- 因为其它字节位置完全不动，`stco/co64` 块偏移、采样表、`mdat` 负载全部保持原样，
  从机制上保证音视频码流字节不变。
- `free` 盒负载清零，避免被删文本残留在空闲区可被恢复。

### 3. 采样段哈希证明
- 解析每条轨道的 `stsc/stsz(stz2)/stco(co64)`，还原每个编码采样的绝对字节区间。
- 对每条轨道计算“所有采样字节拼接”的 SHA-256，并对每个 `mdat` 负载计算 SHA-256；
  可选 `--per-sample` 输出逐采样哈希。
- 清洗前后两份清单对比；`verify` 子命令可对任意文件复核哈希，码流被改动即判定不一致。

### 4. 旁路文件提示
扫描同目录同名词干的 `.xmp`、Takeout `.json`、AppleDouble `._*`、`.aae`、
缩略图（`.thm/.jpg/...`）、字幕/轨迹/日志等，**仅报告风险，不读取修改或删除**。

### 5. 浏览器独立验证
`node src/server.ts` 启动本地静态服务，浏览器页面用另一套独立实现
（SubtleCrypto 重算采样/mdat 哈希、WebCodecs 解码抽帧 + Canvas 帧指纹、
WebAudio 解码 PCM 指纹、MediaSource 容器探针）核对 Node 端结果，文件不离开本机。

## 环境要求

- Node.js >= 22.6（用内置 TypeScript type-stripping 直接运行 `.ts`，无需编译、无需依赖）。

## 命令用法

```bash
# 1) 体检：列出四类隐私项、置信度、风险、预览，以及同名旁路文件
node src/cli.ts inspect demo/phone-recording.mp4

# 2) 按类别清理（可多选），默认只删 confirmed 且仅容器安全的项目
node src/cli.ts clean demo/phone-recording.mp4 \
  --location --device --chat-thumbnail --edit-history \
  --output demo/out.mp4 --manifest demo/out.hash.json

# 等价的简写：--categories=a 全选；--categories=location,device 多选
# 追加 --include-review 可同时删除“待确认”且不破坏时序的项（elst 仍永不自动删）
# 追加 --per-sample 在清单里写入逐采样 SHA-256

# 3) 复核：用清单验证某个文件的码流是否仍与清洗时一致
node src/cli.ts verify demo/out.mp4 --manifest demo/out.hash.json

# 4) 浏览器独立验证页（WebCodecs/WebAudio/Canvas/MediaSource）
node src/server.ts   # 打开 http://localhost:8731/web/index.html

# 测试（Node 内置 test runner）
npm test
```

不带类别参数且在终端交互环境下，`clean` 会弹出按类别选择的菜单。

## 输出与产物

- 清洗后的视频（默认 `<原名>.cleaned.<扩展名>`，可用 `--output` 指定）。
- `*.hash.json` 哈希清单：清洗前后的文件级、`mdat` 级、每轨道采样级 SHA-256。
- 终端/JSON 报告：已删项、保留的待确认项、旁路文件告警、多类别盒整体删除提示。

## 安全边界（重要）

- **不静默处理**：所有 `review` 项、`breaks-timing` 项默认保留并在报告中说明原因；
  没有 `--include-review` 不会删除任何待确认项。
- **`elst` 编辑时间轴永不自动删除**：它承载裁剪/时间轴改动，删除会改变播放时序；
  工具只报告并建议在专业剪辑软件中处理。
- **多类别盒整体删除**：一个 XMP `uuid` 盒可能同时含定位、设备、历史，
  删除任一类会按盒整体移除，报告里会明确提示其它类别数据一并消失。
- **旁路文件不自动动**：`.xmp/.json/._*/.aae/缩略图` 等需要你人工决定是否删除。
- **容器外信息超出范围**：烧录在画面里的字幕/水印、像素或音频里的隐写水印，
  不属于容器元数据，工具会在报告中提示但无法在不重编码的前提下处理。
- 浏览器端遇到手机厂商私有编码配置导致 WebCodecs 无法解码时，会明确说明
  “码流哈希结论仍有效”，不夸大为验证失败。

## 目录结构

```
src/        Node 端：容器解析、分类、仅容器重写、采样哈希、CLI、本地服务
web/        浏览器端独立验证（WebCodecs/WebAudio/Canvas/MediaSource）
test/       合成 MP4 夹具与端到端/安全测试（零依赖）
demo/       合成示例视频与清洗产物
```
