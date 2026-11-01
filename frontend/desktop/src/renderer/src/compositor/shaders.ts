/**
 * GLSL ES 3.00 shaders for the compositor (plan §3, §6.1, §6.7, §6.8, §6.10).
 * Conventions: positions are given in "uv space" of a quad and mapped by uMVP to clip space,
 * so the same matrix drives 2D zoom/pan and 3D motion. SDFs are evaluated in local pixels.
 */

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Background: 0 color, 1 linear gradient (3 stops), 2 image (cover, mip blur), 3 procedural wallpaper. */
export const BG_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform int uType;
uniform vec3 uC0, uC1, uC2;
uniform float uAngle;
uniform sampler2D uTex;
uniform vec2 uTexScale, uTexOffset;
uniform float uBlur;
uniform int uPattern;
uniform vec2 uRes;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
vec3 grad3(float t) { return t < 0.5 ? mix(uC0, uC1, t * 2.0) : mix(uC1, uC2, t * 2.0 - 1.0); }
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  if (uType == 0) { o = vec4(uC0, 1.0); return; }
  if (uType == 1) {
    vec2 d = vec2(cos(uAngle), sin(uAngle));
    float t = clamp(dot(uv - 0.5, d) + 0.5, 0.0, 1.0);
    o = vec4(grad3(t), 1.0);
    return;
  }
  if (uType == 2) {
    o = textureLod(uTex, uv * uTexScale + uTexOffset, uBlur * 7.0);
    return;
  }
  // procedural wallpapers (own artwork, resolution independent)
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  float soft = 1.0 + uBlur * 3.0;
  vec3 col;
  if (uPattern == 0) { // aurora blobs
    float n = noise(p * 2.0 / soft) * 0.6 + noise(p * 4.5 / soft + 3.1) * 0.4;
    col = grad3(clamp(uv.y * 0.7 + n * 0.6 - 0.15, 0.0, 1.0));
  } else if (uPattern == 1) { // soft waves
    float w = sin((p.x * 3.0 + sin(p.y * 4.0) * 0.6) / soft) * 0.5 + 0.5;
    col = grad3(clamp(mix(uv.y, w, 0.45), 0.0, 1.0));
  } else if (uPattern == 2) { // radial glow
    float r = length(uv - vec2(0.3, 0.25));
    col = grad3(clamp(r * 1.2, 0.0, 1.0));
  } else if (uPattern == 3) { // diagonal bands
    float b = fract((p.x + p.y) * 2.5 / soft);
    col = grad3(clamp(uv.x * 0.6 + smoothstep(0.0, 1.0, b) * 0.35, 0.0, 1.0));
  } else { // dunes
    float h = noise(vec2(p.x * 1.5, 0.0) / soft) * 0.25;
    col = grad3(clamp(uv.y + h - 0.1, 0.0, 1.0));
  }
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // dither: no banding in exports
  o = vec4(col, 1.0);
}`;

/** Generic quad in uv space mapped through uMVP. */
export const QUAD_VS = /* glsl */ `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform mat4 uMVP;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uMVP * vec4(aPos, 0.0, 1.0);
}`;

/**
 * Stage (screen recording): rounded rect (SDF in local px), inset, crop, motion blur along the
 * zoom/pan velocity (§6.7) and an optional clip rect (vertical fill).
 */
export const STAGE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec4 uCrop;        // x,y,w,h in texture uv
uniform vec2 uSize;        // quad size in px (pre-3D)
uniform float uRadius;     // px
uniform float uInset;      // fraction
uniform vec3 uInsetColor;
uniform vec2 uCam;         // current cx, cy
uniform float uZRatio;     // z / zPrev
uniform vec2 uPanDelta;    // cPrev - c
uniform float uWZoom, uWPan;
uniform int uTaps;
uniform vec4 uClip;        // canvas px x,y,w,h (w<=0 → no clip)
uniform float uClipRadius;
uniform float uCanvasH;
uniform float uHasTex;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec4 sampleContent(vec2 uv) {
  // inset: content shrinks inside the frame
  vec2 c = (uv - 0.5) / max(1.0 - 2.0 * uInset, 0.01) + 0.5;
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0) return vec4(uInsetColor, 1.0);
  if (uHasTex < 0.5) return vec4(0.12, 0.12, 0.16, 1.0);
  return texture(uTex, uCrop.xy + c * uCrop.zw);
}
void main() {
  vec2 lp = (vUv - 0.5) * uSize;
  float d = sdBox(lp, uSize * 0.5, min(uRadius, min(uSize.x, uSize.y) * 0.5));
  float aa = max(fwidth(d), 0.75);
  float a = 1.0 - smoothstep(-aa, aa, d);
  if (uClip.z > 0.0) {
    vec2 fc = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y);
    float dc = sdBox(fc - (uClip.xy + uClip.zw * 0.5), uClip.zw * 0.5, uClipRadius);
    a *= 1.0 - smoothstep(-0.75, 0.75, dc);
  }
  if (a <= 0.0) discard;
  vec4 col;
  if (uTaps > 1 && (uWZoom > 0.0 || uWPan > 0.0)) {
    vec2 uvZ = uCam + (vUv - uCam) * uZRatio;
    vec2 uvP = vUv + uPanDelta;
    vec2 uvPrev = vUv + uWZoom * (uvZ - vUv) + uWPan * (uvP - vUv);
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 32; i++) {
      if (i >= uTaps) break;
      float t = float(i) / float(uTaps - 1);
      acc += sampleContent(mix(vUv, uvPrev, t));
    }
    col = acc / float(uTaps);
  } else {
    col = sampleContent(vUv);
  }
  o = vec4(col.rgb, 1.0) * a;
}`;

