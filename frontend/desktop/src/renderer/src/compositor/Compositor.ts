/**
 * WebGL2 compositor (plan §3, task 3.5). One renderer for preview AND export:
 *   background → [camera behind] → stage shadow → stage (zoom/pan/3D, motion blur) → click effects →
 *   cursor → [camera] → post (masks) → 2D overlay (text, shapes, captions, keys, watermark).
 * All stage-space drawing goes through one MVP (uv → clip), so 2D and 3D share code paths.
 */
import { lerp, type Annotation, type Project, type SceneState } from '@rec/shared';
import { CAMERA_FILTERS, CLICK_EFFECTS, CURSOR_STYLES, cursorSvg, GRADIENTS, hexToRgb, SHAPES, WALLPAPERS, type ShapeName } from './assets';
import { DEVICE_FRAMES } from '../editor/deviceFrames';
import { createFbo, createTexture, ident, mul4, Program, rotX, rotY, rotZ, scale4, translate, upload, type Fbo, type M4 } from './gl';
import { BG_FS, BLIT_FS, CAMERA_FS, CLICK_FS, FULLSCREEN_VS, POST_FS, QUAD_VS, SHADOW_FS, SPRITE_FS, STAGE_FS } from './shaders';

/** Mask annotations evaluated per frame by the post pass (uniform arrays in POST_FS are sized to match). */
const MAX_MASKS = 16;

export interface FrameSources {
  screen: TexImageSource | null;
  camera: TexImageSource | null;
  cameraSize?: { w: number; h: number };
  cameraMask?: TexImageSource | null;
  /** background image (custom upload) */
  bgImage?: TexImageSource | null;
  cameraBgImage?: TexImageSource | null;
  /** 2D overlay canvas (same size as output) */
  overlay?: TexImageSource | null;
}

export interface RenderOpts {
  quality: 'preview' | 'export';
  fps: number;
}

