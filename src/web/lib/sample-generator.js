// WebCodecs + Canvas 程序化样本生成：
// 合成黑场/静止/抖动/硬切/叠化画面 → VideoEncoder 编码 → VideoDecoder 解码 →
// 复用 FrameMetricExtractor 跑真实采集管线，验证检测引擎对误判场景的覆盖。

export function supportsWebCodecs() {
  return (
    typeof globalThis.VideoEncoder === 'function' &&
    typeof globalThis.VideoDecoder === 'function' &&
    typeof globalThis.VideoFrame === 'function'
  );
}

const SCENARIOS = [
  { name: '黑场+单帧闪白', kind: 'black' },
  { name: '近黑欠曝正常画面', kind: 'near-black' },
  { name: '真静止长镜', kind: 'freeze' },
  { name: '极缓慢运镜', kind: 'slow-drift' },
  { name: '手持抖动', kind: 'shake' },
  { name: '平滑横移', kind: 'pan' },
  { name: '硬切', kind: 'hard-cut' },
  { name: '叠化软切', kind: 'dissolve' },
];

export async function runSampleLab(canvas, extractorFactory, frameCount, onLog) {
  if (!supportsWebCodecs()) throw new Error('当前浏览器不支持 WebCodecs');
  const codec = await pickSupportedCodec();
  const width = 320;
  const height = 180;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const results = [];
  for (const scenario of SCENARIOS) {
    const frames = await roundTrip(scenario, context, width, height, frameCount, onLog, codec);
    const extractor = extractorFactory(canvas);
    const metrics = frames.map((frame, index) => {
      const metric = extractor.computeFromFrame(frame, index / 30, 0);
      frame.close();
      return metric;
    });
    results.push({ scenario: scenario.name, kind: scenario.kind, metrics });
  }
  return results;
}

async function roundTrip(scenario, context, width, height, frameCount, onLog, codec) {
  const chunks = [];
  const encoder = new VideoEncoder({
    output: (chunk) => chunks.push(chunk),
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({
    codec: pickCodec(),
    width,
    height,
    bitrate: 2_000_000,
    framerate: 30,
  });
  for (let index = 0; index < frameCount; index += 1) {
    paintScenario(context, scenario, index, width, height);
    const frame = new VideoFrame(canvas, { timestamp: index * (1e6 / 30) });
    encoder.encode(frame, { keyFrame: index === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();

  const decoded = [];
  const decoder = new VideoDecoder({
    output: (frame) => decoded.push(frame),
    error: (error) => {
      throw error;
    },
  });
  decoder.configure({ codec, codedWidth: width, codedHeight: height });
  for (const chunk of chunks) decoder.decode(chunk);
  await decoder.flush();
  decoder.close();
  onLog?.(`${scenario.name}: 编码 ${chunks.length} 块 / 解码 ${decoded.length} 帧`);
  return decoded;
}

async function pickSupportedCodec() {
  const candidates = ['avc1.42001E', 'avc1.640028', 'vp8', 'vp09.00.10.08'];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec, width: 320, height: 180 });
      if (support?.supported) return codec;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return candidates[0];
}

function paintScenario(context, scenario, index, width, height) {
  switch (scenario.kind) {
    case 'black':
      if (index === Math.floor(30)) {
        context.fillStyle = '#fff';
      } else {
        context.fillStyle = '#050505';
      }
      context.fillRect(0, 0, width, height);
      break;
    case 'near-black':
      context.fillStyle = `rgb(${18 + (index % 5)},${18 + (index % 5)},${18 + (index % 5)})`;
      context.fillRect(0, 0, width, height);
      break;
    case 'freeze':
      context.fillStyle = '#2a6fb0';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#e8e8e8';
      context.fillRect(40, 30, 80, 60);
      break;
    case 'slow-drift':
      context.fillStyle = '#222';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#79c';
      context.fillRect(index * 0.4, 60, 50, 50);
      break;
    case 'shake': {
      const jitter = (index % 2 === 0 ? 1 : -1) * 6;
      context.fillStyle = '#333';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#c66';
      context.fillRect(120 + jitter, 70 - jitter, 60, 60);
      break;
    }
    case 'pan':
      context.fillStyle = '#333';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#6c6';
      context.fillRect(index * 1.5 % width, 60, 60, 60);
      break;
    case 'hard-cut':
      context.fillStyle = index % 40 < 20 ? '#446' : '#664';
      context.fillRect(0, 0, width, height);
      break;
    case 'dissolve': {
      const phase = (index % 60) / 60;
      const shade = Math.round(40 + Math.sin(phase * Math.PI) * 160);
      context.fillStyle = `rgb(${shade},${shade},${255 - shade})`;
      context.fillRect(0, 0, width, height);
      break;
    }
  }
}
