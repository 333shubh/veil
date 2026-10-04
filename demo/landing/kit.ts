// The paper kit: a quiet riso palette, the materials, and a sheet builder that merges every folded piece into a few
// meshes. Each vertex carries its piece's hinge and start delay (and, for roof flaps and small details, a second
// hinge or a pop-in centre), and the vertex shader does the folding, so a whole city stands up with one uniform.
// Windows that belong to a meter carry its index; the material looks the colour up in a 256 x 1 texture.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The palette of the paper city in the reference: butter sky, pink table, pale blue-white buildings inked in one blue,
// and a few warm accents (the sun, orange roofs, yellow and red windows, a pink stamp).
export const C = {
  paper: 0xf6f1e8,
  white: 0xe9edee,
  pale: 0xd3e0e9,
  pale2: 0xc5cfd9,
  warm: 0xeee6dc,
  stone: 0xe3dccf,
  shade: 0x9fafc0,
  ink: 0x3d5da8,
  inkSoft: 0x8fa5cf,
  window: 0xc9d6e6,
  glass: 0xb3c4dc,
  mustard: 0xf2c14e,
  red: 0xe9524a,
  blue: 0x2e59b5,
  orange: 0xf07e3e,
  coral: 0xf35a56,
  pink: 0xe0457e,
  sandstone: 0xd99b7f,
  sandstone2: 0xc98168,
  marble: 0xf3f1ec,
  sage: 0xa9c77f,
  leaf: 0x6f9e45,
  water: 0x9fbbe0,
  slate: 0x4e5874, // water tanks, wheels, doorways
  table: 0xeb9cb4,
};

export const METERS = 256;
const meterData = new Uint8Array(METERS * 4);
export const meterTex = new THREE.DataTexture(meterData, METERS, 1);
meterTex.colorSpace = THREE.SRGBColorSpace;
meterTex.magFilter = meterTex.minFilter = THREE.NearestFilter;
meterTex.needsUpdate = true;
export const hovered = { value: -1 };
export const rise = { value: 0 }; // 0: everything lies flat on the sheet; 1: everything stands
export const focus = { value: 0 }; // section view: 1 folds everything outside the live feeder back down
export const explode = { value: 0 }; // explode view: lifts each floor of the feeder's homes apart
export const LIVE_RECT = new THREE.Vector4(-33.2, -19, -2, 9.8); // x0, z0, x1, z1 of the live feeder

/** Set meter i's window colour (sRGB hex) and glow (0 to 1). Call `flushMeters` after a batch. */
export function setMeter(i: number, hex: number, glow = 0): void {
  meterData[i * 4] = (hex >> 16) & 255;
  meterData[i * 4 + 1] = (hex >> 8) & 255;
  meterData[i * 4 + 2] = hex & 255;
  meterData[i * 4 + 3] = Math.round(glow * 255);
}
export const flushMeters = () => void (meterTex.needsUpdate = true);

const FOLD = /* glsl */ `
uniform float uRise;
uniform float uFocus;
uniform float uExplode;
uniform vec4 uLive;
attribute vec2 aFold;  // hinge z, start delay
attribute float aLevel; // the floor a part belongs to, for the explode view
attribute vec4 aAux;   // mode 1: flap about x (y, z, angle); 2: flap about z (y, x, angle); 3: pop in about (x, y, z)
vec3 rotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
vec3 rotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }
vec3 foldPoint(vec3 p) {
  float outside = 1.0 - step(uLive.x, p.x) * step(p.x, uLive.z) * step(uLive.y, p.z) * step(p.z, uLive.w);
  float r = clamp((uRise - aFold.y) / 0.42, 0.0, 1.0) * (1.0 - 0.97 * uFocus * outside);
  p.y += aLevel * uExplode * (1.0 - outside);
  float e1 = smoothstep(0.0, 1.0, clamp(r / 0.7, 0.0, 1.0));
  float e2 = smoothstep(0.0, 1.0, clamp((r - 0.55) / 0.45, 0.0, 1.0));
  float e3 = smoothstep(0.0, 1.0, clamp((r - 0.8) / 0.2, 0.0, 1.0));
  int mode = int(aAux.w + 0.5);
  if (mode == 1) { vec3 o = vec3(0.0, aAux.x, aAux.y); p = rotX(p - o, -aAux.z * (1.0 - e2)) + o; }
  else if (mode == 2) { vec3 o = vec3(aAux.y, aAux.x, 0.0); p = rotZ(p - o, -aAux.z * (1.0 - e2)) + o; }
  else if (mode == 3) { p = aAux.xyz + (p - aAux.xyz) * max(e3, 0.001); }
  vec3 h = vec3(0.0, 0.0, aFold.x);
  vec3 q = p - h;
  q.z *= mix(0.004, 1.0, e1);
  return rotX(q, -1.5707963 * (1.0 - e1)) + h;
}`;

