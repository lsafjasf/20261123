// 帧级检测器：每个检测器是若干“原子条件”的合取。
// 改阈值时的增量重算靠原子条件的单调性：
// 若某帧在所有变化条件上的判定都没变，则合取结果必然不变，
// 因此只需重算“判定可能翻转”的候选窗口。
import { fromDb, toDb } from './dsp.js';
                                                            

                                                                        

                                                                 

                
                      
                    
                                                
                                                     
 

// 阈值键 -> 实际比较值（dB 键需要转线性）
function resolve(atom      , th            )         {
  if (atom.thKey === null) return atom.value ?? 0;
  const v = th[atom.thKey];
  if (atom.thKey === 'silenceDb' || atom.thKey === 'noiseMinDb' || atom.thKey === 'musicMinDb') {
    return fromDb(v);
  }
  return v;
}

function featureValue(f               , i        , key            )         {
  switch (key) {
    case 'rmsDb': return f.rms[i];        // 与 fromDb 后的门限比较，直接用线性 RMS
    case 'maxJump': return f.maxJump[i];
    case 'flatness': return f.flatness[i];
    case 'clipCount': return f.clipCount[i];
  }
}

function atomHit(atom      , th            , f               , i        )          {
  const v = featureValue(f, i, atom.feature);
  const t = resolve(atom, th);
  return atom.op === 'gte' ? v >= t : v <= t;
}

export const DETECTORS                                        = {
  silence: { atoms: [{ feature: 'rmsDb', op: 'lte', thKey: 'silenceDb' }] },
  pop:     { atoms: [{ feature: 'maxJump', op: 'gte', thKey: 'popJump' }] },
  clip:    { atoms: [{ feature: 'clipCount', op: 'gte', thKey: null, value: 2 }] },
  noise:   { atoms: [
    { feature: 'flatness', op: 'gte', thKey: 'noiseFlatness' },
    { feature: 'rmsDb', op: 'gte', thKey: 'noiseMinDb' },
  ] },
  music:   { atoms: [
    { feature: 'flatness', op: 'lte', thKey: 'musicFlatness' },
    { feature: 'rmsDb', op: 'gte', thKey: 'musicMinDb' },
  ] },
};

// 每个检测器关联的阈值键（用于判断阈值变化影响哪些检测器）
export function detectorThresholdKeys(id            )                       {
  return DETECTORS[id].atoms
    .map(a => a.thKey)
    .filter((k)                        => k !== null);
}

                             
                   
                                      
 

// 计算/增量更新某检测器的逐帧掩码。
// prevMask/prevTh 提供时，只重算判定可能翻转的候选窗口。
export function evalMask(
  id            ,
  f               ,
  th            ,
  prevMask                    = null,
  prevTh                    = null,
  changedKeys                               = null,
)             {
  const def = DETECTORS[id];
  const n = f.count;
  const mask = prevMask ? prevMask.slice() : new Uint8Array(n);

  // 无历史或缺信息：全量计算
  if (!prevMask || !prevTh || !changedKeys) {
    for (let i = 0; i < n; i++) {
      mask[i] = def.atoms.every(a => atomHit(a, th, f, i)) ? 1 : 0;
    }
    return { mask, evaluated: n };
  }

  // 候选窗口：在任一“发生变化的原子条件”上，新旧阈值判定不同的帧。
  // 条件判定不变 => 合取结果不变 => 无需重算。
  const changedAtoms = def.atoms.filter(
    a => a.thKey !== null && changedKeys.has(a.thKey),
  );
  if (changedAtoms.length === 0) return { mask, evaluated: 0 };

  let evaluated = 0;
  for (let i = 0; i < n; i++) {
    let maybeFlipped = false;
    for (const a of changedAtoms) {
      if (atomHit(a, th, f, i) !== atomHit(a, prevTh, f, i)) {
        maybeFlipped = true;
        break;
      }
    }
    if (!maybeFlipped) continue;
    evaluated++;
    mask[i] = def.atoms.every(a => atomHit(a, th, f, i)) ? 1 : 0;
  }
  return { mask, evaluated };
}

export function rmsDbOf(f               , i        )         {
  return toDb(f.rms[i]);
}
