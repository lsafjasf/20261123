import { clamp01 } from "./color.js";
                                            

function mix(a        , b        , amount        )         {
  return a + (b - a) * amount;
}

function roundedBoxDistance(
  x        ,
  y        ,
  halfWidth        ,
  halfHeight        ,
  radius        
)         {
  const qx = Math.abs(x) - halfWidth + radius;
  const qy = Math.abs(y) - halfHeight + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

                                         
                  
                  
                
                    
                     
                 
 

export function syntheticPanelGeometry(
  timeSec        ,
  width        ,
  height        ,
  motionSpeed = 1
)                         {
  const motionTime = timeSec * motionSpeed;
  const unit = Math.min(width, height);
  return {
    centerX: width * (0.5 + 0.31 * Math.sin(motionTime * 1.03 + 0.2)),
    centerY: height * (0.52 + 0.09 * Math.sin(motionTime * 1.51 + 0.7)),
    angle: motionTime * 0.72 + 0.22 * Math.sin(motionTime * 0.87),
    halfWidth: width * 0.155,
    halfHeight: height * 0.285,
    corner: unit * 0.035
  };
}

export function syntheticPanelMaskAt(
  timeSec        ,
  width        ,
  height        ,
  motionSpeed = 1
)             {
  const mask = new Uint8Array(width * height);
  const geometry = syntheticPanelGeometry(timeSec, width, height, motionSpeed);
  const cosine = Math.cos(geometry.angle);
  const sine = Math.sin(geometry.angle);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - geometry.centerX;
      const dy = y - geometry.centerY;
      const localX = cosine * dx + sine * dy;
      const localY = -sine * dx + cosine * dy;
      if (
        roundedBoxDistance(
          localX,
          localY,
          geometry.halfWidth,
          geometry.halfHeight,
          geometry.corner
        ) <= 1
      ) {
        mask[y * width + x] = 255;
      }
    }
  }
  return mask;
}

export function syntheticFrameAt(
  timeSec        ,
  width        ,
  height        ,
  motionSpeed = 1
)            {
  const motionTime = timeSec * motionSpeed;
  const data = new Uint8ClampedArray(width * height * 4);
  const unit = Math.min(width, height);
  const geometry = syntheticPanelGeometry(timeSec, width, height, motionSpeed);
  const centerX = geometry.centerX;
  const centerY = geometry.centerY;
  const angle = geometry.angle;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const halfWidth = geometry.halfWidth;
  const halfHeight = geometry.halfHeight;
  const corner = geometry.corner;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const diagonal = Math.sin((x * 0.042 + y * 0.024) - motionTime * 1.35);
      const bands = Math.floor(((x - motionTime * 22 + width * 10) % (unit * 0.42)) / (unit * 0.14));
      let red = 232;
      let green = 227;
      let blue = 214;

      if (bands === 1) {
        red = 218;
        green = 215;
        blue = 203;
      }
      if (diagonal > 0.74) {
        red -= 22;
        green -= 20;
        blue -= 16;
      }

      const shade = 1 - y / height * 0.16;
      red *= shade;
      green *= shade;
      blue *= shade;

      const backgroundCircleX = x - width * (0.74 + 0.06 * Math.sin(motionTime * 0.8));
      const backgroundCircleY = y - height * (0.68 - 0.04 * Math.cos(motionTime * 0.6));
      const backgroundCircle = Math.hypot(backgroundCircleX, backgroundCircleY);
      if (backgroundCircle < unit * 0.13) {
        const amount = 0.2 * clamp01((unit * 0.13 - backgroundCircle) / 3);
        red = mix(red, 92, amount);
        green = mix(green, 107, amount);
        blue = mix(blue, 95, amount);
      }

      const dx = x - centerX;
      const dy = y - centerY;
      const localX = cosine * dx + sine * dy;
      const localY = -sine * dx + cosine * dy;
      const shadowDistance = roundedBoxDistance(
        localX - unit * 0.023,
        localY - unit * 0.032,
        halfWidth,
        halfHeight,
        corner
      );
      const shadow = 0.2 * clamp01((unit * 0.03 - shadowDistance) / (unit * 0.05));
      if (shadow > 0) {
        red *= 1 - shadow;
        green *= 1 - shadow;
        blue *= 1 - shadow;
      }

      const distance = roundedBoxDistance(localX, localY, halfWidth, halfHeight, corner);
      const coverage = clamp01(0.5 - distance);
      if (coverage > 0) {
        let panelRed = 29;
        let panelGreen = 37;
        let panelBlue = 34;
        const diagonal = localX * 0.82 + localY * 0.34;
        if (diagonal > -halfWidth * 0.25 && diagonal < halfWidth * 0.22) {
          panelRed = 226;
          panelGreen = 83;
          panelBlue = 56;
        }

        const discRadius = unit * 0.088;
        const discX = localX + halfWidth * 0.34;
        const discY = localY - halfHeight * 0.27;
        if (Math.hypot(discX, discY) < discRadius) {
          const rim = Math.hypot(discX, discY) > discRadius - 2.5;
          panelRed = rim ? 29 : 241;
          panelGreen = rim ? 37 : 235;
          panelBlue = rim ? 34 : 213;
          if (Math.hypot(discX + discRadius * 0.2, discY + discRadius * 0.1) < discRadius * 0.28) {
            panelRed = 29;
            panelGreen = 37;
            panelBlue = 34;
          }
        }

        if (distance > -2.2) {
          panelRed = 239;
          panelGreen = 232;
          panelBlue = 211;
        }

        red = mix(red, panelRed, coverage);
        green = mix(green, panelGreen, coverage);
        blue = mix(blue, panelBlue, coverage);
      }

      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }

  return { width, height, data };
}
