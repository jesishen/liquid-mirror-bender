/**
 * WaterEngine — a thin layer of clear water sitting on top of the screen.
 *
 * Two GPU passes per frame:
 *  1. UPDATE  — wave-equation heightmap (ripples) + a "liquify" displacement
 *               field (the water getting dragged along by a moving finger).
 *               State lives in an RGBA16F texture, ping-ponged each step:
 *                 r = height, g = vertical velocity, ba = drag displacement (uv)
 *  2. RENDER  — samples the camera through the water: surface slope bends
 *               (refracts) the image, drag displacement smears it. Pure
 *               distortion — no tint, highlights or color fringing.
 *
 * Coordinates: every input is in SCREEN uv, 0..1, origin top-left (y down).
 */

export const MAX_INPUTS = 16;

export type WaterInput = {
  x: number; y: number;   // fingertip now (screen uv, y down)
  px: number; py: number; // fingertip last frame
  pulse: number;          // one-frame "drop" → concentric ripples
  press: number;          // continuous push along the motion path → wake
  drag: number;           // how strongly motion smears the water (liquify)
  radius: number;         // fingertip size, in screen-height units
};

export type Crop = { ox: number; oy: number; sx: number; sy: number };

export type WaterSettings = {
  damping: number;     // ripple lifetime (closer to 1 = longer)
  refraction: number;  // how much slope bends the image
  dispDecay: number;   // how fast dragged water settles back
  stepsPerSecond: number; // wave speed — fixed rate, so 60Hz and 120Hz screens match
};

export const DEFAULT_SETTINGS: WaterSettings = {
  damping: 0.965,
  refraction: 1.1,
  dispDecay: 0.93,
  stepsPerSecond: 120,
};

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const UPDATE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outState;

uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uAspect;
uniform float uDamping;
uniform float uDispDecay;
uniform int uCount;
uniform vec4 uA[${MAX_INPUTS}]; // cur.xy, prev.xy (uv, y up)
uniform vec4 uB[${MAX_INPUTS}]; // pulse, press, radius, drag

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec4 s = texture(uState, vUv);
  vec4 l = texture(uState, vUv - vec2(uTexel.x, 0.0));
  vec4 r = texture(uState, vUv + vec2(uTexel.x, 0.0));
  vec4 d = texture(uState, vUv - vec2(0.0, uTexel.y));
  vec4 u = texture(uState, vUv + vec2(0.0, uTexel.y));

  // --- ripples: discrete wave equation
  float avg = (l.r + r.r + u.r + d.r) * 0.25;
  float vel = (s.g + (avg - s.r) * 2.0) * uDamping;
  float h = s.r + vel;

  // --- liquify: diffuse + relax the drag field back to rest
  vec2 disp = mix(s.ba, (l.ba + r.ba + u.ba + d.ba) * 0.25, 0.15) * uDispDecay;

  // --- fingers touching the surface
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  for (int i = 0; i < ${MAX_INPUTS}; i++) {
    if (i >= uCount) break;
    vec2 cur  = vec2(uA[i].x * uAspect, uA[i].y);
    vec2 prev = vec2(uA[i].z * uAspect, uA[i].w);
    float rad = uB[i].z;

    float fCur = exp(-pow(length(p - cur) / rad, 2.0));
    float fSeg = exp(-pow(segDist(p, prev, cur) / rad, 2.0));

    h -= uB[i].x * fCur;        // drop
    h -= uB[i].y * fSeg;        // pushing through the water
    disp += (uA[i].xy - uA[i].zw) * fSeg * uB[i].w; // drag the water along
  }

  float dl = length(disp);
  if (dl > 0.09) disp *= 0.09 / dl;
  h = clamp(h, -4.0, 4.0);

  outState = vec4(h, vel, disp);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uState;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec4 uCrop;     // offset.xy, size.xy — cover-crop of source into screen
uniform float uMirror;
uniform float uRefraction;

