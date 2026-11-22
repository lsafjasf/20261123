# 设备迁移丢样与“啪”声的根因

## 故障模型

播放器把“播放位置”存成了某个 `AudioContext` 的时钟，而不是媒体源自己的样本游标。
常见写法是：

```ts
const position = oldContext.currentTime - startedAt;
const newContext = new AudioContext({ sampleRate: nextRate });
bufferSource.start(0, position);
```

这段代码在设备切换时有四个独立问题，任意一个都能造成用户看到的现象。

### 1. `currentTime` 属于上下文，不属于媒体

`AudioContext.currentTime` 的零点、单位和推进速度都由该上下文决定。新上下文
从 0 开始，旧上下文的秒数不能直接拿到新上下文继续使用。采样率变化后，同样的
秒数还会对应不同数量的小数源帧，直接用 `Math.floor(seconds * rate)` 会产生
一个到多个源样本的偏移。

本实现用约分后的 `Fraction` 保存**源样本帧位置**。设备采样率只影响
`sourceRate / deviceRate` 的步进，不改变 canonical position。

### 2. 旧图表的已调度尾部没有被原子截断

如果旧 `AudioBufferSourceNode` 已经排到未来 100 ms，切换时只创建新图表并
从“当前位置”重排，旧节点仍会继续播完。新图表又从同一位置播起，于是同一小段
被播放两次。反过来，如果先 `stop()` 再按过时时间重排，则会丢掉尾部。

本实现规定迁移必须先 `handoff()`：

1. 旧 worklet 继续生成到淡出结束；
2. 返回最后生成的源帧位置与输出帧数；
3. 旧上下文关闭；
4. 新 worklet 只从该位置 `open()`。

因此不存在两套图表同时消费同一源帧的窗口。

### 3. 声道布局变化时重新映射了错误的位置

单声道、立体声和其他布局的 `AudioBuffer`/worklet 输出通道数不同。若在重建
图表时把“已输出字节数”或“已播放 buffer 数”当作位置，声道数变化会再次引入
数量级错误。位置必须在源帧域计算，通道映射只改变样本复制/混合方式，不改变
游标。

### 4. 旧上下文的异步回调回写了新状态

设备切换、拖动和 `devicechange` 可能并发。旧 worklet 的进度消息如果晚于新
generation 到达，会把位置拉回旧值，视频随后追帧，看起来就是“慢半拍”或来回
抖动。

本实现给每一次 open/seek 分配 generation。迁移开始时旧 sink 不再拥有
`sinkGeneration`，迟到消息被丢弃；seek 也在源帧域立即切换 generation。

## “啪”声的直接原因

波形在非零幅值处被硬切断，或新图表从非零幅值突然开始，都会形成阶跃，听感上
就是 click。重叠旧尾部与新头部则会产生 comb/重复段，也常伴随爆音。

修复同时做两件事：

- 样本时间轴只交接一次，避免重复段；
- 旧 worklet 用 6 ms 线性淡出后才交出边界，新 worklet 从 0 增益线性淡入。

淡出期间源帧仍连续推进，所以淡入淡出不改变覆盖区间，也不会靠交叉淡化掩盖
丢样。

## 可恢复状态

`PlaybackController` 把用户意图和当前图表分开保存：

- `desiredPlaying`：用户想不想继续播；
- `position`：最后确认的源帧；
- `recoverable`：当前失败能否从 `position` 重建；
- `sinkGeneration`：防止旧图表回写。

暂停后切换只迁移位置，保持 `paused`。设备消失时关闭失效 sink，但保留位置和
`resumeIntent`；恢复时按原意图决定继续播放还是保持暂停。播放中拖动会让旧
generation 失效，新 generation 从目标帧重新开始。

## 不在单元测试内模拟的部分

自动化测试验证的是 renderer/controller 的样本覆盖区间，不会模拟 DAC、蓝牙
编码器或操作系统混音器的物理延迟。WebAudio 也无法保证跨设备切换的绝对零
静音；本实现保证的是源样本不丢、不重，并以短淡化避免硬切爆音。
