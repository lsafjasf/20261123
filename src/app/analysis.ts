// Decode + analysis pipeline: PCM → segmentation → alignment → metrics.
// Heavy work is chunked so the UI stays responsive.

import { segmentSentences } from "../shared/dsp.ts";
import { alignTakes } from "../shared/align.ts";
import { computeMetrics } from "../shared/metrics.ts";
import { state } from "./state.ts";
import { audioCtx } from "./player.ts";

export interface NamedAudio {
  name: string;
  data: ArrayBuffer;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function decodeAll(
  files: NamedAudio[],
  onProgress: (msg: string) => void,
): Promise<void> {
  const ac = audioCtx();
  state.takeNames = files.map((f) => f.name);
  state.pcm = [];
  for (let i = 0; i < files.length; i++) {
    onProgress(`解码 ${files[i].name} (${i + 1}/${files.length})`);
    const buf = await ac.decodeAudioData(files[i].data.slice(0));
    state.sampleRate = buf.sampleRate;
    // Mono mixdown.
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let k = 0; k < n; k++) mono[k] += ch[k] / buf.numberOfChannels;
    }
    state.pcm.push(mono);
    await tick();
  }
}

export async function analyze(onProgress: (msg: string) => void): Promise<void> {
  const n = state.pcm.length;
  state.segs = [];
  for (let t = 0; t < n; t++) {
    onProgress(`切句 ${state.takeNames[t]} (${t + 1}/${n})`);
    state.segs.push(segmentSentences(state.pcm[t], state.sampleRate));
    await tick();
  }
  onProgress("跨 take 对齐句子…");
  state.aligned = alignTakes(state.segs, state.refTake);
  await tick();
  onProgress("计算节奏 / 情绪 / 噪声底指标…");
  await tick();
  state.metrics = computeMetrics(state.pcm, state.sampleRate, state.segs, state.aligned, state.refTake);
  const nSent = state.segs[state.refTake].sentences.length;
  state.choices = Array.from({ length: nSent }, () => state.refTake);
  state.selectedSentence = 0;
  state.plan = null;
  state.compPcm = null;
}