/** Make a material fold its vertices by `rise`. `key` keeps programs with different extra code apart. */
export function foldable<T extends THREE.Material>(m: T, key: string, extra?: (s: THREE.WebGLProgramParametersWithUniforms) => void): T {
  m.onBeforeCompile = (s) => {
    s.uniforms.uRise = rise;
    s.uniforms.uFocus = focus;
    s.uniforms.uExplode = explode;
    s.uniforms.uLive = { value: LIVE_RECT };
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\n${FOLD}`).replace('#include <begin_vertex>', 'vec3 transformed = foldPoint(position);');
    extra?.(s);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** The shared paper material: flat-shaded Lambert with vertex colours, the meter lookup and the hover tint. */
export const PAPER = foldable(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }), 'paper', (s) => {
  s.uniforms.uMeters = { value: meterTex };
  s.uniforms.uHover = hovered;
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float meter;\nvarying float vMeter;')
    .replace('vec3 transformed = foldPoint(position);', 'vec3 transformed = foldPoint(position);\nvMeter = meter;');
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D uMeters;\nuniform float uHover;\nvarying float vMeter;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec4 meterCol = vec4(0.0);
      if (vMeter > -0.5) {
        meterCol = texture2D(uMeters, vec2((vMeter + 0.5) / ${METERS}.0, 0.5));
        if (abs(vMeter - uHover) < 0.5) meterCol = vec4(0.88, 0.27, 0.49, 1.0);
        diffuseColor.rgb = meterCol.rgb;
      }`,
    )
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += meterCol.rgb * meterCol.a * 0.8;');
});
export const PAPER_DEPTH = foldable(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), 'paper-depth');

/** Colour a geometry for the paper material: an index, a Uint8 colour, a meter per vertex and an up normal. */
export function tint(g: THREE.BufferGeometry, hex: number, meter = -1): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  const n = g.attributes.position!.count;
  if (!g.index) g.setIndex(Array.from({ length: n }, (_, i) => i));
  const c = new THREE.Color(hex);
  const colours = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) colours.set([c.r * 255, c.g * 255, c.b * 255], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3, true));
  g.setAttribute('meter', new THREE.BufferAttribute(new Float32Array(n).fill(meter), 1));
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(n * 3).map((_, i) => (i % 3 === 1 ? 127 : 0)), 3, true));
  return g;
}

export const box = (w: number, h: number, d: number, hex: number, x = 0, y = 0, z = 0, meter = -1) =>
  tint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex, meter);

/** A flat quad in the xy plane facing +z, centred at (x, y, z). */
export const quad = (w: number, h: number, hex: number, x = 0, y = 0, z = 0, meter = -1) =>
  tint(new THREE.PlaneGeometry(w, h).translate(x, y, z), hex, meter);

/** A quad on a side wall, facing +x (side 1) or -x (side -1). */
export const sideQuad = (w: number, h: number, hex: number, x: number, y: number, z: number, side: 1 | -1, meter = -1) =>
  tint(new THREE.PlaneGeometry(w, h).rotateY((side * Math.PI) / 2).translate(x, y, z), hex, meter);

/** A flat polygon in the xy plane facing +z. */
export function poly(points: [number, number][], hex: number, z = 0): THREE.BufferGeometry {
  return tint(new THREE.ShapeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))).translate(0, 0, z), hex);
}