/** Soft shadow of a rounded rect: quad expanded by the blur radius. */
export const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uSize;     // expanded quad size in px
uniform vec2 uBox;      // box half-size
uniform float uRadius, uBlur, uAlpha;
uniform vec2 uOffset;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 lp = (vUv - 0.5) * uSize - uOffset;
  float d = sdBox(lp, uBox, uRadius);
  float a = uAlpha * (1.0 - smoothstep(-uBlur * 0.6, uBlur, d));
  o = vec4(0.0, 0.0, 0.0, 1.0) * a;
}`;

/** Textured sprite (cursor, watermark, overlay) with tint + alpha. Premultiplied output. */
export const SPRITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uAlpha;
uniform vec4 uTint;  // rgb, amount
void main() {
  vec4 c = texture(uTex, vUv);
  c.rgb = mix(c.rgb, uTint.rgb * c.a, uTint.a * step(0.5, c.a));
  o = c * uAlpha;
}`;

/** Click effects (CUR-05): 8 procedural styles, progress 0..1. */
export const CLICK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform int uStyle;
uniform float uP;
uniform vec3 uColor;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float e = 1.0 - pow(1.0 - uP, 3.0);
  float fade = 1.0 - uP;
  float a = 0.0;
  if (uStyle == 0) { a = smoothstep(0.08, 0.0, abs(r - e * 0.9)) * fade; }                         // ripple ring
  else if (uStyle == 1) { a = smoothstep(e * 0.9, e * 0.9 - 0.05, r) * 0.45 * fade; }             // filled pulse
  else if (uStyle == 2) { a = (smoothstep(0.06, 0.0, abs(r - e * 0.9)) + smoothstep(0.06, 0.0, abs(r - e * 0.55))) * fade; } // double ripple
  else if (uStyle == 3) { a = exp(-pow((r - e * 0.6) * 5.0, 2.0)) * 0.8 * fade; }                // halo
  else if (uStyle == 4) {                                                                          // burst
    float ang = atan(p.y, p.x);
    float rays = smoothstep(0.75, 1.0, cos(ang * 8.0));
    a = rays * smoothstep(0.1, 0.0, abs(r - (0.3 + e * 0.6))) * fade * 1.5;
  }
  else if (uStyle == 5) { vec2 q = abs(p); float s = max(q.x, q.y); a = smoothstep(0.07, 0.0, abs(s - e * 0.85)) * fade; } // square ripple
  else if (uStyle == 6) { a = smoothstep(0.22, 0.18, r) * fade; }                                  // dot
  else { float s = 0.35 * (1.0 - 0.3 * sin(uP * 3.14159)); a = smoothstep(s, s - 0.05, r) * 0.6 * fade; } // press squash
  a = clamp(a, 0.0, 1.0);
  o = vec4(uColor * a, a);
}`;

/**
 * Camera layer: cover-fit + crop, mirror, rounded/circle mask, border, color filter matrix,
 * background modes using a person mask (alpha from segmentation): 0 original, 1 remove, 2 blur, 3 image, 4 color.
 */
export const CAMERA_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform sampler2D uBgTex;
uniform float uHasMask;
uniform vec4 uCrop;
uniform vec2 uSize;
uniform float uRadius;
uniform float uBorder;
uniform vec3 uBorderColor;
uniform float uMirror;
uniform float uFlipV;
uniform mat4 uColorM;
uniform vec4 uColorO;
uniform int uBgMode;
uniform vec3 uBgColor;
uniform float uBgBlur;
uniform float uBeauty;
uniform vec2 uTexel;
uniform float uAlpha;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// Soft skin likelihood from chroma (YCbCr skin cluster, Cb 77–127 / Cr 133–173 on a 0–255 scale): smoothing
// is confined to skin so eyes, hair, glasses, background and on-screen text stay sharp. Inside a person
// matte (background removal on) it is further limited to the person.
float skinMask(vec3 c, vec2 uv) {
  float cb = 128.0 - 37.797 * c.r - 74.203 * c.g + 112.0 * c.b;
  float cr = 128.0 + 112.0 * c.r - 93.786 * c.g - 18.214 * c.b;
  float m = smoothstep(70.0, 82.0, cb) * (1.0 - smoothstep(122.0, 134.0, cb))
          * smoothstep(128.0, 140.0, cr) * (1.0 - smoothstep(168.0, 180.0, cr));
  if (uHasMask > 0.5) m *= smoothstep(0.3, 0.7, texture(uMask, uv).r);
  return m;
}
vec3 beauty(vec2 uv, vec3 c) {
  if (uBeauty <= 0.0) return c;
  float skin = skinMask(c, uv);
  if (skin <= 0.001) return c;
  // edge-preserving smoothing (cheap bilateral, 12 taps) + gentle brightening curve, on skin only
  vec3 acc = c; float wsum = 1.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236;
    vec2 off = vec2(cos(a), sin(a)) * uTexel * (2.0 + 3.0 * uBeauty);
    vec3 s = texture(uTex, uv + off).rgb;
    float w = exp(-dot(s - c, s - c) * 40.0);
    acc += s * w; wsum += w;
  }
  vec3 sm = acc / wsum;
  vec3 outc = mix(c, sm, uBeauty * 0.85);
  outc = pow(outc, vec3(1.0 - 0.18 * uBeauty));
  return mix(c, outc, skin);
}
void main() {
  vec2 lp = (vUv - 0.5) * uSize;
  float d = sdBox(lp, uSize * 0.5, min(uRadius, min(uSize.x, uSize.y) * 0.5));
  float aa = max(fwidth(d), 0.75);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  if (inside <= 0.0) discard;
  vec2 uv = vec2(mix(vUv.x, 1.0 - vUv.x, uMirror), mix(vUv.y, 1.0 - vUv.y, uFlipV));
  vec2 tuv = uCrop.xy + uv * uCrop.zw;
  vec3 c = texture(uTex, tuv).rgb;
  c = beauty(tuv, c);
  c = clamp((uColorM * vec4(c, 1.0)).rgb + uColorO.rgb, 0.0, 1.0);
  float alpha = 1.0;
  if (uBgMode != 0 && uHasMask > 0.5) {
    float m = smoothstep(0.25, 0.75, texture(uMask, tuv).r); // crisp, stable matte edge
    vec3 bg = uBgColor;
    if (uBgMode == 2) {
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 16; i++) {
        float a = float(i) * 0.3927;
        acc += texture(uTex, tuv + vec2(cos(a), sin(a)) * uTexel * (6.0 + 30.0 * uBgBlur) * (float(i % 4) + 1.0) * 0.4).rgb;
      }
      bg = acc / 16.0;
    } else if (uBgMode == 3) bg = texture(uBgTex, vUv).rgb;
    if (uBgMode == 1) alpha = m;
    else c = mix(bg, c, m);
  }
  if (uBorder > 0.0) {
    float b = 1.0 - smoothstep(-aa, aa, d + uBorder);
    c = mix(uBorderColor, c, b);
    alpha = max(alpha, 1.0 - b);
  }
  o = vec4(c, 1.0) * inside * alpha * uAlpha;
}`;

