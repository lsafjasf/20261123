# 急救分支训练台

完全本地运行的急救培训分支视频工作台。项目使用 TypeScript、Node.js 标准库和浏览器原生 WebCodecs / WebAudio / Canvas / MediaSource，运行时没有第三方依赖。

## 运行

要求 Node.js 22.18+，并使用支持 H.264 MSE、WebCodecs 与 WebAudio 的浏览器（Chrome / Edge 推荐）。

```bash
npm start
```

打开 `http://localhost:4173`。`npm start` 会先用 Node 内置的 TypeScript 类型剥离功能构建浏览器模块，再启动静态服务。

```bash
npm test    # 分支状态机、门禁和清单往返测试
npm run check
```

## 已实现

- 主时间线由有序片段组成，决策可定义选项出现区间、暂停点、问题文案。
- 每个选项可独立设置目标片段、播放结束点和绝对回主线位置。
- 正确分支播完回到配置的主线位置继续播放。
- 错误分支播完或点击「回到决策点」都会停在原决策点，可重新选择。
- 决策暂停前预加载所有分支目标与回主线片段；任一失败即锁定选项并安全停止。
- 播放跳转带请求序号，晚到的旧定位请求不能覆盖当前片段。
- 媒体通过 MediaSource 装载，Canvas 每帧使用 WebCodecs `VideoFrame` 绘制，音频经 WebAudio 时钟输出并由音频时钟监测漂移。
- 清单实时保存到 `localStorage`，同时镜像到 `data/saved-manifest.json`；刷新页面优先完整恢复本地清单。
- 支持导入、导出 JSON 清单，以及一键载入内置演示。

## 时间线操作

- 点击主片段或标尺区域可定位预览。
- 决策区间在「选项」轨中显示，拖拽两端改变出现区间，拖拽中段整体平移。
- 左侧检查器可精确修改毫秒值、目标片段和回主线位置。
- 修改后自动保存；按空格播放/暂停。

## 数据约定

完整示例见 `data/demo-manifest.json`。关键约束：

- `timelineStartMs` / `timelineEndMs` 是选项在主时间线上的绝对出现区间。
- `pauseAtMs` 必须位于选项区间内，播放到这里会暂停等待选择。
- 选项的 `targetSegmentId` 指向分支片段，`targetEndMs` 是分支播放终点。
- `returnToMs` 是分支结束后的主时间线绝对位置；错误分支通常设为决策点。
- 所有 ID 与片段引用在播放前都会校验，未就绪的目标不会被装载。

## 目录

```text
src/core/       清单模型、校验、纯函数状态机与预加载门禁
src/client/     时间线编辑、清单持久化、MSE/WebCodecs/WebAudio 预览
server/         Node 标准库 HTTP 服务、Range 请求和本地清单镜像
public/         页面、样式、编译后模块与本地演示视频
data/           演示清单
tests/          无依赖 Node 测试
```

演示视频已随项目提供。若需重新生成，可运行 `scripts/generate-demo.sh`；该辅助脚本需要系统安装 ffmpeg 与 ImageMagick，不属于应用运行时依赖。
