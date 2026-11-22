                                             

                             
                  
                     
                   
                  
                      
 

                   
                            
                                
                
                 
 

function prepare(canvas                   )          {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(2, Math.round(rect.width));
  const height = Math.max(2, Math.round(rect.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, width, height };
}

function roundedRect(
  ctx                          ,
  x        ,
  y        ,
  width        ,
  height        ,
  radius        ,
)       {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function drawTrack(ctx                          , width        , height        , timeSec        )       {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#07100f");
  sky.addColorStop(0.5, "#10221d");
  sky.addColorStop(1, "#050807");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const horizon = height * 0.39;
  const glow = ctx.createRadialGradient(width * 0.5, horizon, 4, width * 0.5, horizon, width * 0.52);
  glow.addColorStop(0, "rgba(195,255,95,0.16)");
  glow.addColorStop(0.35, "rgba(84,153,112,0.055)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#050a09";
  for (let index = 0; index < 17; index += 1) {
    const x = (index / 16) * width;
    const buildingHeight = 18 + ((index * 37) % 60);
    ctx.fillRect(x, horizon - buildingHeight, width / 13, buildingHeight);
  }

  const road = ctx.createLinearGradient(0, horizon, 0, height);
  road.addColorStop(0, "#202a26");
  road.addColorStop(0.5, "#151c19");
  road.addColorStop(1, "#0a0e0c");
  ctx.beginPath();
  ctx.moveTo(width * 0.37, horizon);
  ctx.bezierCurveTo(width * 0.31, height * 0.58, width * 0.08, height * 0.9, -width * 0.18, height * 1.04);
  ctx.lineTo(width * 1.18, height * 1.04);
  ctx.bezierCurveTo(width * 0.92, height * 0.86, width * 0.71, height * 0.56, width * 0.63, horizon);
  ctx.closePath();
  ctx.fillStyle = road;
  ctx.fill();

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(210,255,73,0.75)";
  ctx.shadowColor = "rgba(210,255,73,0.35)";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(width * 0.37, horizon);
  ctx.bezierCurveTo(width * 0.31, height * 0.58, width * 0.08, height * 0.9, -width * 0.18, height * 1.04);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(width * 0.63, horizon);
  ctx.bezierCurveTo(width * 0.71, height * 0.56, width * 0.92, height * 0.86, width * 1.18, height * 1.04);
  ctx.stroke();
  ctx.restore();

  const travel = (timeSec * 0.72) % 1;
  ctx.strokeStyle = "rgba(229,238,215,0.2)";
  ctx.lineWidth = 2;
  for (let index = 0; index < 10; index += 1) {
    const depth = (index + travel) / 10;
    const eased = depth * depth;
    const y = horizon + eased * (height - horizon) * 1.08;
    const halfWidth = 5 + eased * width * 0.36;
    const dash = 4 + eased * 38;
    ctx.beginPath();
    ctx.moveTo(width * 0.5, y);
    ctx.lineTo(width * 0.5, y + dash);
    ctx.lineWidth = 1 + eased * 4;
    ctx.stroke();
    ctx.globalAlpha = 0.08 + eased * 0.22;
  }
  ctx.globalAlpha = 1;

  for (let side = 0; side < 2; side += 1) {
    const sideSign = side === 0 ? -1 : 1;
    for (let index = 0; index < 8; index += 1) {
      const depth = (index + travel * 1.8) % 8 / 8;
      const eased = depth * depth;
      const y = horizon + eased * (height - horizon) * 1.02;
      const x = width * 0.5 + sideSign * (width * 0.34 + eased * width * 0.16);
      const lightHeight = 8 + eased * 50;
      ctx.fillStyle = "rgba(196,240,147,0.1)";
      ctx.fillRect(x - 2, y - lightHeight, 4, lightHeight);
      ctx.fillStyle = "rgba(217,255,152,0.7)";
      ctx.fillRect(x - 2, y - lightHeight, 4, 2);
    }
  }

  const haze = ctx.createLinearGradient(0, horizon - 20, 0, height);
  haze.addColorStop(0, "rgba(180,220,180,0.045)");
  haze.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizon - 20, width, height - horizon + 20);
}

function drawSpeedLines(
  ctx                          ,
  width        ,
  height        ,
  timeSec        ,
  rate        ,
)       {
  ctx.save();
  ctx.lineCap = "round";
  for (let index = 0; index < 34; index += 1) {
    const seed = (index * 73) % 101;
    const x = width * 0.08 + ((seed / 101) * 0.84 + timeSec * (0.08 + (index % 5) * 0.018) * rate) % 1 * width * 0.84;
    const y = height * 0.5 + ((index * 47) % 190) / 190 * height * 0.46;
    const length = 8 + (index % 7) * 9 * (0.3 + rate * 0.7);
    ctx.strokeStyle = `rgba(217,255,244,${0.025 + (index % 4) * 0.017})`;
    ctx.lineWidth = 1 + (index % 3) * 0.55;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + length, y + 1.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCar(ctx                          , x        , y        , scale        , glow        )       {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.ellipse(0, 33, 184, 32, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#070908";
  roundedRect(ctx, -160, -5, 43, 72, 10);
  ctx.fill();
  roundedRect(ctx, 117, -5, 43, 72, 10);
  ctx.fill();
  ctx.fillStyle = "rgba(107,121,109,0.24)";
  roundedRect(ctx, -157, 3, 37, 7, 4);
  ctx.fill();
  roundedRect(ctx, 120, 3, 37, 7, 4);
  ctx.fill();
  ctx.strokeStyle = "rgba(119,135,121,0.3)";
  ctx.lineWidth = 2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 102, 8);
    ctx.lineTo(side * 126, 5);
    ctx.moveTo(side * 102, 27);
    ctx.lineTo(side * 126, 34);
    ctx.stroke();
  }

  ctx.fillStyle = "#131916";
  roundedRect(ctx, -112, -35, 224, 91, 21);
  ctx.fill();

  const body = ctx.createLinearGradient(-100, 0, 100, 0);
  body.addColorStop(0, "#9da69b");
  body.addColorStop(0.18, "#eef0db");
  body.addColorStop(0.5, "#fbfbe9");
  body.addColorStop(0.82, "#e3e5d2");
  body.addColorStop(1, "#858f84");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-75, -55);
  ctx.lineTo(-40, -59);
  ctx.lineTo(40, -59);
  ctx.lineTo(77, -53);
  ctx.lineTo(107, -3);
  ctx.lineTo(103, 41);
  ctx.lineTo(68, 55);
  ctx.lineTo(38, 60);
  ctx.lineTo(-38, 60);
  ctx.lineTo(-68, 54);
  ctx.lineTo(-103, 40);
  ctx.lineTo(-107, -4);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#151b17";
  roundedRect(ctx, -101, 38, 202, 10, 3);
  ctx.fill();
  for (let fin = -4; fin <= 4; fin += 1) {
    ctx.fillStyle = "rgba(178,189,174,0.36)";
    ctx.fillRect(fin * 17 - 1, 45, 2, 10);
  }

  ctx.fillStyle = "#d7ff3f";
  ctx.beginPath();
  ctx.moveTo(-78, -51);
  ctx.lineTo(-35, -56);
  ctx.lineTo(38, -56);
  ctx.lineTo(80, -49);
  ctx.lineTo(94, -30);
  ctx.lineTo(-94, -30);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#ff5b36";
  ctx.fillRect(-88, -25, 176, 7);
  ctx.fillStyle = "rgba(255,73,40,0.72)";
  ctx.shadowColor = "#ff4e2b";
  ctx.shadowBlur = 18 + glow * 14;
  ctx.fillRect(-78, -12, 27, 8);
  ctx.fillRect(51, -12, 27, 8);
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#0b100e";
  roundedRect(ctx, -37, -31, 74, 39, 13);
  ctx.fill();
  ctx.fillStyle = "rgba(108,160,143,0.42)";
  roundedRect(ctx, -29, -25, 58, 19, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(215,255,63,0.68)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -31);
  ctx.lineTo(0, 8);
  ctx.stroke();

  const wing = ctx.createLinearGradient(0, -88, 0, -64);
  wing.addColorStop(0, "#141a16");
  wing.addColorStop(0.65, "#303a31");
  wing.addColorStop(1, "#0b0f0c");
  ctx.fillStyle = wing;
  roundedRect(ctx, -142, -88, 284, 19, 3);
  ctx.fill();
  ctx.fillStyle = "#d7ff3f";
  ctx.fillRect(-142, -94, 16, 31);
  ctx.fillRect(126, -94, 16, 31);
  ctx.fillStyle = "#ff6842";
  ctx.fillRect(-124, -71, 248, 3);
  ctx.fillStyle = "#151b17";
  ctx.fillRect(-55, -69, 6, 25);
  ctx.fillRect(49, -69, 6, 25);

  ctx.fillStyle = "#202823";
  ctx.fillRect(-40, 58, 18, 10);
  ctx.fillRect(22, 58, 18, 10);
  ctx.fillStyle = "rgba(255,110,61,0.7)";
  ctx.shadowColor = "#ff5b36";
  ctx.shadowBlur = 12 + glow * 12;
  ctx.beginPath();
  ctx.arc(-20, 64, 3, 0, Math.PI * 2);
  ctx.arc(20, 64, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#111713";
  ctx.font = "800 30px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("07", 0, 26);

  ctx.restore();
}

export function drawScene(canvas                   , state            )       {
  const { ctx, width, height } = prepare(canvas);
  const { config, timeSec, frozen } = state;
  const rate = frozen ? 0 : Math.min(1, Math.max(0, 1 - Math.max(0, timeSec - config.startSec) / Math.max(0.001, config.impactSec - config.startSec)));

  ctx.clearRect(0, 0, width, height);
  drawTrack(ctx, width, height, frozen ? config.impactSec : timeSec);

  const approach = Math.min(1, Math.max(0, timeSec / config.impactSec));
  const shake = frozen ? 0 : Math.sin(timeSec * 31) * 0.9;
  const carX = width * (0.43 + approach * 0.15) + shake;
  const carY = height * (0.63 - approach * 0.035);
  const carScale = width < 620 ? 0.65 : width < 900 ? 0.79 : 0.98;

  drawSpeedLines(ctx, width, height, timeSec, rate);

  ctx.save();
  if (frozen) {
    ctx.filter = "saturate(0.7) contrast(1.08)";
  }
  drawCar(ctx, carX, carY, carScale, frozen ? 1 : rate);
  ctx.restore();

  const vignette = ctx.createRadialGradient(width * 0.5, height * 0.55, width * 0.12, width * 0.5, height * 0.55, width * 0.74);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.62)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  if (frozen) {
    ctx.strokeStyle = "rgba(255,92,54,0.75)";
    ctx.lineWidth = 1;
    ctx.strokeRect(15.5, 15.5, width - 31, height - 31);
    ctx.fillStyle = "rgba(255,84,45,0.055)";
    ctx.fillRect(0, 0, width, height);
    const corner = 22;
    ctx.strokeStyle = "#ff6a3e";
    ctx.lineWidth = 2;
    for (const [x, y, sx, sy] of [
      [26, 26, 1, 1],
      [width - 26, 26, -1, 1],
      [26, height - 26, 1, -1],
      [width - 26, height - 26, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x, y + sy * corner);
      ctx.lineTo(x, y);
      ctx.lineTo(x + sx * corner, y);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(carX, carY - 12);
    ctx.strokeStyle = "rgba(255,91,54,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-118, 0);
    ctx.lineTo(-48, 0);
    ctx.moveTo(48, 0);
    ctx.lineTo(118, 0);
    ctx.moveTo(0, -112);
    ctx.lineTo(0, -46);
    ctx.moveTo(0, 64);
    ctx.lineTo(0, 112);
    ctx.stroke();
    ctx.restore();
  }

  if (state.impactFlash > 0) {
    ctx.fillStyle = `rgba(255,236,210,${state.impactFlash * 0.28})`;
    ctx.fillRect(0, 0, width, height);
  }
}


//# sourceURL=scene.ts