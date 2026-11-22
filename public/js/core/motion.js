import { downsampleLuma } from "./color.js";
             
                        
            
              
            
                    

                       
                  
                
 

                        
                
                 
 

function buildPyramid(frame           )                {
  const levels                = [{ luma: frame, scale: 1 }];
  let current = frame;
  while (
    levels.length < 4 &&
    current.width >= 64 &&
    current.height >= 48
  ) {
    current = downsampleLuma(current);
    levels.push({ luma: current, scale: frame.width / current.width });
  }
  return levels;
}

function createField(width        , height        , blockSize        )              {
  const cols = Math.max(1, Math.ceil(width / blockSize));
  const rows = Math.max(1, Math.ceil(height / blockSize));
  return {
    width,
    height,
    blockSize,
    cols,
    rows,
    vx: new Float32Array(cols * rows),
    vy: new Float32Array(cols * rows),
    cost: new Float32Array(cols * rows)
  };
}

function blockSad(
  source            ,
  sourceWidth        ,
  sourceHeight        ,
  target            ,
  x0        ,
  y0        ,
  blockSize        ,
  dx        ,
  dy        ,
  cutoff        
)         {
  const step = blockSize >= 12 ? 2 : 1;
  let cost = 0;
  let samples = 0;

  for (let y = y0; y < Math.min(y0 + blockSize, sourceHeight); y += step) {
    const targetY = y + dy;
    if (targetY < 0 || targetY >= sourceHeight) return Number.POSITIVE_INFINITY;
    for (let x = x0; x < Math.min(x0 + blockSize, sourceWidth); x += step) {
      const targetX = x + dx;
      if (targetX < 0 || targetX >= sourceWidth) return Number.POSITIVE_INFINITY;
      const difference = source[y * sourceWidth + x] - target[targetY * sourceWidth + targetX];
      cost += difference < 0 ? -difference : difference;
      samples += 1;
      if (cost > cutoff) return cost;
    }
  }

  return samples === 0 ? Number.POSITIVE_INFINITY : cost / samples;
}

function guidedSearch(
  source           ,
  target           ,
  blockSize        ,
  radius        ,
  prior                    
)              {
  const field = createField(source.width, source.height, blockSize);
  const sourceData = source.data;
  const targetData = target.data;

  for (let row = 0; row < field.rows; row += 1) {
    for (let column = 0; column < field.cols; column += 1) {
      const cell = row * field.cols + column;
      const x0 = column * blockSize;
      const y0 = row * blockSize;
      let centerX = 0;
      let centerY = 0;

      if (prior) {
        const priorColumn = Math.min(
          prior.cols - 1,
          Math.floor((x0 + blockSize * 0.5) * prior.cols / source.width)
        );
        const priorRow = Math.min(
          prior.rows - 1,
          Math.floor((y0 + blockSize * 0.5) * prior.rows / source.height)
        );
        const priorCell = priorRow * prior.cols + priorColumn;
        const scaleX = source.width / prior.width;
        const scaleY = source.height / prior.height;
        centerX = Math.round(prior.vx[priorCell] * scaleX);
        centerY = Math.round(prior.vy[priorCell] * scaleY);
      }

      let bestX = centerX;
      let bestY = centerY;
      let bestCost = blockSad(
        sourceData,
        source.width,
        source.height,
        targetData,
        x0,
        y0,
        blockSize,
        centerX,
        centerY,
        Number.POSITIVE_INFINITY
      );
      const motionPenalty = radius <= 3 ? 0.18 : 0.08;

      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const candidateX = centerX + dx;
          const candidateY = centerY + dy;
          const cutoff = bestCost + motionPenalty * (Math.abs(dx) + Math.abs(dy));
          const sad = blockSad(
            sourceData,
            source.width,
            source.height,
            targetData,
            x0,
            y0,
            blockSize,
            candidateX,
            candidateY,
            cutoff
          );
          const score = sad + motionPenalty * (Math.abs(dx) + Math.abs(dy));
          if (score < bestCost + motionPenalty * (Math.abs(bestX - centerX) + Math.abs(bestY - centerY))) {
            bestCost = sad;
            bestX = candidateX;
            bestY = candidateY;
          }
        }
      }

      field.vx[cell] = bestX;
      field.vy[cell] = bestY;
      field.cost[cell] = Number.isFinite(bestCost) ? bestCost : 255;
    }
  }

  smoothField(field);
  return field;
}

