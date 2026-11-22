                                                     

                                
                    
                    
               
 

                              
                      
                     
                       
                     
 

let sharedContext                      = null;

export function audioContext()               {
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

async function resumeContext()                {
  const context = audioContext();
  if (context.state === "running") return;
  const timeout = new Promise      ((resolve) =>
    window.setTimeout(resolve, 90),
  );
  await Promise.race([context.resume().catch(() => undefined), timeout]);
}

export function downmix(buffer             )               {
  const output = new Float32Array(buffer.length);
  const scale = 1 / buffer.numberOfChannels;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) output[i] += data[i] * scale;
  }
  return output;
}

export async function downmixAsync(
  buffer             ,
  onProgress                          ,
)                        {
  const output = new Float32Array(buffer.length);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const scale = 1 / Math.max(1, channels.length);
  const chunk = 1_000_000;
  for (let start = 0; start < output.length; start += chunk) {
    const end = Math.min(output.length, start + chunk);
    for (let i = start; i < end; i++) {
      let value = 0;
      for (const data of channels) value += data[i];
      output[i] = value * scale;
    }
    onProgress?.(end / Math.max(1, output.length));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return output;
}

export function computePeaks(
  samples              ,
  sampleRate        ,
  rate = 60,
)                {
  const bins = Math.max(1, Math.ceil((samples.length / sampleRate) * rate));
  const perBin = samples.length / bins;
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    const from = Math.floor(bin * perBin);
    const to = Math.min(samples.length, Math.ceil((bin + 1) * perBin));
    let low = 0;
    let high = 0;
    for (let i = from; i < to; i++) {
      const value = samples[i];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    min[bin] = low;
    max[bin] = high;
  }
  return { min, max, rate };
}

export async function prepareMonoAndPeaks(
  buffer             ,
  onProgress                          ,
  peaksPerSecond = 60,
)                                                        {
  const mono = new Float32Array(buffer.length);
  const bins = Math.max(
    1,
    Math.ceil(buffer.duration * peaksPerSecond),
  );
  const perBin = buffer.length / bins;
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const scale = 1 / Math.max(1, channels.length);
  let lastProgress = -1;
  for (let bin = 0; bin < bins; bin++) {
    const from = Math.floor(bin * perBin);
    const to = Math.min(buffer.length, Math.ceil((bin + 1) * perBin));
    let low = 0;
    let high = 0;
    for (let i = from; i < to; i++) {
      let value = 0;
      for (const data of channels) value += data[i];
      value *= scale;
      mono[i] = value;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    min[bin] = low;
    max[bin] = high;
    const progress = Math.floor((bin / bins) * 10);
    if (progress !== lastProgress) {
      lastProgress = progress;
      onProgress?.(bin / Math.max(1, bins));
      if (bin % 256 === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }
  return { mono, peaks: { min, max, rate: peaksPerSecond } };
}

export async function loadAudioFile(
  file      ,
  onStatus                            ,
)                       {
  onStatus?.("正在解码音频…");
  const context = audioContext();
  const bytes = await file.arrayBuffer();
  const buffer = await context.decodeAudioData(bytes);
  onStatus?.("正在建立波形索引…");
  const prepared = await prepareMonoAndPeaks(buffer, (value) => {
    onStatus?.(`正在建立波形索引… ${Math.round(value * 100)}%`);
  });
  return {
    buffer,
    mono: prepared.mono,
    peaks: prepared.peaks,
    waveformMs: 0,
  };
}

function midiToFrequency(midi        )         {
  return 440 * 2 ** ((midi - 69) / 12);
}

                        
                
                  
                  
                    
                  
                
               
 

function seededRandom(seed        )               {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function renderVocal(
  output              ,
  rate        ,
  options              ,
)       {
  const random = seededRandom(options.seed);
  let phase = 0;
  const startSample = Math.floor(options.start * rate);
  const totalSamples = Math.floor(options.notes.length * options.noteSec * rate);
  let noteIndex = 0;
  let previousMidi = options.notes[0] + options.transpose;

  for (let offset = 0; offset < totalSamples; offset++) {
    const absolute = startSample + offset;
    if (absolute >= output.length) break;
    const time = offset / rate;
    const targetIndex = Math.min(
      options.notes.length - 1,
      Math.floor(time / options.noteSec),
    );
    if (targetIndex !== noteIndex) {
      noteIndex = targetIndex;
      previousMidi = options.notes[Math.max(0, noteIndex - 1)] + options.transpose;
    }
    const noteTime = time - noteIndex * options.noteSec;
    const target = options.notes[noteIndex] + options.transpose;
    const glide = Math.min(1, noteTime / 0.055);
    const baseMidi = previousMidi + (target - previousMidi) * glide;
    const drift =
      options.drift * Math.sin(time * 0.61 + options.seed * 0.01) +
      options.drift * 0.35 * Math.sin(time * 1.73);
    const vibrato =
      options.vibrato *
      Math.sin(2 * Math.PI * 5.1 * time + options.seed) *
      Math.min(1, noteTime / 0.16);
    const midi = baseMidi + drift + vibrato;
    phase += (2 * Math.PI * midiToFrequency(midi)) / rate;
    const attack = Math.min(1, noteTime / 0.035);
    const release = Math.min(1, (options.noteSec - noteTime) / 0.09);
    const envelope = Math.max(0, Math.min(attack, release));
    const breath = (random() - 0.5) * 0.026;
    const sample =
      Math.sin(phase) * 0.46 +
      Math.sin(phase * 2.01) * 0.2 +
      Math.sin(phase * 3.02) * 0.105 +
      Math.sin(phase * 4.01) * 0.06 +
      Math.sin(phase * 5.03) * 0.035 +
      breath;
    output[absolute] += sample * envelope * 0.3;
  }
}

export function createDemoAudio()   
                      
                     
                       
                      
  {
  const rate = 22050;
  const duration = 104;
  const mono = new Float32Array(rate * duration);
  const melody = [
    60, 62, 64, 67, 64, 62, 60, 59, 60, 64, 67, 69, 67, 64, 62, 60,
  ];
  const answer = [
    72, 71, 69, 67, 65, 64, 62, 60, 59, 57, 55, 53, 55, 57, 59, 60,
  ];

  renderVocal(mono, rate, {
    start: 8,
    notes: melody,
    noteSec: 0.47,
    transpose: 0,
    vibrato: 0.11,
    drift: 0.03,
    seed: 11,
  });
  renderVocal(mono, rate, {
    start: 27,
    notes: answer,
    noteSec: 0.41,
    transpose: 0,
    vibrato: 0.07,
    drift: 0.02,
    seed: 71,
  });
  renderVocal(mono, rate, {
    start: 48,
    notes: melody,
    noteSec: 0.51,
    transpose: 1,
    vibrato: 0.18,
    drift: 0.06,
    seed: 29,
  });
  renderVocal(mono, rate, {
    start: 86,
    notes: melody,
    noteSec: 0.455,
    transpose: 0.5,
    vibrato: 0.09,
    drift: 0.04,
    seed: 53,
  });

  const random = seededRandom(991);
  const noiseFrom = Math.floor(70 * rate);
  const noiseTo = Math.floor(74 * rate);
  for (let i = noiseFrom; i < noiseTo; i++) {
    mono[i] += (random() - 0.5) * 0.21;
  }
  let peak = 0;
  for (const sample of mono) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) {
    const gain = 0.86 / peak;
    for (let i = 0; i < mono.length; i++) mono[i] *= gain;
  }
  const buffer = new AudioBuffer({
    length: mono.length,
    numberOfChannels: 1,
    sampleRate: rate,
  });
  buffer.copyToChannel(mono, 0);
  return {
    buffer,
    mono,
    peaks: computePeaks(mono, rate),
    description: "104 秒 · 3 个相似 take · 1 段干扰旋律 · 1 段宽带噪声",
  };
}

                               
                
              
 

                            
                
                
                
              
 

export class PlaybackEngine {
          buffer                     = null;
          sources                          = [];
          master                  = null;
          endTimer = 0;
          state                   = null;
          onEnd                      = null;

  setBuffer(buffer             )       {
    this.stop();
    this.buffer = buffer;
  }

  get reel()                   {
    return this.state;
  }

          scheduleClip(
    clip              ,
    when        ,
    fade = 0.025,
  )                               {
    if (!this.buffer || !this.master) return null;
    const source = audioContext().createBufferSource();
    source.buffer = this.buffer;
    const gain = audioContext().createGain();
    const duration = Math.max(0.01, clip.end - clip.start);
    const now = audioContext().currentTime;
    const fadeInEnd = Math.max(now + 0.001, when + fade);
    const fadeOutStart = Math.max(fadeInEnd + 0.001, when + duration - fade);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(1, fadeInEnd);
    gain.gain.setValueAtTime(1, fadeOutStart);
    gain.gain.linearRampToValueAtTime(0.0001, when + duration);
    source.connect(gain).connect(this.master);
    source.start(when, clip.start, duration);
    this.sources.push(source);
    return source;
  }

  async playClip(clip              , onEnd             )                {
    if (!this.buffer) return;
    this.stop();
    await resumeContext();
    this.ensureMaster();
    this.scheduleClip(clip, audioContext().currentTime + 0.04);
    this.state = { index: 0, total: 1, start: clip.start, end: clip.end };
    const duration = clip.end - clip.start;
    this.endTimer = window.setTimeout(() => {
      this.state = null;
      onEnd?.();
    }, duration * 1000 + 90);
  }

  async playReel(
    clips                ,
    onEnd             ,
    onClip                             ,
  )                {
    if (!this.buffer || !clips.length) return;
    this.stop();
    await resumeContext();
    this.ensureMaster();
    let cursor = audioContext().currentTime + 0.05;
    clips.forEach((clip, index) => {
      const duration = clip.end - clip.start;
      const source = this.scheduleClip(clip, cursor);
      const state = { index, total: clips.length, start: clip.start, end: clip.end };
      if (source) {
        source.onended = () => {
          if (this.state?.index === index && index === clips.length - 1) {
            this.state = null;
            onEnd?.();
          }
        };
      }
      window.setTimeout(() => {
        if (this.state) {
          this.state = state;
          onClip?.(state);
        }
      }, Math.max(0, (cursor - audioContext().currentTime) * 1000));
      cursor += duration + 0.18;
    });
    this.state = {
      index: 0,
      total: clips.length,
      start: clips[0].start,
      end: clips[0].end,
    };
    onClip?.(this.state);
    this.onEnd = onEnd ?? null;
  }

  stop()       {
    window.clearTimeout(this.endTimer);
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
      source.disconnect();
    }
    this.sources = [];
    this.state = null;
    this.onEnd = null;
    if (this.master) {
      this.master.gain.cancelScheduledValues(audioContext().currentTime);
      this.master.gain.setValueAtTime(1, audioContext().currentTime);
    }
  }

          ensureMaster()       {
    if (!this.master) {
      this.master = audioContext().createGain();
      this.master.connect(audioContext().destination);
    }
  }
}

export function confirmedClips(groups              )                 {
  return groups
    .filter((group) => group.status === "confirmed")
    .flatMap((group) =>
      group.occurrences.map((occurrence) => ({
        start: occurrence.start,
        end: occurrence.end,
      })),
    )
    .sort((a, b) => a.start - b.start);
}

export function encodeWav(buffer             )              {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const output = new ArrayBuffer(44 + frames * channels * bytesPerSample);
  const view = new DataView(output);
  const writeString = (offset        , value        ) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, output.byteLength - 8, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, frames * channels * bytesPerSample, true);
  const channelData = Array.from({ length: channels }, (_, index) =>
    buffer.getChannelData(index),
  );
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return output;
}
