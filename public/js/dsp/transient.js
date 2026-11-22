import { linToDb } from './dynamics.js';

                        
                
                       
                      
                         
                        
                 
 

                                      
               
                     
                     
                    
                        
                       
                       
                  
 

function fastEnvelope(x              , fs        )               {
  const atk = Math.exp(-1 / (0.001 * fs));
  const rel = Math.exp(-1 / (0.02 * fs));
  const env = new Float32Array(x.length);
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    e = a > e ? atk * e + (1 - atk) * a : rel * e + (1 - rel) * a;
    env[i] = e;
  }
  return env;
}

function rmsDb(x              )         {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return linToDb(Math.sqrt(sum / Math.max(1, x.length)));
}

function peakDb(x              )         {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return linToDb(p);
}

function windowRmsDb(x              , from        , to        )         {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return linToDb(Math.sqrt(sum / Math.max(1, to - from)));
}

// Detect onsets from the pre-process band, then measure how much of each
// onset's impact (short-window RMS) survives processing. Peak levels are
// reported too (signals must be time-aligned).
export function analyzeTransients(
  band        ,
  before              ,
  after              ,
  fs        ,
)                      {
  const env = fastEnvelope(before, fs);
  const minGap = Math.round(0.05 * fs);
  const window = Math.round(0.015 * fs);
  const floorDb = -60;

  const onsets          = [];
  let lastOnset = -minGap;
  for (let i = 1; i < env.length - 1; i++) {
    if (i - lastOnset < minGap) continue;
    const rise = linToDb(env[i]) - linToDb(env[i - 1]);
    if (rise < 1.5 || env[i] < Math.pow(10, floorDb / 20)) continue;
    if (env[i] < env[i + 1] && rise < 3) continue; // still rising slowly
    const from = Math.max(0, i - Math.round(0.005 * fs));
    const to = Math.min(before.length, i + window);
    let pb = 0;
    let pa = 0;
    for (let j = from; j < to; j++) {
      pb = Math.max(pb, Math.abs(before[j]));
      pa = Math.max(pa, Math.abs(after[j]));
    }
    const peakDbBefore = linToDb(pb);
    const peakDbAfter = linToDb(pa);
    const impactDbBefore = windowRmsDb(before, i, to);
    const impactDbAfter = windowRmsDb(after, i, to);
    onsets.push({
      index: i,
      peakDbBefore,
      peakDbAfter,
      impactDbBefore,
      impactDbAfter,
      lossDb: impactDbBefore - impactDbAfter,
    });
    lastOnset = i;
  }

  const losses = onsets.map((o) => o.lossDb);
  const meanLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const maxLoss = losses.length ? Math.max(...losses) : 0;
  const crestBefore = peakDb(before) - rmsDb(before);
  const crestAfter = peakDb(after) - rmsDb(after);

  return {
    band,
    onsetCount: onsets.length,
    meanLossDb: meanLoss,
    maxLossDb: maxLoss,
    crestBeforeDb: crestBefore,
    crestAfterDb: crestAfter,
    crestDeltaDb: crestBefore - crestAfter,
    onsets,
  };
}
