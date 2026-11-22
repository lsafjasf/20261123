// Canvas 帧指标提取：灰度均值、黑像素占比、帧间像素差、
// 16x16 块全搜索运动向量（幅度 + 方向无序度）。
// 纯确定性计算，不依赖任何第三方库；输出与后端 FrameMetric 契约一致。

const BLOCK = 16;
const SEARCH_RADIUS = 8;

export class FrameMetricExtractor {
  constructor(canvas, blackPixelLuma) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
    this.blackPixelLuma = blackPixelLuma;
    this.prevGray = null;
    this.index = 0;
  }

  /** 抽取当前 video 元素画面的一帧指标。 */
  capture(video, pts, audioRms) {
    const { videoWidth: width, videoHeight: height } = video;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.drawImage(video, 0, 0, width, height);
    const image = this.context.getImageData(0, 0, width, height);
    const gray = toGrayscale(image.data);
    const metric = this.compute(gray, width, height, pts, audioRms);
    this.prevGray = gray;
    this.index += 1;
    return metric;
  }

  /** 直接消费 WebCodecs VideoFrame（样本实验室使用同一条指标管线）。 */
  computeFromFrame(frame, pts, audioRms) {
    if (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight) {
      this.canvas.width = frame.codedWidth;
      this.canvas.height = frame.codedHeight;
    }
    this.context.drawImage(frame, 0, 0);
    const image = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const gray = toGrayscale(image.data);
    const metric = this.compute(gray, this.canvas.width, this.canvas.height, pts, audioRms);
    this.prevGray = gray;
    this.index += 1;
    return metric;
  }

  compute(gray, width, height, pts, audioRms) {
    let lumaSum = 0;
    let blackCount = 0;
    let diffSum = 0;
    for (let pixel = 0; pixel < gray.length; pixel += 1) {
      const value = gray[pixel];
      lumaSum += value;
      if (value < this.blackPixelLuma) blackCount += 1;
      if (this.prevGray) diffSum += Math.abs(value - this.prevGray[pixel]);
    }
    const pixelCount = gray.length;
    const vectors = this.prevGray
      ? blockMotion(this.prevGray, gray, width, height)
      : { magnitudes: [], angles: [] };
    const motion = average(vectors.magnitudes);
    const motionDisorder = directionDisorder(vectors.angles);
    const metric = {
      index: this.index,
      pts,
      meanLuma: lumaSum / pixelCount,
      blackRatio: blackCount / pixelCount,
      diff: this.prevGray ? diffSum / pixelCount : 0,
      motion,
      motionDisorder,
      audioRms,
    };
    return metric;
  }
}

function toGrayscale(rgba) {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    // BT.601 luma
    gray[j] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return gray;
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 对每个 16x16 块在邻域内做 SAD 全搜索，返回运动幅度与角度。 */
function blockMotion(prev, current, width, height) {
  const magnitudes = [];
  const angles = [];
  for (let by = 0; by + BLOCK <= height; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= width; bx += BLOCK) {
      let bestSad = Infinity;
      let bestDx = 0;
      let bestDy = 0;
      for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 1) {
        for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 1) {
          const sad = blockSad(prev, current, width, bx, by, dx, dy);
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }
      magnitudes.push(Math.hypot(bestDx, bestDy));
      if (bestDx !== 0 || bestDy !== 0) angles.push(Math.atan2(bestDy, bestDx));
    }
  }
  return { magnitudes, angles };
}

function blockSad(prev, current, width, bx, by, dx, dy) {
  const height = prev.length / width;
  let sad = 0;
  for (let y = 0; y < BLOCK; y += 1) {
    const prevRow = (by + y) * width;
    const curRow = (by + y + dy) * width;
    for (let x = 0; x < BLOCK; x += 1) {
      const px = bx + x + dx;
      const py = by + y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) return Infinity;
      sad += Math.abs(prev[prevRow + bx + x] - current[curRow + px]);
    }
  }
  return sad;
}

/** 方向无序度：把角度量化到 8 个方向，非主导方向块占比；平移时趋近 0，抖动时升高。 */
function directionDisorder(angles) {
  if (angles.length < 2) return 0;
  const bins = new Array(8).fill(0);
  for (const angle of angles) {
    const bin = Math.floor(((angle + Math.PI) / (Math.PI / 4)) % 8);
    bins[bin] += 1;
  }
  const dominant = Math.max(...bins);
  return 1 - dominant / angles.length;
}