void main() {
  float hl = texture(uState, vUv - vec2(uTexel.x, 0.0)).r;
  float hr = texture(uState, vUv + vec2(uTexel.x, 0.0)).r;
  float hd = texture(uState, vUv - vec2(0.0, uTexel.y)).r;
  float hu = texture(uState, vUv + vec2(0.0, uTexel.y)).r;
  vec2 slope = vec2(hr - hl, hu - hd);
  vec2 disp = texture(uState, vUv).ba;

  vec2 uv = clamp(vUv + slope * uRefraction - disp, 0.0, 1.0);
  vec2 src = uCrop.xy + uv * uCrop.zw;
    if (uMirror > 0.5) src.x = 1.0 - src.x;
  vec3 color = texture(uSource, src).rgb;

  // --- very subtle natural light catching the ripples
  const float LIGHT_TILT   = 9.5;   // how much the ripples catch light
  const float SPEC_AMOUNT  = 0.42;  // brightness of the little glints
  const float SHADE_AMOUNT = 0.40;  // soft light/dark on the sides of each ring
  vec3 up = vec3(0.0, 0.0, 1.0);
  vec3 n = normalize(vec3(-slope * LIGHT_TILT, 1.0));
  vec3 L = normalize(vec3(-0.35, 0.55, 1.0));  // soft light from the upper left
  vec3 H = normalize(L + up);
  float spec = max(pow(max(dot(n, H), 0.0), 80.0) - pow(dot(up, H), 80.0), 0.0);
  float shade = dot(n, L) - dot(up, L);        // 0 on calm water
  color += vec3(1.0, 0.98, 0.94) * spec * SPEC_AMOUNT;  // warm-white glint
  color *= 1.0 + shade * SHADE_AMOUNT;
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("Shader error: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, frag: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("Link error: " + gl.getProgramInfoLog(p));
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i)!.name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

/** Same math used for the image AND the hand landmarks, so they always line up. */
export function coverCrop(srcW: number, srcH: number, dstW: number, dstH: number): Crop {
  if (!srcW || !srcH || !dstW || !dstH) return { ox: 0, oy: 0, sx: 1, sy: 1 };
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  let sx = 1, sy = 1;
  if (dstAspect > srcAspect) sy = srcAspect / dstAspect; // screen wider → crop top/bottom
  else sx = dstAspect / srcAspect;                         // screen taller → crop sides
  return { ox: (1 - sx) / 2, oy: (1 - sy) / 2, sx, sy };
}

/** Source-frame normalized point (e.g. a MediaPipe landmark) → screen uv (y down). */
export function sourceToScreen(x: number, y: number, crop: Crop, mirror: boolean) {
  const fx = mirror ? 1 - x : x;
  return { x: (fx - crop.ox) / crop.sx, y: (y - crop.oy) / crop.sy };
}

type Source = HTMLVideoElement | HTMLCanvasElement;

export class WaterEngine {
  readonly canvas: HTMLCanvasElement;
  settings: WaterSettings = { ...DEFAULT_SETTINGS };
  crop: Crop = { ox: 0, oy: 0, sx: 1, sy: 1 };

  private gl: WebGL2RenderingContext;
  private update: ReturnType<typeof program>;
  private render: ReturnType<typeof program>;
  private vao: WebGLVertexArrayObject;
  private texType: number;
  private state: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  private cur = 0;
  private simW = 0;
  private simH = 0;
  private srcTex: WebGLTexture;
  private source: Source | null = null;
  private mirror = true;
  private A = new Float32Array(MAX_INPUTS * 4);
  private B = new Float32Array(MAX_INPUTS * 4);
  private acc = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true, // lets photo/video capture read the canvas any time
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 isn't supported on this browser.");
    this.gl = gl;

    const full = gl.getExtension("EXT_color_buffer_float");
    const half = gl.getExtension("EXT_color_buffer_half_float");
    if (!full && !half) throw new Error("This device can't render float textures.");
    this.texType = gl.HALF_FLOAT;

    this.update = program(gl, UPDATE_FRAG);
    this.render = program(gl, RENDER_FRAG);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.srcTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    this.texParams();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  private texParams() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Call on every layout change. Water resets only if the sim grid changes. */
  resize(cssW: number, cssH: number, dpr: number, simLongSide: number) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const aspect = cssW / cssH;
    const simW = aspect >= 1 ? simLongSide : Math.round(simLongSide * aspect);
    const simH = aspect >= 1 ? Math.round(simLongSide / aspect) : simLongSide;
    if (simW === this.simW && simH === this.simH) return;
    this.simW = simW;
    this.simH = simH;

    const gl = this.gl;
    for (const s of this.state) {
      gl.deleteTexture(s.tex);
      gl.deleteFramebuffer(s.fbo);
    }
    this.state = [0, 1].map(() => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this.texParams();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, simW, simH, 0, gl.RGBA, this.texType, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Couldn't create the water simulation buffer.");
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = 0;
  }

  setSource(source: Source | null, mirror: boolean) {
    this.source = source;
    this.mirror = mirror;
  }

  get isMirrored() {
    return this.mirror;
  }

  /** Advance the water by dt seconds with the current fingertips. */
  step(inputs: WaterInput[], dt: number) {
    const gl = this.gl;
    const { u } = this.update;
    const count = Math.min(inputs.length, MAX_INPUTS);
    for (let i = 0; i < count; i++) {
      const f = inputs[i];
      // screen uv (y down) → GL uv (y up)
      this.A.set([f.x, 1 - f.y, f.px, 1 - f.py], i * 4);
      this.B.set([f.pulse, f.press, f.radius, f.drag], i * 4);
    }

    gl.useProgram(this.update.p);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.simW, this.simH);
    gl.uniform2f(u.uTexel, 1 / this.simW, 1 / this.simH);
    gl.uniform1f(u.uAspect, this.simW / this.simH);
    gl.uniform1f(u.uDamping, this.settings.damping);
    gl.uniform1f(u.uDispDecay, this.settings.dispDecay);
    gl.uniform4fv(u.uA, this.A);
    gl.uniform4fv(u.uB, this.B);
    gl.uniform1i(u.uState, 0);
    gl.activeTexture(gl.TEXTURE0);

    this.acc += dt * this.settings.stepsPerSecond;
    const steps = Math.max(1, Math.min(4, Math.floor(this.acc)));
    this.acc = Math.max(0, Math.min(this.acc - steps, 1));
    for (let s = 0; s < steps; s++) {
      gl.uniform1i(u.uCount, s === 0 ? count : 0); // inject fingers once per frame
      const src = this.state[this.cur];
      const dst = this.state[1 - this.cur];
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.cur = 1 - this.cur;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Draw the camera through the water. */
  draw() {
    const gl = this.gl;
    const { u } = this.render;

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    const src = this.source;
    let srcW = 0, srcH = 0;
    if (src instanceof HTMLVideoElement) {
      if (src.readyState >= 2 && src.videoWidth) {
        srcW = src.videoWidth;
        srcH = src.videoHeight;
      }
    } else if (src) {
      srcW = src.width;
      srcH = src.height;
    }
    if (src && srcW) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    // Recomputed every frame: phones swap video width/height on rotation.
    this.crop = coverCrop(srcW, srcH, this.canvas.width, this.canvas.height);

    gl.useProgram(this.render.p);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state[this.cur].tex);
    gl.uniform1i(u.uState, 0);
    gl.uniform1i(u.uSource, 1);
    gl.uniform2f(u.uTexel, 1 / this.simW, 1 / this.simH);
    // crop is symmetric, so y-down and y-up offsets are identical
    gl.uniform4f(u.uCrop, this.crop.ox, this.crop.oy, this.crop.sx, this.crop.sy);
    gl.uniform1f(u.uMirror, this.mirror ? 1 : 0);
    gl.uniform1f(u.uRefraction, this.settings.refraction);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
