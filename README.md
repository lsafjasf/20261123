# cutline-migrator

旧版剪辑工程（整数毫秒时间线）→ 新格式（帧 / 采样精度时间线）的本地迁移工具。
TypeScript + Node.js 标准库实现，**零第三方依赖**（Node ≥ 22.6，利用原生
TypeScript 类型擦除直接运行 `.ts`）；浏览器端验证器使用 WebCodecs /
WebAudio / Canvas / MediaSource。

## 迁移保证

- **切点可追溯**：每条镜头携带 `provenance`，记录每个切点的旧版毫秒值、
  换算后的帧/采样值、是否精确、带符号误差（`src/migrate/convert.ts`）。
- **无法精确表达的单列**：所有发生舍入的切点进入报告的 `approximate` 清单；
  `--exact` 模式下任何非精确切点直接把该镜头送入隔离清单。
- **总时长容差一致**：始终换算**绝对时间线位置**而非时长，舍入误差不累积，
  总漂移 ≤ 半帧 + 半采样；`verify` 命令独立重算复核（`src/migrate/verify.ts`）。
- **坏镜头隔离**：单条镜头的数据错误（越界源区间、非法变速、转场超出重叠等）
  只进入 `quarantined` 清单并保留原始数据，其余镜头照常迁移。
- **增量迁移**：`.migrate/state.json` 按镜头内容哈希缓存结果，未变更的镜头
  直接复用；带转场的镜头会把前一条镜头纳入哈希，邻接编辑会正确失效。
- **回滚**：每次覆盖输出前自动备份到 `.migrate/backups/<runId>/`，
  `rollback` 恢复最近一次（或指定）备份，回滚本身也可逆，全程记录
  `journal.jsonl`。

## 用法

```sh
node src/cli.ts migrate examples/legacy-project.json --out out
node src/cli.ts migrate examples/legacy-project.json --out out   # 增量：只重算变更镜头
node src/cli.ts verify  examples/legacy-project.json --out out   # 独立复核
node src/cli.ts status  --out out                                # 查看备份
node src/cli.ts rollback --out out                               # 回滚到上一版
node src/cli.ts rollback --out out --run-id <runId>              # 回滚到指定版本
```

选项：`--exact`（非精确切点即隔离）、`--tolerance-ms N`（自定义总时长容差）、
`--no-incremental`（全量重算）。

## 浏览器验证器

```sh
node web/serve.ts --out out --port 8080   # 打开 http://localhost:8080
```

Canvas 绘制时间线；WebAudio 对音频媒体做采样级时长抽查；WebCodecs /
MediaSource 探测解码能力。`.ts` 由服务器用 Node 内置类型擦除即时转换。

## 时间模型

- 所有换算走 `src/core/rational.ts` 的 bigint 有理数运算，
  30000/1001 这类帧率与 2.5x 这类变速比都精确表达。
- 视频轨道以帧为单位（项目帧率），音频轨道以采样为单位
  （镜头自带采样率，缺省用项目采样率）。
- 变速段：源时长（精确有理数）÷ 速率 = 时间线时长，逐段累计精确值、
  每个边界只舍入一次，段边界误差记入追溯。
- 转场：时长换算到轨道单位后校验不超过与前一条镜头的重叠区间，
  超出即隔离该镜头。

## 测试

```sh
npm test    # node --test，26 个用例
```

## 目录

- `src/core/` 有理数与时间网格换算
- `src/legacy/` 旧版格式 schema 与结构校验
- `src/model/` 新版（v2）格式 schema
- `src/migrate/` 转换、引擎、增量状态、回滚、校验、报告
- `web/` 浏览器验证器与本地静态服务器
- `examples/legacy-project.json` 含多音轨、变速段、转场重叠和一条坏镜头的示例
