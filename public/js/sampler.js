// Corner / center sampling: quantifies vignetting before and after
// correction by averaging RGB in fixed normalized regions of the frame.

                             
               
            
            
            
               
 

                             
                                                  
                                                 
                     
                                                 
 

const REGION_DEFS                                                                          = [
  { name: "TL", x0: 0.0, y0: 0.0, x1: 0.125, y1: 0.125 },
  { name: "TR", x0: 0.875, y0: 0.0, x1: 1.0, y1: 0.125 },
  { name: "BL", x0: 0.0, y0: 0.875, x1: 0.125, y1: 1.0 },
  { name: "BR", x0: 0.875, y0: 0.875, x1: 1.0, y1: 1.0 },
  { name: "C", x0: 0.4375, y0: 0.4375, x1: 0.5625, y1: 0.5625 },
];

export function sampleRegions(data                   , width        , height        )             {
  const regions               = [];
  for (const def of REGION_DEFS) {
    const x0 = Math.floor(def.x0 * width);
    const x1 = Math.max(x0 + 1, Math.floor(def.x1 * width));
    const y0 = Math.floor(def.y0 * height);
    const y1 = Math.max(y0 + 1, Math.floor(def.y1 * height));
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      let i = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        sr += data[i];
        sg += data[i + 1];
        sb += data[i + 2];
        n++;
      }
    }
    const r = sr / n, g = sg / n, b = sb / n;
    regions.push({
      name: def.name,
      r,
      g,
      b,
      luma: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    });
  }
  const cornerLuma = (regions[0].luma + regions[1].luma + regions[2].luma + regions[3].luma) / 4;
  const centerLuma = regions[4].luma;
  return {
    regions,
    cornerLuma,
    centerLuma,
    cornerToCenter: centerLuma > 1e-6 ? cornerLuma / centerLuma : 1,
  };
}