function smoothField(field             )       {
  const vxCopy = field.vx.slice();
  const vyCopy = field.vy.slice();
  for (let row = 0; row < field.rows; row += 1) {
    for (let column = 0; column < field.cols; column += 1) {
      const cell = row * field.cols + column;
      if (field.cost[cell] > 42) continue;
      const xValues           = [];
      const yValues           = [];
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = column + ox;
          const ny = row + oy;
          if (nx < 0 || ny < 0 || nx >= field.cols || ny >= field.rows) continue;
          const neighbor = ny * field.cols + nx;
          if (field.cost[neighbor] > 54) continue;
          xValues.push(vxCopy[neighbor]);
          yValues.push(vyCopy[neighbor]);
        }
      }
      if (xValues.length < 5) continue;
      xValues.sort((a, b) => a - b);
      yValues.sort((a, b) => a - b);
      const middle = xValues.length >> 1;
      field.vx[cell] = xValues[middle];
      field.vy[cell] = yValues[middle];
    }
  }
}

function estimateDirection(
  source           ,
  target           ,
  settings                       
)              {
  const levels = buildPyramid(source);
  const reverseLevels = buildPyramid(target);
  const finestBlockSize = settings.blockSize;
  let prior                     = null;

  for (let levelIndex = levels.length - 1; levelIndex >= 0; levelIndex -= 1) {
    const level = levels[levelIndex];
    const targetLevel = reverseLevels[Math.min(levelIndex, reverseLevels.length - 1)];
    const blockSize = Math.max(4, Math.round(finestBlockSize / level.scale));
    const scaleRatio = level.luma.width / source.width;
    const radius = prior
      ? 2
      : Math.max(2, Math.min(8, Math.ceil(settings.maxDisplacement * scaleRatio)));
    prior = guidedSearch(
      level.luma,
      targetLevel.luma,
      blockSize,
      radius,
      prior
    );
  }

  if (!prior || prior.width !== source.width || prior.height !== source.height) {
    return createField(source.width, source.height, finestBlockSize);
  }
  return prior;
}

export function estimatePairMotion(
  source           ,
  target           ,
  settings                       
)             {
  if (source.width !== target.width || source.height !== target.height) {
    throw new Error("Frames must have identical dimensions");
  }
  const start = performance.now();
  const forward = estimateDirection(source, target, settings);
  const backward = estimateDirection(target, source, settings);
  return {
    forward,
    backward,
    estimateMs: performance.now() - start
  };
}

export function sampleMotion(
  field             ,
  x        ,
  y        
)                                           {
  const result = { vx: 0, vy: 0, cost: 0 };
  readMotion(field, x, y, result);
  return result;
}

export function readMotion(
  field             ,
  x        ,
  y        ,
  output                                          
)       {
  const gx = Math.max(0, Math.min(field.cols - 1, x / field.blockSize - 0.5));
  const gy = Math.max(0, Math.min(field.rows - 1, y / field.blockSize - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(field.cols - 1, x0 + 1);
  const y1 = Math.min(field.rows - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const i00 = y0 * field.cols + x0;
  const i10 = y0 * field.cols + x1;
  const i01 = y1 * field.cols + x0;
  const i11 = y1 * field.cols + x1;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  output.vx =
    field.vx[i00] * w00 +
    field.vx[i10] * w10 +
    field.vx[i01] * w01 +
    field.vx[i11] * w11;
  output.vy =
    field.vy[i00] * w00 +
    field.vy[i10] * w10 +
    field.vy[i01] * w01 +
    field.vy[i11] * w11;
  output.cost =
    field.cost[i00] * w00 +
    field.cost[i10] * w10 +
    field.cost[i01] * w01 +
    field.cost[i11] * w11;
}

export function sampleLuma(
  frame           ,
  x        ,
  y        
)               {
  const result = { value: 0, valid: false };
  readLuma(frame, x, y, result);
  return result;
}

export function readLuma(
  frame           ,
  x        ,
  y        ,
  output              
)       {
  if (x < 0 || y < 0 || x > frame.width - 1 || y > frame.height - 1) {
    output.value = 0;
    output.valid = false;
    return;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(frame.width - 1, x0 + 1);
  const y1 = Math.min(frame.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const data = frame.data;
  const width = frame.width;
  output.value =
    data[y0 * width + x0] * (1 - fx) * (1 - fy) +
    data[y0 * width + x1] * fx * (1 - fy) +
    data[y1 * width + x0] * (1 - fx) * fy +
    data[y1 * width + x1] * fx * fy;
  output.valid = true;
}

export function sampleRgba(
  frame                                                            ,
  x        ,
  y        ,
  output              
)          {
  if (x < 0 || y < 0 || x > frame.width - 1 || y > frame.height - 1) return false;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(frame.width - 1, x0 + 1);
  const y1 = Math.min(frame.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const width = frame.width;
  const data = frame.data;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  for (let channel = 0; channel < 4; channel += 1) {
    output[channel] =
      data[i00 + channel] * w00 +
      data[i10 + channel] * w10 +
      data[i01 + channel] * w01 +
      data[i11 + channel] * w11;
  }
  return true;
}
