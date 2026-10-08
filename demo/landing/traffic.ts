// Paper traffic and sky: autos, buses, cars and e-rickshaws on the roads (keeping left, and clockwise round the
// circle), the metro on its viaduct, boats on the river, and kites on strings over the rooftops.
import * as THREE from 'three';
import { box, C, poly, quad, rng } from './kit.ts';

const MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

/** Vehicles are tiny and never fold, so a plain merge of position, colour and index is enough. */
function mesh(parts: THREE.BufferGeometry[]): THREE.Mesh {
  const out = new THREE.BufferGeometry();
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const p of parts) {
    const base = pos.length / 3;
    pos.push(...(p.attributes.position!.array as Float32Array));
    const c = p.attributes.color!;
    for (let i = 0; i < c.count; i++) col.push(c.getX(i), c.getY(i), c.getZ(i));
    for (const i of p.index!.array as Uint16Array) idx.push(base + i);
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  return new THREE.Mesh(out, MAT);
}

type Kind = 'auto' | 'bus' | 'car' | 'erick';
function vehicle(kind: Kind, random: () => number): THREE.Mesh {
  if (kind === 'auto')
    return mesh([box(0.62, 0.22, 0.4, C.leaf, 0, 0.2, 0), box(0.5, 0.06, 0.42, C.mustard, -0.05, 0.62, 0), box(0.04, 0.32, 0.36, C.mustard, 0.2, 0.44, 0), box(0.04, 0.32, 0.04, C.slate, -0.28, 0.44, 0.18), box(0.04, 0.32, 0.04, C.slate, -0.28, 0.44, -0.18)]);
  if (kind === 'erick') return mesh([box(0.7, 0.2, 0.42, C.white, 0, 0.2, 0), box(0.66, 0.05, 0.44, C.blue, 0, 0.66, 0), box(0.04, 0.4, 0.04, C.slate, 0.3, 0.44, 0.18), box(0.04, 0.4, 0.04, C.slate, -0.3, 0.44, 0.18)]);
  if (kind === 'bus') {
    const parts = [box(2.2, 0.7, 0.56, C.orange, 0, 0.45, 0), box(2.22, 0.06, 0.58, C.white, 0, 0.82, 0), box(2.22, 0.1, 0.58, C.red, 0, 0.18, 0)];
    for (let x = -0.85; x <= 0.9; x += 0.34) parts.push(quad(0.24, 0.22, C.glass, x, 0.56, 0.29));
    return mesh(parts);
  }
  const body = [C.white, C.pale, C.white, C.blue, C.red][Math.floor(random() * 5)]!;
  return mesh([box(0.9, 0.22, 0.42, body, 0, 0.19, 0), box(0.48, 0.18, 0.38, body, -0.05, 0.38, 0), quad(0.4, 0.12, C.glass, -0.05, 0.4, 0.2)]);
}

interface Path {
  length: number;
  place(obj: THREE.Object3D, at: number): void;
  ends: boolean; // whether it starts and ends at the edge of the page
}
interface Mover extends Path {
  obj: THREE.Object3D;
  at: number;
  speed: number;
}

/** A straight lane along x or z at a fixed other coordinate, travelled in direction dir. */
function line(axis: 'x' | 'z', fixed: number, dir: 1 | -1, from: number, to: number, y = 0): Path {
  return {
    length: to - from,
    ends: true,
    place(obj, at) {
      const p = dir === 1 ? from + at : to - at;
      if (axis === 'x') {
        obj.position.set(p, y, fixed);
        obj.rotation.y = dir === 1 ? 0 : Math.PI;
      } else {
        obj.position.set(fixed, y, p);
        obj.rotation.y = dir === 1 ? -Math.PI / 2 : Math.PI / 2;
      }
    },
  };
}