interface CursorSprite { tex: WebGLTexture; hot: [number, number]; box: number }

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private bg: Program;
  private stage: Program;
  private shadow: Program;
  private sprite: Program;
  private click: Program;
  private camera: Program;
  private post: Program;
  private blit: Program;
  private quadVao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;
  private fsVao: WebGLVertexArrayObject;
  private texScreen: WebGLTexture;
  private texCamera: WebGLTexture;
  private texMask: WebGLTexture;
  private texBg: WebGLTexture;
  private texCamBg: WebGLTexture;
  private texOverlay: WebGLTexture;
  private sceneFbo: Fbo | null = null;
  private cursorCache = new Map<string, CursorSprite | 'loading'>();
  private customCursors = new Map<number, CursorSprite>();
  private importedCursor: { key: string; sprite: CursorSprite } | null = null;
  private lastBgImage: TexImageSource | null = null;
  private lastCamBgImage: TexImageSource | null = null;
  width = 1;
  height = 1;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available on this GPU/driver');
    this.gl = gl;
    this.bg = new Program(gl, FULLSCREEN_VS, BG_FS);
    this.stage = new Program(gl, QUAD_VS, STAGE_FS);
    this.shadow = new Program(gl, QUAD_VS, SHADOW_FS);
    this.sprite = new Program(gl, QUAD_VS, SPRITE_FS);
    this.click = new Program(gl, QUAD_VS, CLICK_FS);
    this.camera = new Program(gl, QUAD_VS, CAMERA_FS);
    this.post = new Program(gl, FULLSCREEN_VS, POST_FS);
    this.blit = new Program(gl, FULLSCREEN_VS, BLIT_FS);
    // dynamic quad: 4 verts × (pos.xy, uv.xy)
    this.quadVao = gl.createVertexArray()!;
    this.quadBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 16 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    this.fsVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fsVao);
    const fsb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, fsb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.texScreen = createTexture(gl);
    this.texCamera = createTexture(gl);
    this.texMask = createTexture(gl);
    this.texBg = createTexture(gl, true);
    this.texCamBg = createTexture(gl);
    this.texOverlay = createTexture(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied
  }

  resize(w: number, h: number): void {
    const W = Math.max(2, Math.round(w));
    const H = Math.max(2, Math.round(h));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    this.width = W;
    this.height = H;
    this.sceneFbo = createFbo(this.gl, W, H, this.sceneFbo ?? undefined);
  }

  // ---------------------------------------------------------------- assets

  /** Rasterise cursor sprites for a style (async); export calls this up-front for every shape. */
  async prepareCursors(styleId: string, color: string | undefined, shapes: readonly ShapeName[] = SHAPES): Promise<void> {
    await Promise.all(shapes.map((s) => this.loadCursor(styleId, color, s)));
  }

  private cursorKey(styleId: string, color: string | undefined, shape: ShapeName): string {
    return `${styleId}|${color ?? ''}|${shape}`;
  }

  private async loadCursor(styleId: string, color: string | undefined, shape: ShapeName): Promise<void> {
    const key = this.cursorKey(styleId, color, shape);
    if (this.cursorCache.has(key)) return;
    this.cursorCache.set(key, 'loading');
    const style = CURSOR_STYLES.find((s) => s.id === styleId) ?? CURSOR_STYLES[0]!;
    const { svg, hot } = cursorSvg(style, shape, color);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const bmp = await createImageBitmap(await rasterSvg(blob, 256));
    const tex = createTexture(this.gl, true);
    upload(this.gl, tex, bmp, true, true);
    this.cursorCache.set(key, { tex, hot, box: 32 });
  }

  /** RM-11: user-imported cursor image replacing every shape. */
  async setImportedCursor(url: string | null, hotspot: [number, number] = [0, 0]): Promise<void> {
    if (!url) { this.importedCursor = null; return; }
    if (this.importedCursor?.key === url) return;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Imported cursor image not found (${res.status})`);
    const img = await createImageBitmap(await res.blob());
    const tex = createTexture(this.gl, true);
    upload(this.gl, tex, img, true, true);
    this.importedCursor = { key: url, sprite: { tex, hot: hotspot, box: Math.max(img.width, img.height, 1) } };
  }

  /** App-specific cursor bitmaps captured by the helper (id ≥ 100). */
  async loadCustomCursor(id: number, url: string, hotspot: [number, number]): Promise<void> {
    const img = await fetch(url).then((r) => r.blob()).then((b) => createImageBitmap(b));
    const tex = createTexture(this.gl, true);
    upload(this.gl, tex, img, true, true);
    this.customCursors.set(id, { tex, hot: hotspot, box: Math.max(img.width, 1) });
  }

  // ---------------------------------------------------------------- matrices

  /** MVP mapping stage uv (0..1 of cropped source) → clip space, including 3D motion. */
  stageMVP(scene: SceneState): M4 {
    const W = this.width, H = this.height;
    const { stage, viewport, cam } = scene;
    const fw = (stage.w / viewport.w) * cam.z;
    const fh = (stage.h / viewport.h) * cam.z;
    const sx = stage.x + stage.w / 2;
    const sy = stage.y + stage.h / 2;
    const A = mul4(translate(sx - cam.cx * fw, sy - cam.cy * fh), scale4(fw, fh));
    const C = mul4(scale4(1, -1), translate(-W / 2, -H / 2));
    let M = mul4(C, A);
    const k = cam.m3d;
    if (k > 0.001) {
      const px = sx - W / 2, py = H / 2 - sy;
      const R = mul4(rotZ(cam.rz * k), mul4(rotY(cam.ry * k), rotX(cam.rx * k)));
      const piv = mul4(translate(px, py), mul4(R, translate(-px, -py)));
      M = mul4(translate(cam.px * W * k, -cam.py * H * k), mul4(piv, M));
    }
    const fov = lerp(45, cam.fov, k);
    const d = H / 2 / Math.tan((fov * Math.PI) / 360);
    const P = new Float32Array([2 / W, 0, 0, 0, 0, 2 / H, 0, 0, 0, 0, 0, -1 / d, 0, 0, 0, 1]);
    return mul4(P, M);
  }

  /** Canvas-pixel ortho MVP (camera layer, overlays). */
  orthoMVP(): M4 {
    const W = this.width, H = this.height;
    return new Float32Array([2 / W, 0, 0, 0, 0, -2 / H, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]);
  }

  /** Project a stage uv point to canvas px (through 3D). */
  uvToCanvas(mvp: M4, u: number, v: number): { x: number; y: number } {
    const X = mvp[0]! * u + mvp[4]! * v + mvp[12]!;
    const Y = mvp[1]! * u + mvp[5]! * v + mvp[13]!;
    const Wc = mvp[3]! * u + mvp[7]! * v + mvp[15]!;
    return { x: ((X / Wc + 1) / 2) * this.width, y: ((1 - Y / Wc) / 2) * this.height };
  }

  private quad(pos: number[], uv: number[] = [0, 0, 1, 0, 0, 1, 1, 1]): void {
    const gl = this.gl;
    const d = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      d[i * 4] = pos[i * 2]!;
      d[i * 4 + 1] = pos[i * 2 + 1]!;
      d[i * 4 + 2] = uv[i * 2]!;
      d[i * 4 + 3] = uv[i * 2 + 1]!;
    }
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private rect(x: number, y: number, w: number, h: number): number[] {
    return [x, y, x + w, y, x, y + h, x + w, y + h];
  }

  private fullscreen(): void {
    this.gl.bindVertexArray(this.fsVao);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------------------------------------------------------------- render

  render(project: Project, scene: SceneState, src: FrameSources, opts: RenderOpts): void {
    const gl = this.gl;
    const W = this.width, H = this.height;
    const base = Math.min(W, H) / 1080; // UI-size scale relative to 1080p
    // never leave the scene texture bound while rendering into its framebuffer (feedback loop)
    for (let u = 0; u < 3; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo!.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawBackground(project, src);
    const cam = scene.cameraLayer;
    if (cam?.behind && src.camera) this.drawCamera(project, scene, src, base);

    const mvp = this.stageMVP(scene);
    const stageSize = { w: (scene.stage.w / scene.viewport.w) * scene.cam.z, h: (scene.stage.h / scene.viewport.h) * scene.cam.z };
    const frame = project.canvas.deviceFrame ? DEVICE_FRAMES.find((f) => f.id === project.canvas.deviceFrame) : undefined;
    const roundPx = (frame ? frame.screenCorner : project.canvas.roundness * 0.18) * Math.min(scene.stage.w, scene.stage.h);
    const clip = project.canvas.verticalFill && scene.viewport.w < 0.999 ? scene.stage : null;

    // stage shadow (STY-03)
    if (project.canvas.shadow > 0.01) {
      const blur = (8 + project.canvas.shadow * 70) * base * Math.max(1, scene.cam.z * 0.5);
      const ex = blur * 2;
      const qw = (clip?.w ?? stageSize.w) + ex * 2, qh = (clip?.h ?? stageSize.h) + ex * 2;
      if (clip) {
        this.shadow.use().m4('uMVP', this.orthoMVP()).f('uSize', qw, qh).f('uBox', clip.w / 2, clip.h / 2).f('uRadius', roundPx).f('uBlur', blur).f('uAlpha', project.canvas.shadow * 0.75).f('uOffset', 0, blur * 0.25);
        this.quad(this.rect(clip.x - ex, clip.y - ex, qw, qh));
      } else {
        const du = ex / stageSize.w, dv = ex / stageSize.h;
        this.shadow.use().m4('uMVP', mvp).f('uSize', qw, qh).f('uBox', stageSize.w / 2, stageSize.h / 2).f('uRadius', roundPx * scene.cam.z).f('uBlur', blur).f('uAlpha', project.canvas.shadow * 0.75).f('uOffset', 0, -blur * 0.25);
        this.quad([-du, -dv, 1 + du, -dv, -du, 1 + dv, 1 + du, 1 + dv]);
      }
    }

    // stage
    const sw = sourceWidth(src.screen);
    if (src.screen && sw > 0) upload(gl, this.texScreen, src.screen, false, false);
    const crop = project.canvas.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const mb = project.animation.motionBlur;
    const cp = scene.camPrev;
    const blurOn = mb.enabled && (mb.zoom > 0 || mb.screen > 0) && (Math.abs(cp.z - scene.cam.z) > 1e-4 || Math.abs(cp.cx - scene.cam.cx) > 1e-5 || Math.abs(cp.cy - scene.cam.cy) > 1e-5);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texScreen);
    this.stage.use().m4('uMVP', mvp).i('uTex', 0)
      .f('uCrop', crop.x, crop.y, crop.w, crop.h)
      .f('uSize', stageSize.w, stageSize.h)
      .f('uRadius', roundPx * scene.cam.z)
      .f('uInset', project.canvas.inset)
      .f('uInsetColor', 0.07, 0.07, 0.09)
      .f('uCam', scene.cam.cx, scene.cam.cy)
      .f('uZRatio', scene.cam.z / Math.max(cp.z, 1e-3))
      .f('uPanDelta', cp.cx - scene.cam.cx, cp.cy - scene.cam.cy)
      .f('uWZoom', blurOn ? mb.zoom / Math.max(mb.zoom, mb.screen, 1) : 0)
      .f('uWPan', blurOn ? mb.screen / Math.max(mb.zoom, mb.screen, 1) : 0)
      .i('uTaps', blurOn ? (opts.quality === 'export' ? 16 : 8) : 1)
      .f('uClip', clip ? clip.x : 0, clip ? clip.y : 0, clip ? clip.w : 0, clip ? clip.h : 0)
      .f('uClipRadius', roundPx)
      .f('uCanvasH', H)
      .f('uHasTex', sw > 0 ? 1 : 0);
    this.quad([0, 0, 1, 0, 0, 1, 1, 1]);

    this.drawClicks(project, scene, mvp, stageSize);
    this.drawCursor(project, scene, mvp, stageSize);
    if (cam && !cam.behind && src.camera) this.drawCamera(project, scene, src, base);

    // post: masks over the composed scene, into the default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneFbo!.tex);
    const masks = this.collectMasks(scene, mvp);
    if (masks.count > 0) {
      this.post.use().i('uScene', 0).f('uRes', W, H).i('uCount', masks.count).v4arr('uRect', masks.rect).v4arr('uParam', masks.param).v4arr('uParam2', masks.param2).v3arr('uColor', masks.color).farr('uRot', masks.rot);
    } else {
      this.post.use().i('uScene', 0).f('uRes', W, H).i('uCount', 0);
    }
    this.fullscreen();
    gl.enable(gl.BLEND);

    if (src.overlay) {
      upload(gl, this.texOverlay, src.overlay, false, true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texOverlay);
      this.sprite.use().m4('uMVP', this.orthoMVP()).i('uTex', 0).f('uAlpha', 1).f('uTint', 0, 0, 0, 0);
      this.quad(this.rect(0, 0, W, H));
    }
  }

  private drawBackground(project: Project, src: FrameSources): void {
    const gl = this.gl;
    const bg = project.canvas.background;
    const p = this.bg.use().f('uRes', this.width, this.height).f('uBlur', project.canvas.backgroundBlur);
    if (bg.type === 'color') {
      p.i('uType', 0).f('uC0', ...hexToRgb(bg.value));
    } else if (bg.type === 'gradient') {
      const g = GRADIENTS.find((x) => x.id === bg.value) ?? GRADIENTS[0]!;
      const w = WALLPAPERS.find((x) => x.id === bg.value);
      if (w && !GRADIENTS.some((x) => x.id === bg.value)) {
        p.i('uType', 3).i('uPattern', w.pattern).f('uC0', ...hexToRgb(w.colors[0])).f('uC1', ...hexToRgb(w.colors[1])).f('uC2', ...hexToRgb(w.colors[2]));
      } else {
        p.i('uType', 1).f('uAngle', (g.angle * Math.PI) / 180).f('uC0', ...hexToRgb(g.colors[0])).f('uC1', ...hexToRgb(g.colors[1])).f('uC2', ...hexToRgb(g.colors[2]));
      }
    } else if (bg.type === 'wallpaper') {
      const w = WALLPAPERS.find((x) => x.id === bg.value) ?? WALLPAPERS[0]!;
      p.i('uType', 3).i('uPattern', w.pattern).f('uC0', ...hexToRgb(w.colors[0])).f('uC1', ...hexToRgb(w.colors[1])).f('uC2', ...hexToRgb(w.colors[2]));
    } else if ((bg.type === 'image' || bg.type === 'video') && src.bgImage) {
      // a video element is the same object every frame, so video backgrounds re-upload each render
      if (src.bgImage !== this.lastBgImage || bg.type === 'video') {
        upload(gl, this.texBg, src.bgImage, true, false);
        this.lastBgImage = src.bgImage;
      }
      const iw = sourceWidth(src.bgImage) || 1, ih = sourceHeight(src.bgImage) || 1;
      const ca = this.width / this.height, ia = iw / ih;
      const sx = ca > ia ? 1 : ca / ia, sy = ca > ia ? ia / ca : 1; // cover
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texBg);
      p.i('uType', 2).i('uTex', 0).f('uTexScale', sx, sy).f('uTexOffset', (1 - sx) / 2, (1 - sy) / 2);
    } else {
      p.i('uType', 0).f('uC0', 0.08, 0.08, 0.1);
    }
    this.fullscreen();
  }

  private drawCamera(project: Project, scene: SceneState, src: FrameSources, base: number): void {
    const gl = this.gl;
    const layer = scene.cameraLayer!;
    const r = layer.rect;
    const cs = project.camera;
    if (src.camera) upload(gl, this.texCamera, src.camera, false, false);
    const cw = src.cameraSize?.w ?? 16, ch = src.cameraSize?.h ?? 9;
    // cover-fit the (optionally cropped) camera into the layer rect
    const uc = cs.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const srcAspect = (cw * uc.w) / (ch * uc.h);
    const dstAspect = r.w / r.h;
    let cx = uc.x, cy = uc.y, cwid = uc.w, chei = uc.h;
    if (srcAspect > dstAspect) {
      const nw = uc.w * (dstAspect / srcAspect);
      cx = uc.x + (uc.w - nw) / 2;
      cwid = nw;
    } else {
      const nh = uc.h * (srcAspect / dstAspect);
      cy = uc.y + (uc.h - nh) / 2;
      chei = nh;
    }
    const radius = layer.roundness * Math.min(r.w, r.h) * 0.5;
    // shadow
    const blur = 24 * base;
    this.shadow.use().m4('uMVP', this.orthoMVP()).f('uSize', r.w + blur * 4, r.h + blur * 4).f('uBox', r.w / 2, r.h / 2).f('uRadius', radius).f('uBlur', blur).f('uAlpha', 0.45 * layer.alpha).f('uOffset', 0, blur * 0.3);
    this.quad(this.rect(r.x - blur * 2, r.y - blur * 2, r.w + blur * 4, r.h + blur * 4));
    const filter = CAMERA_FILTERS.find((f) => f.id === cs.filterId) ?? CAMERA_FILTERS[0]!;
    const mode = { original: 0, remove: 1, blur: 2, image: 3, color: 4 }[cs.background.mode];
    const hasMask = Boolean(src.cameraMask);
    if (src.cameraMask) upload(gl, this.texMask, src.cameraMask, false, false);
    if (src.cameraBgImage && src.cameraBgImage !== this.lastCamBgImage) {
      upload(gl, this.texCamBg, src.cameraBgImage, false, false);
      this.lastCamBgImage = src.cameraBgImage;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texCamera);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texCamBg);
    const bgc = cs.background.mode === 'color' ? hexToRgb(cs.background.value ?? '#00b140') : ([0, 0, 0] as [number, number, number]);
    this.camera.use().m4('uMVP', this.orthoMVP()).i('uTex', 0).i('uMask', 1).i('uBgTex', 2)
      .f('uHasMask', hasMask ? 1 : 0)
      .f('uCrop', cx, cy, cwid, chei)
      .f('uSize', r.w, r.h)
      .f('uRadius', radius)
      .f('uBorder', cs.border.width * base)
      .f('uBorderColor', ...hexToRgb(cs.border.color))
      .f('uMirror', cs.mirror !== cs.flipH ? 1 : 0)
      .f('uFlipV', cs.flipV ? 1 : 0)
      .m4('uColorM', filter.m)
      .f('uColorO', filter.o[0], filter.o[1], filter.o[2], 0)
      .i('uBgMode', mode)
      .f('uBgColor', ...bgc)
      .f('uBgBlur', cs.background.blur ?? 0.5)
      .f('uBeauty', cs.beauty.enabled ? cs.beauty.intensity : 0)
      .f('uTexel', 1 / cw, 1 / ch)
      .f('uAlpha', layer.alpha);
    this.quad(this.rect(r.x, r.y, r.w, r.h));
    gl.activeTexture(gl.TEXTURE0);
  }

  private drawClicks(project: Project, scene: SceneState, mvp: M4, stageSize: { w: number; h: number }): void {
    if (!scene.clicks.length) return;
    const eff = CLICK_EFFECTS.find((e) => e.id === project.cursor.clickEffect.id);
    if (!eff) return;
    const rpx = 30 * project.cursor.size; // source px
    const srcW = project.source.width * (project.canvas.crop?.w ?? 1);
    const srcH = project.source.height * (project.canvas.crop?.h ?? 1);
    const ru = rpx / srcW, rv = rpx / srcH;
    void stageSize;
    const col = hexToRgb(project.cursor.clickEffect.color);
    for (const c of scene.clicks) {
      const s = c.button === 'right' ? 0.8 : 1;
      this.click.use().m4('uMVP', mvp).i('uStyle', eff.style).f('uP', Math.min(1, c.progress)).f('uColor', ...(c.button === 'right' ? ([1, 0.6, 0.2] as [number, number, number]) : col));
      this.quad([c.x - ru * s, c.y - rv * s, c.x + ru * s, c.y - rv * s, c.x - ru * s, c.y + rv * s, c.x + ru * s, c.y + rv * s]);
    }
  }

  private drawCursor(project: Project, scene: SceneState, mvp: M4, _stageSize: { w: number; h: number }): void {
    const cur = scene.cursor;
    if (!cur) return;
    let sprite: CursorSprite | undefined;
    if (project.cursor.custom && this.importedCursor) sprite = { ...this.importedCursor.sprite, hot: project.cursor.custom.hotspot };
    else if (cur.shape >= 100) sprite = this.customCursors.get(cur.shape);
    if (!sprite) {
      const shape = (SHAPES[cur.shape] ?? 'arrow') as ShapeName;
      const key = this.cursorKey(project.cursor.styleId, project.cursor.color, shape);
      const c = this.cursorCache.get(key);
      if (c === undefined) void this.loadCursor(project.cursor.styleId, project.cursor.color, shape);
      if (c && c !== 'loading') sprite = c;
      else {
        const fb = this.cursorCache.get(this.cursorKey(project.cursor.styleId, project.cursor.color, 'arrow'));
        if (fb && fb !== 'loading') sprite = fb;
      }
    }
    if (!sprite) return;
    const srcW = project.source.width * (project.canvas.crop?.w ?? 1);
    const srcH = project.source.height * (project.canvas.crop?.h ?? 1);
    // procedural sprites live in a 32-unit box; captured app cursors are 64 px bitmaps at native size
    const hide = project.cursor.hideWhenIdle;
    const scaleAnim = hide.enabled && hide.animation === 'scale';
    const vis = scaleAnim ? Math.min(1, cur.visibility * 4) : cur.visibility; // scale mode stays opaque while shrinking
    const baseSize = project.cursor.custom && this.importedCursor ? project.cursor.custom.size * project.cursor.size : sprite.box === 32 ? 32 * project.cursor.size : (sprite.box * project.cursor.size) / 1.5;
    const sizePx = baseSize * (scaleAnim ? Math.max(0.05, cur.visibility) : 1);
    const k = sizePx / sprite.box; // source px per sprite unit
    const hx = sprite.hot[0] * k, hy = sprite.hot[1] * k;
    const ang = (cur.rotation * Math.PI) / 180;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const corner = (x: number, y: number, ox: number, oy: number) => {
      // rotate around the hotspot in source px, then convert to uv
      const dx = x - hx, dy = y - hy;
      return [(ox * srcW + dx * ca - dy * sa) / srcW, (oy * srcH + dx * sa + dy * ca) / srcH];
    };
    const draw = (x: number, y: number, alpha: number) => {
      const p0 = corner(0, 0, x, y), p1 = corner(sizePx, 0, x, y), p2 = corner(0, sizePx, x, y), p3 = corner(sizePx, sizePx, x, y);
      this.gl.activeTexture(this.gl.TEXTURE0);
      this.gl.bindTexture(this.gl.TEXTURE_2D, sprite!.tex);
      this.sprite.use().m4('uMVP', mvp).i('uTex', 0).f('uAlpha', alpha).f('uTint', 0, 0, 0, 0);
      this.quad([...p0, ...p1, ...p2, ...p3]);
    };
    const mb = project.animation.motionBlur;
    const dist = Math.hypot((cur.x - cur.prevX) * srcW, (cur.y - cur.prevY) * srcH);
    if (mb.enabled && mb.cursor > 0 && dist > 2) {
      const n = Math.min(10, Math.max(3, Math.round(dist / 6)));
      for (let i = n - 1; i >= 0; i--) {
        const t = i / (n - 1);
        draw(lerp(cur.x, cur.prevX, t), lerp(cur.y, cur.prevY, t), (vis * (1 - t * 0.85)) / (i === 0 ? 1 : n * 0.45));
      }
    } else draw(cur.x, cur.y, vis);
  }

  private collectMasks(scene: SceneState, mvp: M4): { count: number; rect: Float32Array; param: Float32Array; param2: Float32Array; color: Float32Array; rot: Float32Array } {
    const rect = new Float32Array(MAX_MASKS * 4), param = new Float32Array(MAX_MASKS * 4), param2 = new Float32Array(MAX_MASKS * 4), color = new Float32Array(MAX_MASKS * 3), rot = new Float32Array(MAX_MASKS);
    let n = 0;
    for (const inst of scene.annotations) {
      if (n >= MAX_MASKS) break;
      const a = inst.a as Annotation;
      if (a.type !== 'blur' && a.type !== 'spotlight' && a.type !== 'magnifier' && a.type !== 'callout') continue;
      let r = this.annotationRectPx(a, mvp);
      const k = inst.appear;
      // same in/out motion as text & shapes (overlay animTransform): scale from 60 %, slide up 40 % of height
      const kind = inst.phase === 'out' ? a.anim.out : a.anim.in;
      if (k < 1 && (kind === 'scale' || kind === 'slide')) {
        const e = 1 - (1 - k) ** 3;
        if (kind === 'scale') {
          const f = 0.6 + 0.4 * e, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          r = { x: cx - (r.w * f) / 2, y: cy - (r.h * f) / 2, w: r.w * f, h: r.h * f };
        } else r = { ...r, y: r.y + (1 - e) * r.h * 0.4 };
      }
      rect.set([r.x, r.y, r.w, r.h], n * 4);
      rot[n] = ((a.rotation ?? 0) * Math.PI) / 180;
      if (a.type === 'blur') param.set([1, a.intensity * k, a.softness, a.pixelate ? 1 : 0], n * 4);
      else if (a.type === 'spotlight') param.set([2, a.opacity * k, a.feather, a.softness], n * 4);
      else if (a.type === 'magnifier') {
        param.set([3, 1 + (a.scale - 1) * k, 0, 0], n * 4);
        color.set(hexToRgb(a.border), n * 3);
      } else {
        param.set([4, 1 + (a.scale - 1) * k, 0, 0], n * 4);
        param2.set([a.popout ? 1 + 0.15 * k : 1, a.roundness, a.maskOpacity * k, a.marquee ? (scene.tOut * 2) % 1 + 0.001 : 0], n * 4);
        color.set(hexToRgb(a.color), n * 3);
      }
      n++;
    }
    return { count: n, rect, param, param2, color, rot };
  }

  /** Annotation rect in canvas px: content-space rects follow zoom/pan/3D (bounding box of projected corners). */
  annotationRectPx(a: Annotation, mvp: M4): { x: number; y: number; w: number; h: number } {
    if (a.space === 'canvas') return { x: a.rect.x * this.width, y: a.rect.y * this.height, w: a.rect.w * this.width, h: a.rect.h * this.height };
    const pts = [this.uvToCanvas(mvp, a.rect.x, a.rect.y), this.uvToCanvas(mvp, a.rect.x + a.rect.w, a.rect.y), this.uvToCanvas(mvp, a.rect.x, a.rect.y + a.rect.h), this.uvToCanvas(mvp, a.rect.x + a.rect.w, a.rect.y + a.rect.h)];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  /** Read back the current frame (golden tests / thumbnails). */
  readPixels(): Uint8Array {
    const px = new Uint8Array(this.width * this.height * 4);
    this.gl.readPixels(0, 0, this.width, this.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
    return px;
  }

  dispose(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}

/** Width of any texture source (video element, VideoFrame, bitmap, canvas); 0 = not ready. */
export function sourceWidth(s: TexImageSource | null | undefined): number {
  if (!s) return 0;
  const o = s as { videoWidth?: number; displayWidth?: number; width?: number };
  return o.videoWidth || o.displayWidth || o.width || 0;
}

export function sourceHeight(s: TexImageSource | null | undefined): number {
  if (!s) return 0;
  const o = s as { videoHeight?: number; displayHeight?: number; height?: number };
  return o.videoHeight || o.displayHeight || o.height || 0;
}

async function rasterSvg(blob: Blob, size: number): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(size, size);
    img.src = url;
    await img.decode();
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0, size, size);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

void ident;
