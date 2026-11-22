                                           

export function clamp(value        , min        , max        )         {
  return Math.max(min, Math.min(max, value));
}

export function mixToMono(audio          )               {
  const length = audio.channels[0]?.length || 0;
  const mixed = new Float32Array(length);
  if (audio.channels.length === 0) return mixed;
  const scale = 1 / audio.channels.length;
  for (const channel of audio.channels) {
    for (let i = 0; i < length; i++) mixed[i] += channel[i] * scale;
  }
  return mixed;
}

export function percentile(values              , fraction        )         {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[clamp(Math.floor(sorted.length * fraction), 0, sorted.length - 1)];
}

export function rms(samples              , start        , length        )         {
  const begin = clamp(start, 0, samples.length);
  const end = clamp(start + length, begin, samples.length);
  if (end === begin) return 0;
  let energy = 0;
  for (let i = begin; i < end; i++) energy += samples[i] * samples[i];
  return Math.sqrt(energy / (end - begin));
}

export function peak(samples              , start        , length        )         {
  const begin = clamp(start, 0, samples.length);
  const end = clamp(start + length, begin, samples.length);
  let value = 0;
  for (let i = begin; i < end; i++) value = Math.max(value, Math.abs(samples[i]));
  return value;
}

export function stepSize(samples              , index        )         {
  if (index <= 0 || index >= samples.length) return 0;
  return Math.abs(samples[index] - samples[index - 1]);
}

function localSteps(samples              , center        , radius        )               {
  const start = Math.max(1, center - radius);
  const end = Math.min(samples.length, center + radius);
  const values = new Float32Array(Math.max(0, end - start));
  for (let i = start; i < end; i++) values[i - start] = stepSize(samples, i);
  return values;
}

function highFrequencyEnergy(samples              , center        , radius        )         {
  const start = Math.max(2, center - radius);
  const end = Math.min(samples.length, center + radius);
  if (end <= start) return 0;
  let energy = 0;
  for (let i = start; i < end; i++) {
    const second = samples[i] - 2 * samples[i - 1] + samples[i - 2];
    energy += second * second;
  }
  return Math.sqrt(energy / (end - start));
}

export function environmentStep(samples              , center        , radius        )         {
  const values = localSteps(samples, center, radius);
  const typical = percentile(values, 0.75);
  const loudest = percentile(values, 0.99);
  return Math.max(typical, loudest * 0.22, 1e-7);
}

export function seamSnapshot(samples              , boundary        ) {
  const before = Math.max(1, boundary - 1);
  const leftLast = samples[before] ?? 0;
  const rightFirst = samples[boundary] ?? 0;
  const step = Math.abs(rightFirst - leftLast);
  const localStep = environmentStep(samples, boundary, 96);
  const beforeHf = highFrequencyEnergy(samples, before, 48);
  const afterHf = highFrequencyEnergy(samples, boundary, 48);
  const hfRatio = step / Math.max((beforeHf + afterHf) * 0.5, 1e-7);
  return {
    leftLast,
    rightFirst,
    step,
    localStep,
    stepRatio: step / localStep,
    hfRatio,
    peak: Math.max(Math.abs(leftLast), Math.abs(rightFirst))
  };
}

                                 
                
              
                     
                    
                         
                          
 

export function activeEnvelope(audio          )                 {
  const mono = mixToMono(audio);
  const sampleRate = audio.sampleRate;
  const window = Math.max(16, Math.round(sampleRate * 0.005));
  const head = Array.from({ length: 12 }, (_, i) => rms(mono, i * window, window));
  const tail = Array.from({ length: 12 }, (_, i) => rms(mono, mono.length - (i + 1) * window, window));
  const quiet = [...head, ...tail].sort((a, b) => a - b);
  const noiseFloor = quiet[Math.floor(quiet.length * 0.35)] || 0;
  const body = Array.from({ length: Math.min(200, Math.floor(mono.length / window)) }, (_, i) =>
    rms(mono, i * window, window)
  );
  const loud = body.sort((a, b) => a - b)[Math.floor(body.length * 0.9)] || 0;
  const threshold = Math.max(noiseFloor * 3.5, loud * 0.035, 4e-4);
  let start = 0;
  let end = mono.length;
  for (let i = 0; i < mono.length; i += window) {
    if (rms(mono, i, window) > threshold) {
      start = Math.max(0, i - window * 2);
      break;
    }
  }
  for (let i = mono.length - window; i >= 0; i -= window) {
    if (rms(mono, i, window) > threshold) {
      end = Math.min(mono.length, i + window * 3);
      break;
    }
  }
  return {
    start,
    end,
    noiseFloor,
    threshold,
    leadingSilence: start,
    trailingSilence: mono.length - end
  };
}

export function concatenate(parts                  , channelCount        )                 {
  const total = parts.reduce((sum, channels) => sum + (channels[0]?.length || 0), 0);
  const result = Array.from({ length: channelCount }, () => new Float32Array(total));
  let cursor = 0;
  for (const channels of parts) {
    const length = channels[0]?.length || 0;
    for (let channel = 0; channel < channelCount; channel++) {
      result[channel].set(channels[channel] || new Float32Array(length), cursor);
    }
    cursor += length;
  }
  return result;
}


//# sourceURL=dsp.ts