/** A clockwise loop round a circle, seen from above. */
function loop(cx: number, cz: number, r: number): Path {
  return {
    length: Math.PI * 2 * r,
    ends: false,
    place(obj, at) {
      const a = -at / r;
      obj.position.set(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
      obj.rotation.y = Math.PI / 2 - a;
    },
  };
}

export class Traffic {
  readonly root = new THREE.Group();
  private readonly movers: Mover[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor() {
    const random = rng(91);
    const lanes: [Path, number][] = [
      [line('z', 1.0, 1, -31, 31), 5],
      [line('z', -1.0, -1, -31, 31), 5],
      [line('x', -20.2, 1, -50, 43), 5],
      [line('x', -19.4, -1, -50, 43), 5],
      [line('x', -4.4, 1, -50, 2), 3],
      [line('x', -3.6, -1, -50, 2), 3],
      [line('x', 10.2, 1, -50, 43), 5],
      [line('x', 11.0, -1, -50, 43), 5],
      [line('x', 20.6, 1, -48.6, -2), 3],
      [line('x', 21.4, -1, -48.6, -2), 3],
      [line('z', -33.6, 1, -31, 9.8), 3],
      [line('z', -34.4, -1, -31, 9.8), 3],
      [line('z', -17.6, 1, -31, 9.8), 3],
      [line('z', -18.4, -1, -31, 9.8), 3],
      [line('z', 34.6, 1, -31, 31), 4],
      [line('z', 33.8, -1, -31, 31), 4],
      [loop(19.1, -4.6, 8.3), 4],
      [loop(19.1, -4.6, 11.9), 6],
    ];
    const kinds: Kind[] = ['auto', 'car', 'auto', 'erick', 'car', 'bus', 'auto', 'car'];
    let k = 0;
    for (const [path, count] of lanes)
      for (let i = 0; i < count; i++) {
        const kind = kinds[k++ % kinds.length]!;
        const obj = vehicle(kind, random);
        this.root.add(obj);
        this.movers.push({ ...path, obj, at: ((i + random() * 0.6) / count) * path.length, speed: (kind === 'bus' ? 1.4 : 2.3) + random() * 0.8 });
      }

    // the metro: four white cars with a blue band, on the viaduct
    const train = new THREE.Group();
    for (let c = 0; c < 4; c++) {
      const parts = [box(3.0, 0.62, 0.62, C.white, 0, 0.36, 0), box(3.02, 0.1, 0.64, C.ink, 0, 0.2, 0), box(3.02, 0.05, 0.64, C.red, 0, 0.6, 0)];
      for (let x = -1.2; x <= 1.25; x += 0.4) parts.push(quad(0.26, 0.22, C.glass, x, 0.42, 0.32), quad(0.26, 0.22, C.glass, x, 0.42, -0.32));
      const car = mesh(parts);
      car.position.x = c * 3.1;
      train.add(car);
    }
    this.root.add(train);
    this.movers.push({ ...line('z', 3.4, -1, -46, 46, 3.64), obj: train, at: 30, speed: 4.2 });

    // boats on the river
    for (let i = 0; i < 3; i++) {
      const boat = mesh([box(1.2, 0.16, 0.42, C.warm, 0, 0.08, 0), box(0.4, 0.3, 0.3, C.white, -0.2, 0.3, 0), box(0.3, 0.1, 0.3, C.stone, 0.6, 0.1, 0)]);
      this.root.add(boat);
      this.movers.push({ ...line('z', 45 + i * 1.6, i % 2 ? 1 : -1, -32, 32, 0.02), obj: boat, at: i * 20, speed: 0.6 });
    }
    this.update(0);
  }

  update(dt: number): void {
    for (const m of this.movers) {
      m.at = (m.at + m.speed * dt) % m.length;
      m.place(m.obj, m.at);
      if (m.obj.type === 'Group') {
        // the metro: each car folds away as it reaches the edge of the page
        m.obj.updateMatrixWorld();
        for (const car of m.obj.children) car.scale.setScalar(Math.min(1, Math.max(0.001, (31.5 - Math.abs(car.getWorldPosition(this.tmp).z)) / 1.6)));
      } else if (m.ends) m.obj.scale.setScalar(Math.min(1, Math.max(0.001, Math.min(m.at, m.length - m.at) / 0.8)));
    }
  }
}

/** Kites over the rooftops, each on a string to a roof, drifting in the breeze. */
export class Kites {
  readonly root = new THREE.Group();
  private readonly kites: { obj: THREE.Mesh; home: THREE.Vector3; phase: number; line: THREE.Line }[] = [];
  private readonly drift = new THREE.Vector3();

  constructor(anchors: THREE.Vector3[]) {
    const random = rng(7);
    const colours = [C.mustard, C.white, C.red, C.blue, C.orange];
    const lineMat = new THREE.LineBasicMaterial({ color: C.ink, transparent: true, opacity: 0.25 });
    anchors
      .filter((_, i) => i % 3 === 0)
      .slice(0, 8)
      .forEach((anchor, i) => {
        const obj = mesh([
          poly(
            [
              [0, 0.55],
              [0.42, 0],
              [0, -0.6],
              [-0.42, 0],
            ],
            colours[i % colours.length]!,
          ),
          quad(0.06, 0.5, C.ink, 0, -0.85, 0),
        ]);
        const home = anchor.clone().add(new THREE.Vector3((random() - 0.5) * 8, 9 + random() * 7, 3 + random() * 5));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([anchor, home]), lineMat);
        this.root.add(obj, line);
        this.kites.push({ obj, home, phase: random() * 7, line });
      });
    this.update(0);
  }

  update(time: number): void {
    for (const k of this.kites) {
      k.obj.position.copy(k.home).add(this.drift.set(Math.sin(time * 0.7 + k.phase) * 0.8, Math.sin(time * 1.1 + k.phase) * 0.5, Math.cos(time * 0.5 + k.phase) * 0.4));
      k.obj.rotation.set(0.2 * Math.sin(time + k.phase), 0, 0.35 * Math.sin(time * 0.9 + k.phase));
      const p = k.line.geometry.attributes.position as THREE.BufferAttribute;
      p.setXYZ(1, k.obj.position.x, k.obj.position.y - 0.4, k.obj.position.z);
      p.needsUpdate = true;
    }
  }
}
