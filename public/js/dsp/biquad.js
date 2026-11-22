                               
                                                             
 

export function lowpass(fs        , fc        , q        )               {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw) / 2 / a0,
    b1: (1 - cosw) / a0,
    b2: (1 - cosw) / 2 / a0,
    a1: -2 * cosw / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highpass(fs        , fc        , q        )               {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: -(1 + cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: -2 * cosw / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highshelf(fs        , fc        , gainDb        , s        )               {
  const a = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / 2 * Math.sqrt((a + 1 / a) * (1 / s - 1) + 2);
  const sq = 2 * Math.sqrt(a) * alpha;
  const a0 = (a + 1) - (a - 1) * cosw + sq;
  return {
    b0: a * ((a + 1) + (a - 1) * cosw + sq) / a0,
    b1: -2 * a * ((a - 1) + (a + 1) * cosw) / a0,
    b2: a * ((a + 1) + (a - 1) * cosw - sq) / a0,
    a1: 2 * ((a - 1) - (a + 1) * cosw) / a0,
    a2: ((a + 1) - (a - 1) * cosw - sq) / a0,
  };
}

export class Biquad {
          x1 = 0;         x2 = 0;         y1 = 0;         y2 = 0;
  c              ;
  constructor(c              ) { this.c = c; }
  reset()       { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  process(x        )         {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
  processBlock(input              , output              )       {
    for (let i = 0; i < input.length; i++) output[i] = this.process(input[i]);
  }
}

export function filterBlock(c              , input              , output              )       {
  new Biquad(c).processBlock(input, output);
}
