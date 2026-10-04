// The print pass. The scene renders into a target with depth, then one full-screen shader makes it look printed:
// shading becomes halftone dots, depth edges become ink lines, the colour layers sit a touch out of register, and the
// whole thing gets paper grain.
import * as THREE from 'three';

const vertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const fragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uSize;     // drawing-buffer pixels
uniform float uDpr;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uStrength;
uniform float uBlueprint; // 1: paper and ink lines only
uniform vec3 uSkyTop;     // sRGB
uniform vec3 uSkyLow;
uniform float uEdges;     // 0 on the low quality tier
varying vec2 vUv;

float linearDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 px = 1.0 / uSize;
  // misregistration: the blue layer sits half a pixel off
  vec3 col = texture2D(tColor, vUv).rgb;
  col.b = texture2D(tColor, vUv + vec2(0.6, -0.4) * px * uDpr).b;
  col = toSRGB(max(col, 0.0));
  float rawDepth = texture2D(tDepth, vUv).x;
  if (rawDepth > 0.99999) {
    // the sky: a gradient painted here so it can follow the time of day
    col = mix(uSkyLow, uSkyTop, smoothstep(0.25, 1.0, vUv.y));
  }

  // halftone: darker tones print as bigger dots of a darker version of the same ink
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float cell = 4.2 * uDpr;
  float a = 0.785;
  vec2 g = mat2(cos(a), -sin(a), sin(a), cos(a)) * gl_FragCoord.xy / cell;
  float d = length(fract(g) - 0.5);
  float ink = clamp((0.8 - lum) * 1.15, 0.0, 1.0);
  float r = sqrt(ink) * 0.58;
  float dotMask = 1.0 - smoothstep(r - 0.09, r + 0.09, d);
  vec3 light = mix(col, vec3(1.0, 0.985, 0.95), 0.1 * uStrength) * 1.04;
  vec3 dark = col * 0.8;
  col = mix(col, mix(light, dark, dotMask), uStrength);

  col = mix(col, vec3(0.93, 0.95, 0.97), uBlueprint * 0.88);

  // ink outlines where depth jumps
  float c0 = linearDepth(vUv);
  float o = 1.2 * uDpr;
  float e = abs(linearDepth(vUv + vec2(o, 0) * px) - c0) + abs(linearDepth(vUv - vec2(o, 0) * px) - c0)
          + abs(linearDepth(vUv + vec2(0, o) * px) - c0) + abs(linearDepth(vUv - vec2(0, o) * px) - c0);
  float edge = smoothstep(0.12, 0.35, e / max(c0, 1.0) * 6.0) * uEdges;
  col = mix(col, vec3(0.24, 0.36, 0.66), edge * mix(0.75, 1.0, uBlueprint));

  // paper: fibres and grain
  float fibre = noise(gl_FragCoord.xy / (90.0 * uDpr)) * 0.5 + noise(gl_FragCoord.xy / (18.0 * uDpr)) * 0.5;
  float grain = hash(floor(gl_FragCoord.xy / uDpr) + floor(uTime * 12.0));
  col *= 0.975 + 0.035 * fibre;
  col -= (grain - 0.5) * 0.045;
  gl_FragColor = vec4(col, 1.0);
}`;

export class Riso {
  readonly target: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer, samples = 4) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.target.depthTexture = new THREE.DepthTexture(1, 1);
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          tColor: { value: this.target.texture },
          tDepth: { value: this.target.depthTexture },
          uSize: { value: new THREE.Vector2(1, 1) },
          uDpr: { value: 1 },
          uNear: { value: 0.1 },
          uFar: { value: 300 },
          uTime: { value: 0 },
          uStrength: { value: 1 },
          uBlueprint: { value: 0 },
          uSkyTop: { value: new THREE.Color() },
          uSkyLow: { value: new THREE.Color() },
          uEdges: { value: 1 },
        },
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.scene.add(this.quad);
  }

  setSize(w: number, h: number, dpr: number): void {
    this.target.setSize(Math.round(w * dpr), Math.round(h * dpr));
    const u = this.quad.material.uniforms;
    u.uSize!.value.set(Math.round(w * dpr), Math.round(h * dpr));
    u.uDpr!.value = dpr;
  }

  /** The print look: blueprint mix (0 to 1), sky colours (sRGB hex, top and horizon), and whether to ink edges. */
  setLook(blueprint: number, skyTop: THREE.Color, skyLow: THREE.Color, edges: boolean): void {
    const u = this.quad.material.uniforms;
    u.uBlueprint!.value = blueprint;
    (u.uSkyTop!.value as THREE.Color).copy(skyTop);
    (u.uSkyLow!.value as THREE.Color).copy(skyLow);
    u.uEdges!.value = edges ? 1 : 0;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number): void {
    const u = this.quad.material.uniforms;
    u.uNear!.value = camera.near;
    u.uFar!.value = camera.far;
    u.uTime!.value = time;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.ortho);
  }
}