/**
 * Post pass (masks, plan §8.4): spotlight / blur / magnifier / callout over the composed scene.
 * Up to 16 masks; rects in canvas px (already transformed for content-space masks), rotated about their centre.
 */
export const POST_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uScene;
uniform vec2 uRes;
uniform int uCount;
uniform vec4 uRect[16];     // x,y,w,h (px, top-left origin)
uniform vec4 uParam[16];    // type, a, b, c
uniform vec4 uParam2[16];   // d, e, f, g
uniform vec3 uColor[16];
uniform float uRot[16];     // rotation (radians) around the rect centre
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec2 unrotate(vec2 px, vec4 r, float a) {
  vec2 c = r.xy + r.zw * 0.5;
  float cs = cos(-a), sn = sin(-a);
  vec2 d = px - c;
  return c + vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
}
float shape(vec2 px, vec4 r, float soft) {
  // soft: 0 = rectangle, 1 = ellipse
  vec2 c = r.xy + r.zw * 0.5;
  vec2 h = r.zw * 0.5;
  float dr = sdBox(px - c, h, 0.0);
  float de = (length((px - c) / max(h, vec2(1.0))) - 1.0) * min(h.x, h.y);
  return mix(dr, de, soft);
}
vec3 blurAt(vec2 uv, float radius) {
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int x = -4; x <= 4; x++) for (int y = -4; y <= 4; y++) {
    acc += texture(uScene, uv + vec2(float(x), float(y)) * radius / uRes / 4.0).rgb;
    n += 1.0;
  }
  return acc / n;
}
void main() {
  vec2 uv = vUv;
  vec2 px = vec2(uv.x, 1.0 - uv.y) * uRes;
  vec3 col = texture(uScene, uv).rgb;
  // every pixel size below is authored at 1080p and scaled, so a 540p preview matches a 4K export
  float k = min(uRes.x, uRes.y) / 1080.0;
  // spotlights / callout dimming combine into ONE mask (a union of lit areas), so overlapping
  // spotlights don't darken each other's holes
  float dim = 0.0, lit = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uCount) break;
    vec4 r = uRect[i];
    vec4 p = uParam[i];
    vec4 q = uParam2[i];
    int type = int(p.x);
    vec2 lp = unrotate(px, r, uRot[i]);
    if (type == 1) { // blur / mosaic: a=intensity b=softness c=pixelate
      float d = shape(lp, r, p.z);
      float m = 1.0 - smoothstep(-k, k, d);
      if (m > 0.0) {
        vec3 b;
        if (p.w > 0.5) {
          float cell = (4.0 + p.y * 40.0) * k;
          vec2 cpx = (floor(px / cell) + 0.5) * cell;
          b = texture(uScene, vec2(cpx.x, uRes.y - cpx.y) / uRes).rgb;
        } else b = blurAt(uv, (4.0 + p.y * 60.0) * k);
        col = mix(col, b, m);
      }
    } else if (type == 2) { // spotlight: a=opacity b=feather c=softness
      float d = shape(lp, r, p.w);
      float feather = k + p.z * min(r.z, r.w) * 0.5;
      lit = max(lit, 1.0 - smoothstep(-feather * 0.5, feather, d));
      dim = max(dim, p.y);
    } else if (type == 3 || type == 4) { // magnifier (3) / callout (4): a=scale
      vec2 c = r.xy + r.zw * 0.5;
      float scale = p.y;
      float popScale = type == 4 ? q.x : 1.0; // callout pop-out size
      vec4 big = vec4(c - r.zw * 0.5 * popScale, r.zw * popScale);
      float radius = type == 3 ? min(big.z, big.w) * 0.5 : q.y * min(big.z, big.w) * 0.5;
      float d = type == 3 ? length(lp - c) - min(big.z, big.w) * 0.5 : sdBox(lp - c, big.zw * 0.5, radius);
      if (type == 4 && q.z > 0.0) { // dim everything else (joins the shared dim mask)
        lit = max(lit, 1.0 - smoothstep(-k, k, d));
        dim = max(dim, q.z);
      }
      if (type == 4 && popScale > 1.001 && d > 0.0) { // pop-out shadow
        float sh = 1.0 - smoothstep(0.0, 22.0 * k, d - 4.0 * k);
        col = mix(col, col * 0.45, sh * 0.55);
      }
      float m = 1.0 - smoothstep(-k, k, d);
      if (m > 0.0) {
        vec2 spx = c + (px - c) / scale;
        vec3 z = texture(uScene, vec2(spx.x, uRes.y - spx.y) / uRes).rgb;
        col = mix(col, z, m);
        float edge = 1.0 - smoothstep(0.0, 3.0 * k, abs(d + 1.5 * k));
        float dash = type == 4 && q.w > 0.0 ? step(0.5, fract((lp.x + lp.y) / (14.0 * k) - q.w)) : 1.0;
        col = mix(col, uColor[i], edge * dash);
      }
    }
  }
  col = mix(col, col * (1.0 - dim), 1.0 - lit);
  o = vec4(col, 1.0);
}`;

export const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
void main() { o = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)); }`;
