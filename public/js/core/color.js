                                                       

export function rgbaToLuma(frame           )            {
  const { width, height, data } = frame;
  const luma = new Uint8Array(width * height);
  for (let index = 0, pixel = 0; pixel < luma.length; pixel += 1, index += 4) {
    luma[pixel] = (data[index] * 77 + data[index + 1] * 150 + data[index + 2] * 29) >> 8;
  }
  return { width, height, data: luma };
}

export function downsampleLuma(frame           )            {
  const width = Math.max(1, frame.width >> 1);
  const height = Math.max(1, frame.height >> 1);
  const data = new Uint8Array(width * height);
  const source = frame.data;
  const sourceWidth = frame.width;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.min(frame.height - 1, y * 2);
    const y1 = Math.min(frame.height - 1, y0 + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.min(frame.width - 1, x * 2);
      const x1 = Math.min(frame.width - 1, x0 + 1);
      const sum =
        source[y0 * sourceWidth + x0] +
        source[y0 * sourceWidth + x1] +
        source[y1 * sourceWidth + x0] +
        source[y1 * sourceWidth + x1];
      data[y * width + x] = (sum + 2) >> 2;
    }
  }

  return { width, height, data };
}

export function clampByte(value        )         {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export function clamp01(value        )         {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
