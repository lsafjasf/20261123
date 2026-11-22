// WebGL2 薄封装：编译、program、FBO、纹理、计时查询。无第三方依赖。

export interface GlContext {
  gl: WebGL2RenderingContext;
  timerExt: EXT_disjoint_timer_query_webgl2 | null;
}

export function createGlContext(canvas: HTMLCanvasElement): GlContext {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
  });
  if (!gl) throw new Error('当前环境不支持 WebGL2');
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  return { gl, timerExt };
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader 编译失败: ${log}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program 链接失败: ${log}`);
  }
  return program;
}

export function uniformLocs(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: string[],
): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}

/** 创建覆盖 viewport 的单位三角扇缓冲（NDC -1..1）。 */
export function createQuadBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const buf = gl.createBuffer();
  if (!buf) throw new Error('无法创建缓冲');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  return buf;
}

export interface GpuTimer {
  query: WebGLQuery;
  /** GPU 纳秒，查询未就绪时为 null */
  nanos: number | null;
}

export function createTimer(gl: WebGL2RenderingContext, ext: EXT_disjoint_timer_query_webgl2 | null): GpuTimer | null {
  if (!ext) return null;
  const query = gl.createQuery();
  if (!query) return null;
  return { query, nanos: null };
}

export function pollTimer(gl: WebGL2RenderingContext, ext: EXT_disjoint_timer_query_webgl2, timer: GpuTimer): boolean {
  const ready = gl.getQueryParameter(timer.query, gl.QUERY_RESULT_AVAILABLE) as boolean;
  const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
  if (ready && !disjoint) {
    timer.nanos = gl.getQueryParameter(timer.query, gl.QUERY_RESULT) as number;
    return true;
  }
  return false;
}
