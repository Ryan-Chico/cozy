/**
 * ripples.js — the rings the pointer sends out across the water.
 *
 * A small ping-pong height field, solved as a damped wave equation on the GPU.
 * Each texel holds (height, previousHeight) so one texture is enough per pass.
 * The water shader samples the gradient of this field to tilt its normals.
 *
 * The field covers a rectangle of world space around the stretch of creek the
 * camera can actually see, so the 512x256 texels are spent where they show.
 */

import * as THREE from 'three';

const SIM_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const SIM_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uPrev;
  uniform vec2  uTexel;
  uniform float uDamping;
  uniform float uSpeed;
  uniform vec4  uDrops[8];     // xy = uv, z = strength, w = radius scale
  uniform float uDropRadius;

  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;

    // (height, previousHeight) packed into .r and .g
    vec2 s = texture2D(uPrev, uv).rg;
    float cur = s.r;
    float prev = s.g;

    float l = texture2D(uPrev, uv - vec2(uTexel.x, 0.0)).r;
    float r = texture2D(uPrev, uv + vec2(uTexel.x, 0.0)).r;
    float d = texture2D(uPrev, uv - vec2(0.0, uTexel.y)).r;
    float u = texture2D(uPrev, uv + vec2(0.0, uTexel.y)).r;

    // discrete laplacian
    float lap = (l + r + d + u) - 4.0 * cur;

    // explicit wave step: next = 2*cur - prev + speed * laplacian
    float next = 2.0 * cur - prev + uSpeed * lap;
    next *= uDamping;

    // soft dimples where the pointer has been (unused slots carry strength 0).
    // Measure in texels, not uv — the field is 512x256 over a non-square patch
    // of world, so a uv-space radius would come out stretched into an ellipse.
    for (int i = 0; i < 8; i++) {
      vec4 dr = uDrops[i];
      float dist = distance(uv / uTexel, dr.xy / uTexel);
      next -= smoothstep(uDropRadius * dr.w, 0.0, dist) * dr.z;
    }

    // hold the rim at rest so the border never shows
    float edge = smoothstep(0.0, 0.02, uv.x) * smoothstep(0.0, 0.02, 1.0 - uv.x) *
                 smoothstep(0.0, 0.02, uv.y) * smoothstep(0.0, 0.02, 1.0 - uv.y);
    next *= edge;

    gl_FragColor = vec4(next, cur, 0.0, 1.0);
  }
`;

export class RippleSim {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} opts
   * @param {THREE.Vector2} opts.origin  world (x, z) of uv (0,0)
   * @param {THREE.Vector2} opts.size    world extent covered by the field
   */
  constructor(renderer, { origin, size, width = 768, height = 384 }) {
    this.renderer = renderer;
    this.texel = new THREE.Vector2(1 / width, 1 / height);
    this.origin = origin.clone();
    this.size = size.clone();

    const opts = {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.targets = [new THREE.WebGLRenderTarget(width, height, opts),
                    new THREE.WebGLRenderTarget(width, height, opts)];

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uTexel: { value: this.texel },
        uDamping: { value: 0.9945 },
        uSpeed: { value: 0.045 },
        uDrops: {
          value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 1)),
        },
        uDropRadius: { value: 2.4 },   // in texels
      },
      vertexShader: SIM_VERT,
      fragmentShader: SIM_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    // a fullscreen quad, drawn straight into whatever target is bound
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.read = 0;
    this.pending = [];

    // both targets start at rest
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of this.targets) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  /** world xz -> uv */
  toUV(x, z) {
    return new THREE.Vector2(
      (x - this.origin.x) / this.size.x,
      (z - this.origin.y) / this.size.y,
    );
  }

  inBounds(uv) {
    return uv.x > 0.02 && uv.x < 0.98 && uv.y > 0.02 && uv.y < 0.98;
  }

  /** queue a dimple of `strength` at world (x, z) */
  drop(x, z, strength = 0.7, radius = 1.0) {
    const uv = this.toUV(x, z);
    if (this.inBounds(uv)) this.pending.push({ uv, strength, radius });
    return this;
  }

  update(dt) {
    // keep the wave stable regardless of frame rate
    const steps = dt > 0.034 ? 2 : 1;
    for (let i = 0; i < steps; i++) this._step();
  }

  _step() {
    const prev = this.targets[this.read];
    const next = this.targets[1 - this.read];

    // apply every drop queued since the last step in one pass, so fast pointer
    // movement never leaves the rings lagging behind
    const drops = this.pending;
    this.pending = [];

    const slots = this.material.uniforms.uDrops.value;
    for (let i = 0; i < slots.length; i++) {
      const d = drops[i];
      if (d) slots[i].set(d.uv.x, d.uv.y, d.strength, d.radius);
      else slots[i].set(0, 0, 0, 1);
    }

    this.material.uniforms.uPrev.value = prev.texture;

    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(next);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.setRenderTarget(prevTarget);

    this.read = 1 - this.read;
  }

  get texture() {
    return this.targets[this.read].texture;
  }

  dispose() {
    this.targets.forEach((t) => t.dispose());
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
