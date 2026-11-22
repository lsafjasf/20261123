// 与 shared/filters.ts 的 renderPixel 等价的 GLSL 300 es 源码。
// 关键不变量：所有计算都基于“整帧像素坐标 u_framePos”，
// 分块仅通过 viewport 决定每个像素的 framePos，着色器本身不感知分块，
// 因此同一帧坐标在任何分块（含 halo）上结果完全一致。

export const FILTER_VERT = `#version 300 es
precision highp float;
// 顶点为覆盖整个 viewport 的三角扇（0..1 NDC）
in vec2 a_pos;
uniform vec2 u_viewportSize; // 当前分块采样区像素尺寸
uniform vec2 u_sampleOrigin; // 当前采样区左上角在整帧中的像素坐标
out vec2 v_framePos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  // 像素中心坐标：(0.5 .. size-0.5) + 采样区原点
  vec2 local = (a_pos * 0.5 + 0.5) * u_viewportSize;
  v_framePos = local + u_sampleOrigin;
}`;

export const FILTER_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_frameSize;
uniform float u_brightness;
uniform float u_sharpen;
uniform float u_distortion;
in vec2 v_framePos;
out vec4 outColor;

vec2 distortInverse(vec2 p, float k) {
  if (k == 0.0) return p;
  float rout = length(p);
  if (rout == 0.0) return vec2(0.0);
  float rin = rout;
  for (int i = 0; i < 2; i++) {
    float f = rin * (1.0 + k * rin * rin) - rout;
    float fp = 1.0 + 3.0 * k * rin * rin;
    rin = max(0.0, rin - f / fp);
  }
  return p * (rin / rout);
}

// 按整帧像素坐标采样，纹理坐标做半像素对齐
vec3 sampleAt(vec2 px) {
  vec2 uv = (px + vec2(0.5)) / u_frameSize;
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  return texture(u_src, uv).rgb;
}

vec3 bilinear(vec2 px) {
  vec2 p0 = floor(px);
  vec2 f = px - p0;
  vec3 c00 = sampleAt(p0);
  vec3 c10 = sampleAt(p0 + vec2(1.0, 0.0));
  vec3 c01 = sampleAt(p0 + vec2(0.0, 1.0));
  vec3 c11 = sampleAt(p0 + vec2(1.0, 1.0));
  vec3 top = mix(c00, c10, f.x);
  vec3 bot = mix(c01, c11, f.x);
  return mix(top, bot, f.y);
}

void main() {
  // 与 CPU 端相同的中心原点归一化坐标（y 向上）
  vec2 ndc = vec2(
    (v_framePos.x + 0.5) / u_frameSize.x - 0.5,
    0.5 - (v_framePos.y + 0.5) / u_frameSize.y
  );
  vec2 d = distortInverse(ndc, u_distortion);
  vec2 inPx = vec2((d.x + 0.5) * u_frameSize.x - 0.5,
                   (0.5 - d.y) * u_frameSize.y - 0.5);

  vec3 col = bilinear(inPx);
  if (u_sharpen > 0.0) {
    vec3 n = bilinear(inPx + vec2(0.0, -1.0));
    vec3 s = bilinear(inPx + vec2(0.0, 1.0));
    vec3 l = bilinear(inPx + vec2(-1.0, 0.0));
    vec3 r = bilinear(inPx + vec2(1.0, 0.0));
    col = (1.0 + 4.0 * u_sharpen) * col - u_sharpen * (n + s + l + r);
  }
  col = clamp(col * u_brightness, 0.0, 1.0);
  outColor = vec4(col, 1.0);
}`;

/** 简单全屏 blit（用于把 FBO 结果拷回 2D canvas 等）。 */
export const BLIT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() { outColor = texture(u_tex, v_uv); }`;