export const cyl = (rt: number, rb: number, h: number, hex: number, x = 0, y = 0, z = 0, seg = 12) =>
  tint(new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z), hex);

/** A dome: the upper part of a sphere, optionally stretched into an onion. */
export const dome = (r: number, hex: number, x = 0, y = 0, z = 0, stretch = 1) =>
  tint(new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, stretch, 1).translate(x, y, z), hex);

export type Aux = [number, number, number, number];
export const flapX = (y: number, z: number, angle: number): Aux => [y, z, angle, 1];
export const flapZ = (y: number, x: number, angle: number): Aux => [y, x, angle, 2];
export const pop = (x: number, y: number, z: number): Aux => [x, y, z, 3];

interface Bucket {
  material: THREE.Material;
  depth: THREE.Material;
  geos: THREE.BufferGeometry[];
  pickable: boolean;
  shadow: boolean;
}

/**
 * Collects the pieces of one sheet. Call `piece(x, z, depth)` to start a piece (its hinge is its back edge), then
 * `add` geometry in world coordinates; `build` merges each bucket into one mesh.
 */
export class Sheet {
  private readonly buckets = new Map<string, Bucket>();
  private hinge = 0;
  private delay = 0;
  level = 0; // the floor the next added parts belong to (explode view); reset by piece()

  bucket(key: string, material: THREE.Material, depth: THREE.Material, opts: { pickable?: boolean; shadow?: boolean } = {}): void {
    this.buckets.set(key, { material, depth, geos: [], pickable: opts.pickable ?? false, shadow: opts.shadow ?? true });
  }

  /** Start a piece whose back edge is at z = hinge and which starts to stand at `delay` (0 to about 0.58). */
  piece(hinge: number, delay: number): void {
    this.hinge = hinge;
    this.delay = delay;
    this.level = 0;
  }

  add(key: string, g: THREE.BufferGeometry | THREE.BufferGeometry[], aux: Aux = [0, 0, 0, 0]): void {
    const list = Array.isArray(g) ? g : [g];
    const b = this.buckets.get(key)!;
    for (const geo of list) {
      const n = geo.attributes.position!.count;
      const fold = new Float32Array(n * 2);
      const a = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        fold[i * 2] = this.hinge;
        fold[i * 2 + 1] = this.delay;
        a.set(aux, i * 4);
      }
      geo.setAttribute('aFold', new THREE.BufferAttribute(fold, 2));
      geo.setAttribute('aLevel', new THREE.BufferAttribute(new Float32Array(n).fill(this.level), 1));
      geo.setAttribute('aAux', new THREE.BufferAttribute(a, 4));
      b.geos.push(geo);
    }
  }

  build(parent: THREE.Object3D): THREE.Mesh[] {
    const picks: THREE.Mesh[] = [];
    for (const b of this.buckets.values()) {
      if (!b.geos.length) continue;
      const m = new THREE.Mesh(mergeGeometries(b.geos)!, b.material);
      m.castShadow = b.shadow;
      m.receiveShadow = true;
      m.customDepthMaterial = b.depth;
      m.frustumCulled = false; // the shader moves vertices outside the CPU bounds while folding
      parent.add(m);
      if (b.pickable) picks.push(m);
      b.geos.length = 0;
    }
    return picks;
  }
}

export const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A seeded random stream, so the city is the same on every load. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A paper card material for drawn cut-outs (trees, the skyline), folded like everything else. */
export function cardMaterials(map: THREE.Texture, key: string): [THREE.Material, THREE.Material] {
  return [
    foldable(new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, flatShading: true }), `card-${key}`),
    foldable(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5 }), `card-depth-${key}`),
  ];
}

/** A card geometry with uv, for `cardMaterials`: the same attribute set as `tint` minus colour and meter. */
export function card(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'uv') g.deleteAttribute(name);
  const n = g.attributes.position!.count;
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(n * 3).map((_, i) => (i % 3 === 1 ? 127 : 0)), 3, true));
  return g;
}
