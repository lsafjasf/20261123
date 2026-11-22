import { Biquad, highshelf, highpass,                   } from './biquad.js';

// BS.1770 K-weighting, bilinear-matched coefficients at 48 kHz are
// standard; here we derive close approximations per sample rate from the
// RBJ cookbook (shelf +4 dB @ ~1.68 kHz, high-pass @ 38 Hz).
function kWeightingFilters(fs        )                 {
  return [highshelf(fs, 1680, 4.0, 0.7), highpass(fs, 38, 0.5)];
}

                                 
                         
                                                          
                                                       
                            
                                                                           
 

export function measureLoudness(input              , fs        )                 {
  const filters = kWeightingFilters(fs).map((c) => new Biquad(c));
  const weighted = new Float32Array(input.length);
  filters[0].processBlock(input, weighted);
  for (let i = 1; i < filters.length; i++) filters[i].processBlock(weighted, weighted);

  const blockLen = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  const stLen = Math.round(3.0 * fs);
  const blockE           = [];
  for (let start = 0; start + blockLen <= weighted.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + blockLen; i++) sum += weighted[i] * weighted[i];
    blockE.push(sum / blockLen);
  }

  const toLufs = (e        ) => -0.691 + 10 * Math.log10(Math.max(e, 1e-12));

  // Integrated with absolute (-70 LUFS) and relative (-10 LU) gating.
  const absGate = blockE.filter((e) => toLufs(e) > -70);
  let integrated = -Infinity;
  if (absGate.length > 0) {
    const mean = absGate.reduce((a, b) => a + b, 0) / absGate.length;
    const relThresh = toLufs(mean) - 10;
    const relGate = absGate.filter((e) => toLufs(e) > relThresh);
    if (relGate.length > 0) {
      integrated = toLufs(relGate.reduce((a, b) => a + b, 0) / relGate.length);
    }
  }

  const momentary = new Float32Array(blockE.length);
  for (let i = 0; i < blockE.length; i++) momentary[i] = toLufs(blockE[i]);

  const stBlocks = Math.max(1, Math.round(stLen / hop));
  const shortTerm = new Float32Array(blockE.length);
  let peakSt = -Infinity;
  const stValues           = [];
  for (let i = 0; i < blockE.length; i++) {
    const from = Math.max(0, i - stBlocks + 1);
    let sum = 0;
    for (let j = from; j <= i; j++) sum += blockE[j];
    const st = toLufs(sum / (i - from + 1));
    shortTerm[i] = st;
    if (i - from + 1 >= stBlocks) {
      stValues.push(st);
      if (st > peakSt) peakSt = st;
    }
  }

  stValues.sort((a, b) => a - b);
  const pct = (p        ) =>
    stValues.length ? stValues[Math.min(stValues.length - 1, Math.floor(p * stValues.length))] : -Infinity;
  const lra = stValues.length ? pct(0.95) - pct(0.1) : 0;

  return { integratedLufs: integrated, momentary, shortTerm, peakLufsShortTerm: peakSt, lra };
}
