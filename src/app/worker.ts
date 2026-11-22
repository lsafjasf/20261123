// Processing worker: runs the DSP off the main thread.
import { dereverb } from "../dsp/dereverb.ts";

export interface SegmentControl {
  startSec: number;
  endSec: number;
  strength: number; // 0..1
  bypass: boolean;
}

export interface ProcessRequest {
  samples: Float32Array;
  sampleRate: number;
  t60: number;
  segments: SegmentControl[];
  defaultStrength: number;
}

function strengthFn(req: ProcessRequest): (t: number) => number {
  const segs = req.segments;
  return (t: number): number => {
    for (const s of segs) {
      if (t >= s.startSec && t < s.endSec) {
        return s.bypass ? 0 : s.strength;
      }
    }
    return req.defaultStrength;
  };
}

self.onmessage = (ev: MessageEvent<ProcessRequest>) => {
  const req = ev.data;
  const result = dereverb(req.samples, {
    sampleRate: req.sampleRate,
    t60: req.t60,
    strength: strengthFn(req),
  });
  (self as unknown as Worker).postMessage(
    {
      output: result.output,
      residual: result.residual,
      gains: result.gains,
      frameSize: result.frameSize,
      hop: result.hop,
    },
    [result.output.buffer, result.residual.buffer],
  );
};
