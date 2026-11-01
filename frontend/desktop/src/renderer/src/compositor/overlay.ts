/**
 * 2D overlay layer (Canvas 2D → texture): text & shape annotations (ANN-01/02/08), captions (CAP-05),
 * keyboard-shortcut overlay (KEY-02/03), image watermark (WM-01/02) and the free-tier app watermark (ACC-05).
 * Content-space annotations are positioned through the stage MVP so they follow zoom / pan / 3D.
 */
import type { Annotation, CaptionStyle, Project, SceneState } from '@rec/shared';
import type { Compositor } from './Compositor';
import { DEVICE_FRAMES } from '../editor/deviceFrames';

export interface OverlayAssets {
  watermark?: CanvasImageSource | null;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function animTransform(ctx: Ctx, kind: 'none' | 'fade' | 'scale' | 'slide', k: number, cx: number, cy: number, h: number): number {
  if (k >= 1 || kind === 'none') return 1;
  const e = 1 - (1 - k) ** 3;
  if (kind === 'scale') {
    ctx.translate(cx, cy);
    ctx.scale(0.6 + 0.4 * e, 0.6 + 0.4 * e);
    ctx.translate(-cx, -cy);
    return e;
  }
  if (kind === 'slide') {
    ctx.translate(0, (1 - e) * h * 0.4);
    return e;
  }
  return e; // fade
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawText(ctx: Ctx, a: Extract<Annotation, { type: 'text' }>, r: { x: number; y: number; w: number; h: number }, scale: number): void {
  const s = a.style;
  const size = s.size * scale;
  ctx.font = `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : '500 '}${size}px ${s.font}, Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = s.align;
  const lines = a.text.split('\n');
  const lh = size * 1.25;
  const x = s.align === 'left' ? r.x : s.align === 'right' ? r.x + r.w : r.x + r.w / 2;
  const y0 = r.y + r.h / 2 - ((lines.length - 1) * lh) / 2;
  if (s.preset === 'pill') {
    const widths = lines.map((l) => ctx.measureText(l).width);
    const w = Math.max(...widths) + size * 1.2;
    const h = lines.length * lh + size * 0.5;
    ctx.fillStyle = s.bg ?? '#111111';
    roundRect(ctx, (s.align === 'center' ? x - w / 2 : s.align === 'left' ? x - size * 0.6 : x - w + size * 0.6), y0 - lh / 2 - size * 0.25, w, h, h / 2);
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const y = y0 + i * lh;
    if (s.preset === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size * 0.25;
      ctx.shadowOffsetY = size * 0.06;
    }
    if (s.preset === 'outline') {
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.strokeStyle = s.color2 ?? '#000000';
      ctx.lineJoin = 'round';
      ctx.strokeText(line, x, y);
    }
    if (s.preset === 'gradient') {
      const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
      g.addColorStop(0, s.color);
      g.addColorStop(1, s.color2 ?? '#7c5cff');
      ctx.fillStyle = g;
    } else ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (s.underline) {
      const w = ctx.measureText(line).width;
      const ux = s.align === 'left' ? x : s.align === 'right' ? x - w : x - w / 2;
      ctx.fillRect(ux, y + size * 0.55, w, Math.max(1, size * 0.06));
    }
  });
}

function drawShape(ctx: Ctx, a: Extract<Annotation, { type: 'shape' }>, r: { x: number; y: number; w: number; h: number }, scale: number): void {
  const s = a.style;
  ctx.globalAlpha *= s.opacity;
  ctx.lineWidth = s.strokeWidth * scale;
  ctx.strokeStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (a.shape === 'rect') {
    roundRect(ctx, r.x, r.y, r.w, r.h, s.cornerRadius * scale);
    if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
    if (s.strokeWidth > 0) ctx.stroke();
  } else if (a.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
    if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
    if (s.strokeWidth > 0) ctx.stroke();
  } else if (a.shape === 'highlight') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = s.fill ?? s.color;
    roundRect(ctx, r.x, r.y, r.w, r.h, s.cornerRadius * scale);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  } else {
    // arrow / line from top-left → bottom-right of rect (rect may be "negative" via rotation instead)
    const x0 = r.x, y0 = r.y + r.h, x1 = r.x + r.w, y1 = r.y;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    if (s.curved) ctx.quadraticCurveTo(x0 + (x1 - x0) * 0.1, y1 + (y0 - y1) * 0.1, x1, y1);
    else ctx.lineTo(x1, y1);
    ctx.stroke();
    if (a.shape === 'arrow' && s.head !== 'none') {
      const ang = s.curved ? Math.atan2(y1 - (y1 + (y0 - y1) * 0.1), x1 - (x0 + (x1 - x0) * 0.1)) : Math.atan2(y1 - y0, x1 - x0);
      const hl = Math.max(10, s.strokeWidth * 3.5) * scale;
      if (s.head === 'dot') {
        ctx.beginPath();
        ctx.arc(x1, y1, hl * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - hl * Math.cos(ang - 0.45), y1 - hl * Math.sin(ang - 0.45));
        if (s.head === 'triangle') ctx.lineTo(x1 - hl * Math.cos(ang + 0.45), y1 - hl * Math.sin(ang + 0.45));
        else { ctx.moveTo(x1, y1); ctx.lineTo(x1 - hl * Math.cos(ang + 0.45), y1 - hl * Math.sin(ang + 0.45)); }
        ctx.closePath();
        if (s.head === 'triangle') { ctx.fillStyle = s.color; ctx.fill(); } else ctx.stroke();
      }
    }
  }
}

function drawCaption(ctx: Ctx, W: number, H: number, scene: SceneState, style: CaptionStyle, scale: number): void {
  const cap = scene.caption;
  if (!cap) return;
  const size = style.size * scale;
  ctx.font = `700 ${size}px ${style.font}, Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lines = cap.block.text.split('\n');
  const lh = size * style.spacing;
  const baseY = H * (1 - style.position) - (lines.length * lh) / 2 - size * 0.4;
  const highlight = style.styleId.startsWith('highlight') && cap.block.words && cap.word >= 0;
  let wordIdx = 0;
  lines.forEach((line, li) => {
    const words = line.split(/(\s+)/);
    const w = ctx.measureText(line).width;
    let x = W / 2 - w / 2;
    const y = baseY + li * lh;
    if (style.styleId === 'boxed') {
      ctx.fillStyle = style.bgColor ?? 'rgba(0,0,0,0.65)';
      roundRect(ctx, x - size * 0.4, y - lh / 2, w + size * 0.8, lh, size * 0.25);
      ctx.fill();
    }
    for (const word of words) {
      const ww = ctx.measureText(word).width;
      if (!word.trim()) { x += ww; continue; }
      const active = highlight && wordIdx === cap.word;
      wordIdx++;
      ctx.save();
      if (active && style.styleId === 'highlight-pop') {
        ctx.translate(x + ww / 2, y);
        ctx.scale(1.15, 1.15);
        ctx.translate(-(x + ww / 2), -y);
      }
      if (active && style.styleId === 'highlight-color') {
        ctx.globalAlpha = style.highlightOpacity;
        ctx.fillStyle = style.highlightColor;
        roundRect(ctx, x - size * 0.12, y - size * 0.62, ww + size * 0.24, size * 1.24, size * 0.2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (style.shadow.opacity > 0 && style.shadow.size > 0) {
        ctx.shadowColor = hexA(style.shadow.color, style.shadow.opacity);
        ctx.shadowBlur = style.shadow.size * scale;
        ctx.shadowOffsetX = style.shadow.x * scale;
        ctx.shadowOffsetY = style.shadow.y * scale;
      }
      if (style.strokeWidth > 0 && style.styleId !== 'minimal') {
        ctx.lineWidth = style.strokeWidth * 2 * scale;
        ctx.strokeStyle = style.strokeColor;
        ctx.lineJoin = 'round';
        ctx.strokeText(word, x, y);
      }
      ctx.fillStyle = active && style.styleId === 'highlight-pop' ? style.highlightColor : style.wordColor;
      ctx.fillText(word, x, y);
      ctx.restore();
      x += ww;
    }
  });
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

const KEY_STYLES: Record<string, { radius: number; border: boolean; font: string }> = {
  dark: { radius: 0.25, border: false, font: '600' },
  light: { radius: 0.25, border: true, font: '600' },
  pill: { radius: 0.5, border: false, font: '700' },
  keycap: { radius: 0.15, border: true, font: '700' },
};

function drawKeys(ctx: Ctx, W: number, H: number, project: Project, scene: SceneState, scale: number): void {
  if (!scene.keys.length) return;
  const k = project.keys;
  const style = KEY_STYLES[k.styleId] ?? KEY_STYLES.dark!;
  const size = 30 * k.size * scale;
  ctx.font = `${style.font} ${size}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const pad = size * 0.5;
  const rows = scene.keys.map(({ ev, alpha }) => {
    const caps = ev.label.map((l) => ({ l, w: Math.max(size * 1.4, ctx.measureText(l).width + pad * 1.6) }));
    const width = caps.reduce((a, c) => a + c.w, 0) + (caps.length - 1) * size * 0.9;
    return { caps, width, alpha };
  });
  const capH = size * 1.7;
  let ax: number, ay: number;
  if (typeof k.position === 'object') { ax = k.position.x * W; ay = k.position.y * H; }
  else {
    ay = k.position.startsWith('top') ? H * 0.1 : H * 0.86;
    ax = k.position.endsWith('left') ? W * 0.18 : k.position.endsWith('right') ? W * 0.82 : W / 2;
  }
  rows.forEach((row, ri) => {
    let x = ax - row.width / 2;
    const y = ay - (rows.length - 1 - ri) * (capH + size * 0.4);
    ctx.globalAlpha = row.alpha;
    row.caps.forEach((c, i) => {
      ctx.fillStyle = hexA(k.bgColor, k.bgOpacity);
      roundRect(ctx, x, y - capH / 2, c.w, capH, capH * style.radius);
      ctx.fill();
      if (style.border) {
        ctx.lineWidth = Math.max(1, size * 0.06);
        ctx.strokeStyle = hexA(k.fontColor, 0.35);
        ctx.stroke();
      }
      ctx.fillStyle = k.fontColor;
      ctx.fillText(c.l, x + c.w / 2, y + size * 0.03);
      x += c.w;
      if (i < row.caps.length - 1) {
        ctx.fillStyle = hexA(k.fontColor, 0.8);
        ctx.fillText('+', x + size * 0.45, y);
        x += size * 0.9;
      }
    });
    ctx.globalAlpha = 1;
  });
}

/** Device frame (STY-05): bezel ring around the (transformed) stage + camera cutout. Original vector art. */
function drawDeviceFrame(ctx: Ctx, project: Project, scene: SceneState, comp: Compositor): boolean {
  const f = DEVICE_FRAMES.find((d) => d.id === project.canvas.deviceFrame);
  if (!f) return false;
  const mvp = comp.stageMVP(scene);
  const a = comp.uvToCanvas(mvp, 0, 0), b = comp.uvToCanvas(mvp, 1, 1);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  const s = Math.min(w, h);
  const bez = f.bezel * s, R = f.corner * s, r = f.screenCorner * s;
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, x - bez, y - bez, w + bez * 2, h + bez * 2, R);
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = f.color;
  ctx.fill('evenodd');
  ctx.lineWidth = Math.max(1, s * 0.006);
  ctx.strokeStyle = f.edge;
  roundRect(ctx, x - bez, y - bez, w + bez * 2, h + bez * 2, R);
  ctx.stroke();
  const portrait = h >= w;
  ctx.fillStyle = '#000';
  if (f.cutout === 'island') { const iw = s * 0.28, ih = s * 0.07; roundRect(ctx, portrait ? x + w / 2 - iw / 2 : x + s * 0.03, portrait ? y + s * 0.03 : y + h / 2 - iw / 2, portrait ? iw : ih, portrait ? ih : iw, ih / 2); ctx.fill(); }
  else if (f.cutout === 'notch') { const nw = s * 0.45, nh = s * 0.06; roundRect(ctx, portrait ? x + w / 2 - nw / 2 : x - 1, portrait ? y - 1 : y + h / 2 - nw / 2, portrait ? nw : nh, portrait ? nh : nw, nh * 0.6); ctx.fill(); }
  else if (f.cutout === 'punch') { ctx.beginPath(); ctx.arc(portrait ? x + w / 2 : x + s * 0.05, portrait ? y + s * 0.05 : y + h / 2, s * 0.022, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  return true;
}

/** Draw the full overlay for one frame. Returns true if anything was drawn. */
export function drawOverlay(ctx: Ctx, project: Project, scene: SceneState, comp: Compositor, assets: OverlayAssets): boolean {
  const W = comp.width, H = comp.height;
  ctx.clearRect(0, 0, W, H);
  const scale = Math.min(W, H) / 1080;
  const mvp = comp.stageMVP(scene);
  let drew = project.canvas.deviceFrame ? drawDeviceFrame(ctx, project, scene, comp) : false;
  for (const inst of scene.annotations) {
    const a = inst.a;
    if (a.type !== 'text' && a.type !== 'shape') continue;
    const r = comp.annotationRectPx(a, mvp);
    const zoomScale = a.space === 'content' ? r.w / Math.max(1, a.rect.w * scene.stage.w) : 1;
    ctx.save();
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    if (a.rotation) {
      ctx.translate(cx, cy);
      ctx.rotate((a.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    const kind = inst.phase === 'out' ? a.anim.out : a.anim.in;
    const alpha = animTransform(ctx, kind, inst.appear, cx, cy, r.h);
    ctx.globalAlpha = kind === 'fade' || kind === 'scale' || kind === 'slide' ? alpha : 1;
    if (a.type === 'text') drawText(ctx, a, r, scale * zoomScale);
    else drawShape(ctx, a, r, scale * zoomScale);
    ctx.restore();
    drew = true;
  }
  if (project.captions?.enabled && scene.caption) {
    drawCaption(ctx, W, H, scene, project.captions.style, scale);
    drew = true;
  }
  if (scene.keys.length) {
    drawKeys(ctx, W, H, project, scene, scale);
    drew = true;
  }
  const wm = project.watermark;
  if (wm?.visible && wm.text) {
    const size = Math.max(10, wm.scale * W * 0.25);
    ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = wm.opacity;
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(wm.text, wm.x * W, wm.y * H);
    ctx.fillStyle = wm.color ?? '#ffffff';
    ctx.fillText(wm.text, wm.x * W, wm.y * H);
    ctx.globalAlpha = 1;
    drew = true;
  } else if (wm?.visible && assets.watermark) {
    const img = assets.watermark as { width: number; height: number };
    const w = W * wm.scale;
    const h = (w * img.height) / Math.max(1, img.width);
    ctx.globalAlpha = wm.opacity;
    ctx.drawImage(assets.watermark, wm.x * W - w / 2, wm.y * H - h / 2, w, h);
    ctx.globalAlpha = 1;
    drew = true;
  }
  return drew;
}
