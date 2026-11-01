/** Minimal WebGL2 helpers: program cache, uniform setters, textures, FBOs, 4×4 math. */

export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, vs: string, fs: string) {
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aUv');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program link: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
  }
  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }
  private loc(n: string): WebGLUniformLocation | null {
    if (!this.locs.has(n)) this.locs.set(n, this.gl.getUniformLocation(this.prog, n));
    return this.locs.get(n)!;
  }
  f(n: string, ...v: number[]): this {
    const l = this.loc(n);
    if (l === null) return this;
    const g = this.gl;
    if (v.length === 1) g.uniform1f(l, v[0]!);
    else if (v.length === 2) g.uniform2f(l, v[0]!, v[1]!);
    else if (v.length === 3) g.uniform3f(l, v[0]!, v[1]!, v[2]!);
    else g.uniform4f(l, v[0]!, v[1]!, v[2]!, v[3]!);
    return this;
  }
  i(n: string, v: number): this {
    const l = this.loc(n);
    if (l !== null) this.gl.uniform1i(l, v);
    return this;
  }
  m4(n: string, m: Float32Array | number[]): this {
    const l = this.loc(n);
    if (l !== null) this.gl.uniformMatrix4fv(l, false, m);
    return this;
  }
  v4arr(n: string, data: Float32Array): this {
    const l = this.loc(n);
    if (l !== null) this.gl.uniform4fv(l, data);
    return this;
  }
  farr(n: string, data: Float32Array): this {
    const l = this.loc(n);
    if (l !== null) this.gl.uniform1fv(l, data);
    return this;
  }
  v3arr(n: string, data: Float32Array): this {
    const l = this.loc(n);
    if (l !== null) this.gl.uniform3fv(l, data);
    return this;
  }
}

export function createTexture(gl: WebGL2RenderingContext, mip = false): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  return t;
}

export function upload(gl: WebGL2RenderingContext, tex: WebGLTexture, src: TexImageSource, mip = false, premultiply = true): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  if (mip) gl.generateMipmap(gl.TEXTURE_2D);
}

export interface Fbo { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }
export function createFbo(gl: WebGL2RenderingContext, w: number, h: number, prev?: Fbo): Fbo {
  if (prev && prev.w === w && prev.h === h) return prev;
  if (prev) {
    gl.deleteFramebuffer(prev.fb);
    gl.deleteTexture(prev.tex);
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex, w, h };
}

// ---------------------------------------------------------------- column-major 4×4 math
export type M4 = Float32Array;
export const ident = (): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export function mul4(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}
export const translate = (x: number, y: number, z = 0): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
export const scale4 = (x: number, y: number, z = 1): M4 => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
export function rotX(deg: number): M4 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
export function rotY(deg: number): M4 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
export function rotZ(deg: number): M4 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
export function transformPoint(m: M4, x: number, y: number): { x: number; y: number; w: number } {
  const X = m[0]! * x + m[4]! * y + m[12]!;
  const Y = m[1]! * x + m[5]! * y + m[13]!;
  const W = m[3]! * x + m[7]! * y + m[15]!;
  return { x: X / W, y: Y / W, w: W };
}
