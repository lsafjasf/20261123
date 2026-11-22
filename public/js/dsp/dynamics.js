export function dbToLin(db        )         {
  return Math.pow(10, db / 20);
}

export function linToDb(x        )         {
  return 20 * Math.log10(Math.max(x, 1e-9));
}

                                   
                      
                
                   
                    
                 
                   
                             
                                    
 

export const DEFAULT_BAND_SETTINGS                   = {
  thresholdDb: -18,
  ratio: 2.5,
  attackMs: 8,
  releaseMs: 120,
  kneeDb: 6,
  makeupDb: 0,
  maxGainReductionDb: 18,
  transientPreserve: 0.5,
};

function timeCoef(ms        , fs        )         {
  return Math.exp(-1 / (Math.max(0.01, ms) * 0.001 * fs));
}

function staticGainDb(levelDb        , s                  )         {
  const t = s.thresholdDb;
  const k = s.kneeDb;
  const r = Math.max(1, s.ratio);
  const slope = 1 / r - 1; // <= 0
  if (k > 0 && levelDb > t - k / 2 && levelDb < t + k / 2) {
    const x = levelDb - t + k / 2;
    return slope * (x * x) / (2 * k);
  }
  return levelDb > t ? slope * (levelDb - t) : 0;
}

                                    
                       
                                                                  
                                                              
 

export function processBand(
  input              ,
  fs        ,
  s                  ,
)                    {
  const n = input.length;
  const output = new Float32Array(n);
  const gainDbOut = new Float32Array(n);
  const envDbOut = new Float32Array(n);

  const atk = timeCoef(s.attackMs, fs);
  const rel = timeCoef(s.releaseMs, fs);
  const fastAtk = timeCoef(0.5, fs);
  const fastRel = timeCoef(5, fs);
  const slowAtk = timeCoef(20, fs);
  const slowRel = timeCoef(150, fs);

  let env = 0;
  let fastEnv = 0;
  let slowEnv = 0;
  let smoothGrDb = 0;

  for (let i = 0; i < n; i++) {
    const a = Math.abs(input[i]);
    env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
    fastEnv = a > fastEnv ? fastAtk * fastEnv + (1 - fastAtk) * a : fastRel * fastEnv + (1 - fastRel) * a;
    slowEnv = a > slowEnv ? slowAtk * slowEnv + (1 - slowAtk) * a : slowRel * slowEnv + (1 - slowRel) * a;

    const levelDb = linToDb(env);
    let targetGr = staticGainDb(levelDb, s);
    targetGr = Math.max(targetGr, -Math.abs(s.maxGainReductionDb));

    // Transient preservation: when the fast envelope pokes above the slow
    // one, scale the gain reduction back so attacks keep their edge.
    const crestDb = linToDb(fastEnv) - linToDb(slowEnv);
    const transientness = Math.min(1, Math.max(0, crestDb / 12));
    targetGr *= 1 - s.transientPreserve * transientness;

    smoothGrDb = targetGr < smoothGrDb
      ? atk * smoothGrDb + (1 - atk) * targetGr
      : rel * smoothGrDb + (1 - rel) * targetGr;

    const totalDb = smoothGrDb + s.makeupDb;
    gainDbOut[i] = totalDb;
    envDbOut[i] = levelDb;
    output[i] = input[i] * dbToLin(totalDb);
  }
  return { output, gainDb: gainDbOut, envDb: envDbOut };
}
