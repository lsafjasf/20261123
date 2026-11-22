import { Biquad, lowpass, highpass } from './biquad.js';

const BUTTER_Q = Math.SQRT1_2;

function lr4Lowpass(fs        , fc        )           {
  return [new Biquad(lowpass(fs, fc, BUTTER_Q)), new Biquad(lowpass(fs, fc, BUTTER_Q))];
}

function lr4Highpass(fs        , fc        )           {
  return [new Biquad(highpass(fs, fc, BUTTER_Q)), new Biquad(highpass(fs, fc, BUTTER_Q))];
}

function runChain(chain          , input              , output              )       {
  chain[0].processBlock(input, output);
  for (let i = 1; i < chain.length; i++) chain[i].processBlock(output, output);
}

export class Crossover {
           bands        ;
           freqs          ;
          lows            ;
          highs            ;
          rest              ;

  constructor(fs        , freqs          , blockSize        ) {
    this.freqs = freqs;
    this.bands = freqs.length + 1;
    this.lows = freqs.map((f) => lr4Lowpass(fs, f));
    this.highs = freqs.map((f) => lr4Highpass(fs, f));
    this.rest = new Float32Array(blockSize);
  }

  split(input              , outputs                )       {
    let source = input;
    for (let i = 0; i < this.freqs.length; i++) {
      runChain(this.lows[i], source, outputs[i]);
      runChain(this.highs[i], source, this.rest);
      source = this.rest;
    }
    outputs[this.freqs.length].set(source);
  }
}

export const DEFAULT_CROSSOVERS = [150, 1200, 5000];
export const BAND_NAMES = ['Low', 'Low-Mid', 'High-Mid', 'High'];
