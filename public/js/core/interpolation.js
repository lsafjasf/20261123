import { clamp01 } from "./color.js";
import { estimatePairMotion, readLuma, readMotion, sampleRgba } from "./motion.js";
             
                      
                      
                        
            
             
           
                    

export const DEFAULT_REGION                      = {
  x: 0.22,
  y: 0.14,
  width: 0.56,
  height: 0.72,
  feather: 0.035,
  strength: 1,
  enabled: false
};

export const DEFAULT_SETTINGS                        = {
  blockSize: 8,
  maxDisplacement: 42,
  occlusionThreshold: 5.5,
  photoThreshold: 66,
  costThreshold: 76,
  region: { ...DEFAULT_REGION }
};

export function regionWeight(
  region                     ,
  x        ,
  y        ,
  width        ,
  height        
)         {
  if (!region.enabled) return 1;
  const left = region.x * width;
  const top = region.y * height;
  const right = (region.x + region.width) * width;
  const bottom = (region.y + region.height) * height;
  if (x < left || x > right || y < top || y > bottom) return 0;
  if (region.feather <= 0) return region.strength;
  const feather = Math.max(1, region.feather * Math.min(width, height));
  const distance = Math.min(x - left, right - x, y - top, bottom - y);
  return clamp01(distance / feather) * region.strength;
}

function markOcclusionEdges(mask            , width        , height        )             {
  const edges = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      const left = x > 0 ? mask[index - 1] : 0;
      const right = x < width - 1 ? mask[index + 1] : 0;
      const top = y > 0 ? mask[index - width] : 0;
      const bottom = y < height - 1 ? mask[index + width] : 0;
      if (!left || !right || !top || !bottom) edges[index] = 255;
    }
  }
  return edges;
}

export function interpolateFrame(
  source           ,
  target           ,
  phase        ,
  settings                        = DEFAULT_SETTINGS,
  motion             ,
  sourceLuma            ,
  targetLuma            
)                      {
  if (source.width !== target.width || source.height !== target.height) {
    throw new Error("Frames must have identical dimensions");
  }
  const { width, height } = source;
  const t = clamp01(phase);
  const pair = motion ?? estimatePairMotion(
    sourceLuma ?? lumaOf(source),
    targetLuma ?? lumaOf(target),
    settings
  );
  const aLuma = sourceLuma ?? lumaOf(source);
  const bLuma = targetLuma ?? lumaOf(target);
  const output = new Uint8ClampedArray(width * height * 4);
  const occlusion = new Uint8Array(width * height);
  const sampleA = new Float32Array(4);
  const sampleB = new Float32Array(4);
  const forward = { vx: 0, vy: 0, cost: 0 };
  const backward = { vx: 0, vy: 0, cost: 0 };
  const lumaA = { value: 0, valid: false };
  const lumaB = { value: 0, valid: false };
  let occludedPixels = 0;
  let confidenceSum = 0;
  let fbErrorSum = 0;
  let validCount = 0;
  const fbLimit = Math.max(0.5, settings.occlusionThreshold);
  const maxDisplacementSq = settings.maxDisplacement * settings.maxDisplacement;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      readMotion(pair.forward, x, y, forward);
      const ax = x - t * forward.vx;
      const ay = y - t * forward.vy;
      const bx = x + (1 - t) * forward.vx;
      const by = y + (1 - t) * forward.vy;
      readLuma(aLuma, ax, ay, lumaA);
      readLuma(bLuma, bx, by, lumaB);
      readMotion(pair.backward, bx, by, backward);

      const fbX = forward.vx + backward.vx;
      const fbY = forward.vy + backward.vy;
      const fbError = Math.sqrt(fbX * fbX + fbY * fbY);
      const photoError = Math.abs(lumaA.value - lumaB.value);
      const displacement = forward.vx * forward.vx + forward.vy * forward.vy;
      const unreliable =
        !lumaA.valid ||
        !lumaB.valid ||
        fbError > fbLimit ||
        photoError > settings.photoThreshold ||
        forward.cost > settings.costThreshold ||
        displacement > maxDisplacementSq;

      const aValid = sampleRgba(source, ax, ay, sampleA);
      const bValid = sampleRgba(target, bx, by, sampleB);
      let red = 0;
      let green = 0;
      let blue = 0;

      if (!aValid && !bValid) {
        const held = t < 0.5 ? source : target;
        const heldIndex = pixel * 4;
        red = held.data[heldIndex];
        green = held.data[heldIndex + 1];
        blue = held.data[heldIndex + 2];
        occlusion[pixel] = 255;
        occludedPixels += 1;
      } else if (unreliable || !aValid || !bValid) {
        const useSource = !bValid || (aValid && t < 0.5);
        const color = useSource ? sampleA : sampleB;
        if (useSource && aValid) {
          red = color[0];
          green = color[1];
          blue = color[2];
        } else if (bValid) {
          red = sampleB[0];
          green = sampleB[1];
          blue = sampleB[2];
        }
        occlusion[pixel] = 255;
        occludedPixels += 1;
      } else {
        red = sampleA[0] * (1 - t) + sampleB[0] * t;
        green = sampleA[1] * (1 - t) + sampleB[1] * t;
        blue = sampleA[2] * (1 - t) + sampleB[2] * t;
      }

      const weight = regionWeight(settings.region, x, y, width, height);
      if (weight < 1) {
        const held = t < 0.5 ? source : target;
        const heldIndex = pixel * 4;
        red = red * weight + held.data[heldIndex] * (1 - weight);
        green = green * weight + held.data[heldIndex + 1] * (1 - weight);
        blue = blue * weight + held.data[heldIndex + 2] * (1 - weight);
      }

      const outputIndex = pixel * 4;
      output[outputIndex] = red;
      output[outputIndex + 1] = green;
      output[outputIndex + 2] = blue;
      output[outputIndex + 3] = 255;

      const confidence = unreliable
        ? 0
        : clamp01(1 - fbError / Math.max(1, fbLimit)) *
          clamp01(1 - forward.cost / Math.max(1, settings.costThreshold));
      confidenceSum += confidence;
      if (lumaA.valid && lumaB.valid) {
        fbErrorSum += fbError;
        validCount += 1;
      }
    }
  }

  return {
    frame: { width, height, data: output },
    occlusionMask: occlusion,
    occlusionEdgeMask: markOcclusionEdges(occlusion, width, height),
    stats: {
      interpolatedPixels: width * height - occludedPixels,
      occludedPixels,
      averageConfidence: confidenceSum / Math.max(1, width * height),
      meanForwardBackwardError: fbErrorSum / Math.max(1, validCount)
    }
  };
}

function lumaOf(frame           )            {
  const data = new Uint8Array(frame.width * frame.height);
  for (let pixel = 0, index = 0; pixel < data.length; pixel += 1, index += 4) {
    data[pixel] =
      (frame.data[index] * 77 + frame.data[index + 1] * 150 + frame.data[index + 2] * 29) >> 8;
  }
  return { width: frame.width, height: frame.height, data };
}
