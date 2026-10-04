// An Indian city as a pop-up book: a printed floor sheet with every building, tree and landmark folded flat on it, and
// a skyline page hinged at the back edge. Opening the book stands the page up behind the city and raises the pieces.
// One district in the middle is the live feeder: its 240 meters are the demo's group (5 DDA-style blocks of 24 flats,
// 20 builder floors of 4 and 20 old row houses of 2). Everything else is the city around it and carries no meter.
import * as THREE from 'three';
import { box, C, card, cardMaterials, cyl, dome, flapX, PAPER, PAPER_DEPTH, poly, pop, quad, rng, Sheet, sideQuad, tint, type Aux } from './kit.ts';
import { layerTexture, mapTexture, PAGE_H, SHEET, skylineTexture, treeTexture, type MapSpec, type Rect, type TreeKind } from './paint.ts';

export const HOMES = 240;
export const DDA = { blocks: 5, flats: 24, first: 0 };
export const BUILDER = { houses: 20, floors: 4, first: 120 };
export const ROW = { houses: 20, floors: 2, first: 200 };
const BACK = -SHEET.d / 2;

const R = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0, z0, x1, z1 });
const FLOORS = ['ground', 'first', 'second', 'third'];
const TREES: TreeKind[] = ['neem', 'amaltas', 'gulmohar', 'ashoka'];
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A thin rod between two points: wires, cables, struts. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, hex: number): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), 4);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return tint(g, hex);
}

/** A pointed arch (door, gate, alcove) as a flat polygon facing +z. */
function arch(x: number, y: number, w: number, h: number, hex: number, z: number): THREE.BufferGeometry {
  return poly(
    [
      [x - w / 2, y],
      [x + w / 2, y],
      [x + w / 2, y + h * 0.72],
      [x, y + h],
      [x - w / 2, y + h * 0.72],
    ],
    hex,
    z,
  );
}

export class City {
  readonly root = new THREE.Group();
  readonly pickables: THREE.Mesh[] = [];
  readonly labels: string[] = new Array(HOMES).fill('');
  readonly spots: THREE.Vector3[] = new Array(HOMES); // one window of each home, for picking by nearest
  readonly heroCabinet = new THREE.Vector3();
  readonly transformer = new THREE.Vector3(-3.0, 3.6, -2.0);
  readonly explainHomes: { meter: number; top: THREE.Vector3 }[] = [];
  readonly kiteAnchors: THREE.Vector3[] = [];
  readonly live = R(-32.6, -18.4, -2.6, 9.2);
  hero = DDA.first;
  private readonly sheet = new Sheet();
  private readonly random = rng(2026);
  private readonly footprints: Rect[] = [];
  private readonly cabinetSlots: THREE.Vector3[] = [];
  private readonly heroFace: THREE.Mesh;
  private readonly page = new THREE.Group();

  constructor() {
    const s = this.sheet;
    s.bucket('live', PAPER, PAPER_DEPTH, { pickable: true });
    s.bucket('paper', PAPER, PAPER_DEPTH);
    s.bucket('wire', PAPER, PAPER_DEPTH, { shadow: false });
    for (const k of TREES) s.bucket(`tree-${k}`, ...cardMaterials(treeTexture(k), k));
    s.bucket('layer', ...cardMaterials(layerTexture(), 'layer'));

    this.liveDistrict();
    this.oldCity();
    this.circle(19.1, -4.6);
    this.ceremonial();
    this.gardens();
    this.metro();
    this.river();
    this.colony(R(-48.6, -18.4, -35.4, -5.4));
    this.colony(R(-48.6, -2.6, -35.4, 9.2), true);
    this.colony(R(20.4, -30.6, 32.8, -21.2));
    this.colony(R(35.6, -18.4, 42.4, -5.4));
    this.colony(R(35.6, -2.6, 42.4, 9.2));
    this.colony(R(35.6, 12, 42.4, 19));
    // the mid layer: a strip of cut-out buildings just in front of the skyline page
    s.piece(BACK + 1.2, 0.04);
    s.add('layer', card(new THREE.PlaneGeometry(SHEET.w, 14).translate(0, 7, BACK + 1.4)));

    this.pickables.push(...s.build(this.root));

    const cols = [
      [-48.6, -35.4],
      [-32.6, -19.4],
      [-16.6, -2.6],
      [5.4, 17.6],
      [20.4, 32.8],
      [35.6, 42.4],
    ];
    const rows = [
      [-30.6, -21.2],
      [-18.4, -5.4],
      [-2.6, 9.2],
    ];
    const blocks = rows.flatMap(([z0, z1], ri) => cols.filter((_, ci) => !(ri > 0 && (ci === 3 || ci === 4))).map(([x0, x1]) => R(x0!, z0!, x1!, z1!)));
    blocks.push(R(35.6, 12, 42.4, 31));
    const spec: MapSpec = {
      roads: [
        R(-2, -31, 2, 31),
        R(-50, -20.6, 43, -19),
        R(-50, -4.8, 2, -3.2),
        R(-50, 9.8, 43, 11.4),
        R(-48.6, 20.4, -2, 21.6),
        R(-34.8, -31, -33.2, 9.8),
        R(-18.8, -31, -17.2, 9.8),
        R(18.2, -31, 19.8, -20.6),
        R(33.4, -31, 35, 31),
      ],
      lanes: [R(-16.6, -26.8, -2.6, -25.4), R(-32.6, 2.7, -19.4, 3.8), R(-16.6, 1.1, -2.6, 5.5)],
      blocks,
      lawns: [
        R(2, -31, 4.8, 31),
        R(-48.6, 12, -2.6, 20.4),
        R(-48.6, 21.6, -2.6, 31),
        R(5.4, 12, 32.8, 31),
        R(-48.6, -26.2, -35.4, -21.2),
        R(-8.8, -13.6, -3.0, -9.0),
      ],
      water: [R(43, -33, 50, 33), R(-46, 18.4, -12, 19.2), R(-46, 22.8, -12, 23.6), R(8.2, -23.4, 14.8, -21.8), R(21.2, 25.6, 30.8, 27.2)],
      plazas: [R(-13, 18.6, -2.6, 23.4), R(8, 17.6, 16, 25.4)],
      ring: { x: 19.1, z: -4.6, roads: [[4.2, 5.4], [7.6, 9.0], [11.2, 12.6]], park: 4.2, spokes: 6 },
      live: this.live,
      footprints: this.footprints,
    };
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(SHEET.w, SHEET.d), new THREE.MeshLambertMaterial({ map: mapTexture(spec) }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const edge = new THREE.Mesh(new THREE.BoxGeometry(SHEET.w, 0.12, SHEET.d), new THREE.MeshLambertMaterial({ color: 0xe8e2d6 }));
    edge.position.y = -0.065;
    this.root.add(floor, edge);

    // the skyline page, hinged at the back edge
    const sky = skylineTexture();
    const pageMesh = new THREE.Mesh(new THREE.PlaneGeometry(SHEET.w, PAGE_H).translate(0, PAGE_H / 2, 0), new THREE.MeshLambertMaterial({ map: sky, alphaTest: 0.5, side: THREE.DoubleSide }));
    pageMesh.castShadow = true;
    pageMesh.receiveShadow = true;
    pageMesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: sky, alphaTest: 0.5 });
    this.page.position.z = BACK;
    this.page.add(pageMesh);
    this.root.add(this.page);

    this.heroFace = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.12), new THREE.MeshBasicMaterial({ color: C.coral }));
    this.heroFace.visible = false;
    this.root.add(this.heroFace);
  }

  /** The wiring view: a service line from the transformer to every home on the feeder, drooping like real ones. */
  wiring(): THREE.LineSegments {
    const pts: THREE.Vector3[] = [];
    const from = this.transformer.clone().setY(3.3);
    this.spots.forEach((spot) => {
      const to = spot.clone();
      const mid = from.clone().lerp(to, 0.5);
      mid.y = Math.max(from.y, to.y) + 1.2 + from.distanceTo(to) * 0.05;
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
      const p = curve.getPoints(10);
      for (let i = 0; i < p.length - 1; i++) pts.push(p[i]!, p[i + 1]!);
    });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: C.pink, transparent: true, opacity: 0.55 }));
    lines.visible = false;
    return lines;
  }

  /** Stand the skyline page up: 0 flat behind the sheet, 1 upright. */
  setPage(p: number): void {
    this.page.rotation.x = (-Math.PI / 2) * (1 - p);
  }

  /** Follow one flat of the hero block in the story: its meter on the stairwell board gets a blinking coral face. */
  setHero(meter: number): void {
    this.hero = meter;
    this.heroFace.position.copy(this.cabinetSlots[meter - (DDA.first + 4 * DDA.flats)]!);
  }

  setHeroBlink(on: boolean, time: number): void {
    this.heroFace.visible = on;
    this.heroFace.scale.setScalar(1 + 0.3 * Math.max(0, Math.sin(time * 7)));
  }

  // ---- pieces ----

  /** Start a piece: footprint centred at (x, z), hinged at its back edge, rising after the pieces behind it. */
  private begin(x: number, z: number, w: number, d: number, delay?: number): void {
    this.sheet.piece(z - d / 2, delay ?? 0.05 + 0.48 * ((z - BACK) / SHEET.d) + 0.05 * this.random());
    if (w > 0) this.footprints.push(R(x - w / 2, z - d / 2, x + w / 2, z + d / 2));
  }

  private add(g: THREE.BufferGeometry | THREE.BufferGeometry[], key = 'paper', aux?: Aux): void {
    this.sheet.add(key, g, aux);
  }

  private tree(x: number, z: number, kind?: TreeKind, scale?: number): void {
    const k = kind ?? TREES[Math.floor(this.random() * 3)]!;
    const s = scale ?? 1.1 + this.random() * 0.5;
    this.begin(x, z, 0, 0.2);
    const h = k === 'ashoka' ? 2.6 : 2.1;
    for (const a of [Math.PI / 4, -Math.PI / 4]) this.add(card(new THREE.PlaneGeometry(1.4 * s, h * s).translate(0, (h * s) / 2, 0).rotateY(a).translate(x, 0, z)), `tree-${k}`);
  }

  private trees(rect: Rect, n: number, kind?: TreeKind): void {
    for (let i = 0; i < n; i++) this.tree(rect.x0 + this.random() * (rect.x1 - rect.x0), rect.z0 + this.random() * (rect.z1 - rect.z0), kind);
  }

  /** Most windows pale, a few in the reference's yellow, red and blue. */
  private mondrian(): number {
    const k = this.random();
    return k < 0.09 ? C.mustard : k < 0.13 ? C.red : k < 0.17 ? C.blue : C.window;
  }

  private tank(x: number, y: number, z: number, key = 'paper'): void {
    this.add([cyl(0.28, 0.3, 0.5, C.slate, x, y + 0.25, z, 10), cyl(0.12, 0.28, 0.08, C.slate, x, y + 0.54, z, 10)], key, pop(x, y, z));
  }

  // ---- the live feeder district ----

  private liveDistrict(): void {
    let block = 0;
    for (const z of [-16, -11.6, -7.2]) this.ddaBlock(-26, z, block++);
    for (const z of [-15.6, -7.2]) this.ddaBlock(-12.5, z, block++);
    this.waterTower(-5.6, -16.2);
    this.trees(R(-8.6, -13.4, -3.2, -9.2), 6);
    for (const x of [-30.6, -21.4]) for (const z of [-13.8, -9.4]) this.tree(x, z);

    let n = 0;
    for (const z of [-1.2, 1.5, 5.0, 7.7]) for (const x of [-31.2, -28.6, -26, -23.4, -20.8]) this.builderFloor(x, z, n++);
    for (let i = 0; i < 5; i++) this.explainHomes.push({ meter: BUILDER.first + i * BUILDER.floors, top: V(-31.2 + i * 2.6, 4.9, -1.2) });

    n = 0;
    for (const z of [0, 6.6]) for (let i = 0; i < 10; i++) this.rowHouse(-15.9 + i * 1.32, z, n++);
    this.market(R(-15.2, 2.7, -6.4, 3.9));
    this.temple(-4.4, 3.3);
    this.substation(-3.0, -2.0);
    this.poles(-16.2, -3.0, 1.35, true);
    this.poles(-32.2, -19.8, 3.25, false);
    this.poles(-16.2, -3.0, 8.0, false);
  }

  /** Add parts floor by floor, so the explode view can lift each floor apart. */
  private addLevels(levels: THREE.BufferGeometry[][], key: string): void {
    levels.forEach((parts, level) => {
      if (!parts.length) return;
      this.sheet.level = level;
      this.sheet.add(key, parts);
    });
    this.sheet.level = 0;
  }

  /** A DDA-style block: four floors of six flats around a central stair, balconies, tanks on the roof. */
  private ddaBlock(cx: number, cz: number, index: number): void {
    const w = 6.6;
    const d = 2.6;
    const fh = 0.95;
    const H = fh * 4;
    const first = DDA.first + index * DDA.flats;
    const hero = index === 4;
    this.begin(cx, cz, w, d);
    const levels: THREE.BufferGeometry[][] = [[], [], [], [], []];
    levels[0]!.push(box(w + 0.12, 0.12, d + 0.12, C.stone, cx, 0.06, cz));
    const flat = (w - 0.9) / 6;
    for (let f = 0; f < 4; f++) {
      const y = f * fh;
      const L = levels[f]!;
      L.push(box(w, fh, d, C.white, cx, y + fh / 2, cz), box(w + 0.04, 0.07, d + 0.04, C.pale2, cx, y + fh - 0.03, cz));
      L.push(quad(0.8, fh, C.pale, cx, y + fh / 2, cz + d / 2 + 0.01));
      for (let jy = y + 0.12; jy < y + fh - 0.1; jy += 0.24) for (let jx = -0.28; jx <= 0.29; jx += 0.14) if (f > 0 || jy > 1.0) L.push(quad(0.07, 0.12, C.inkSoft, cx + jx, jy, cz + d / 2 + 0.02));
      for (let j = 0; j < 6; j++) {
        const fx = cx - w / 2 + flat / 2 + j * flat + (j >= 3 ? 0.9 : 0);
        const meter = first + f * 6 + j;
        L.push(quad(0.46, 0.4, C.window, fx, y + 0.52, cz + d / 2 + 0.01, meter), quad(0.46, 0.4, C.window, fx, y + 0.52, cz - d / 2 - 0.01, meter));
        if (f > 0) L.push(box(flat - 0.08, 0.05, 0.36, C.pale2, fx, y + 0.06, cz + d / 2 + 0.18), box(flat - 0.08, 0.26, 0.02, C.pale, fx, y + 0.2, cz + d / 2 + 0.36));
        this.labels[meter] = `Block ${index + 1}, flat ${f + 1}0${j + 1}`;
        this.spots[meter] = V(fx, y + 0.52, cz);
      }
      for (const side of [-1, 1] as const) L.push(sideQuad(0.5, 0.4, C.window, cx + (side * w) / 2 + side * 0.01, y + 0.52, cz, side));
    }
    // the meter board at the foot of the stair
    levels[0]!.push(box(0.62, 0.7, 0.12, C.marble, cx, 0.52, cz + d / 2 + 0.07));
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 6; c++) {
        const meter = first + c + r * 6;
        const p = V(cx - 0.22 + c * 0.088, 0.31 + r * 0.14, cz + d / 2 + 0.135);
        levels[0]!.push(quad(0.065, 0.09, C.slate, p.x, p.y, p.z, meter));
        if (hero) this.cabinetSlots.push(p.clone().setZ(p.z + 0.006));
      }
    levels[4]!.push(box(w, 0.18, 0.06, C.pale2, cx, H + 0.09, cz + d / 2 - 0.03), box(w, 0.18, 0.06, C.pale2, cx, H + 0.09, cz - d / 2 + 0.03), box(1.0, 0.6, 1.2, C.white, cx, H + 0.3, cz), box(1.1, 0.06, 1.3, C.orange, cx, H + 0.63, cz));
    this.addLevels(levels, 'live');
    this.sheet.level = 4;
    for (const tx of [-2.2, -1.5, 1.6, 2.3]) this.tank(cx + tx, H, cz - 0.4, 'live');
    this.sheet.level = 0;
    if (hero) this.heroCabinet.set(cx, 0.45, cz + d / 2 + 0.14);
    this.kiteAnchors.push(V(cx + 2, H + 0.6, cz));
  }

  /** A builder floor: parking on stilts, flats one above the other, a tank on the roof. */
  private builderFloor(cx: number, cz: number, n: number, live = true): void {
    const w = 2.2;
    const d = 2.4;
    const stilt = 0.6;
    const fh = 0.85;
    const floors = live ? 4 : 2 + Math.floor(this.random() * 3);
    const H = stilt + floors * fh;
    const skin = [C.white, C.pale, C.warm, C.white, C.pale][Math.floor(this.random() * 5)]!;
    const key = live ? 'live' : 'paper';
    this.begin(cx, cz, w, d);
    const levels: THREE.BufferGeometry[][] = Array.from({ length: floors + 2 }, () => []);
    levels[0]!.push(quad(w - 0.1, stilt - 0.05, C.slate, cx, stilt / 2, cz - 0.3), box(1.0, 0.32, 0.5, C.pale2, cx - 0.3, 0.16, cz + 0.4));
    for (const [px, pz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const)
      levels[0]!.push(box(0.12, stilt, 0.12, skin, cx + px * (w / 2 - 0.06), stilt / 2, cz + pz * (d / 2 - 0.06)));
    const strip = this.random() < 0.5;
    for (let f = 0; f < floors; f++) {
      const y = stilt + f * fh;
      const L = levels[f + 1]!;
      const meter = live ? BUILDER.first + n * BUILDER.floors + f : -1;
      const glass = live ? C.window : this.mondrian();
      L.push(box(w, fh, d, skin, cx, y + fh / 2, cz));
      if (strip) L.push(box(0.4, fh, 0.06, C.pale2, cx + w / 2 - 0.2, y + fh / 2, cz + d / 2 + 0.03));
      L.push(box(w + 0.1, 0.05, 0.4, C.pale2, cx, y + 0.03, cz + d / 2 + 0.2), box(w - 0.1, 0.24, 0.02, C.glass, cx, y + 0.18, cz + d / 2 + 0.39));
      L.push(quad(0.6, 0.48, glass, cx - 0.45, y + 0.48, cz + d / 2 + 0.01, meter), quad(0.5, 0.48, glass, cx + 0.5, y + 0.48, cz + d / 2 + 0.01, meter));
      L.push(box(0.3, 0.2, 0.14, C.marble, cx + w / 2 + 0.07, y + 0.4, cz - 0.4)); // the AC unit
      if (live) {
        this.labels[meter] = `House ${n + 1}, ${FLOORS[f]} floor`;
        this.spots[meter] = V(cx, y + 0.48, cz);
      }
    }
    const roof = levels[floors + 1]!;
    roof.push(box(w, 0.16, 0.05, skin, cx, H + 0.08, cz + d / 2 - 0.03), box(0.8, 0.5, 0.8, skin, cx - 0.5, H + 0.25, cz - 0.6));
    if (this.random() < 0.4) roof.push(box(0.9, 0.06, 0.9, C.orange, cx - 0.5, H + 0.53, cz - 0.6));
    this.addLevels(levels, key);
    this.sheet.level = floors + 1;
    this.tank(cx + 0.55, H, cz - 0.5, key);
    this.sheet.level = 0;
    if (this.random() < 0.3) this.kiteAnchors.push(V(cx, H + 0.4, cz));
  }

  /** An old row house: two floors, an arched door, a jharokha on the first floor. */
  private rowHouse(cx: number, cz: number, n: number): void {
    const w = 1.3;
    const d = 2.2;
    const fh = 0.9;
    const H = fh * 2;
    const skin = [C.white, C.pale, C.warm, C.white, C.stone][Math.floor(this.random() * 5)]!;
    this.begin(cx, cz, w, d);
    const z = cz + d / 2 + 0.01;
    const m0 = ROW.first + n * 2;
    const levels: THREE.BufferGeometry[][] = [[], [], []];
    levels[0]!.push(box(w - 0.04, fh, d, skin, cx, fh / 2, cz), arch(cx - 0.12, 0, 0.42, 0.68, C.slate, z), quad(0.24, 0.3, C.window, cx + 0.38, 0.5, z, m0));
    levels[1]!.push(box(w - 0.04, fh, d, skin, cx, fh + fh / 2, cz), box(0.56, 0.42, 0.24, C.pale2, cx, fh + 0.42, cz + d / 2 + 0.12), quad(0.4, 0.28, C.window, cx, fh + 0.44, cz + d / 2 + 0.25, m0 + 1));
    levels[1]!.push(box(0.64, 0.06, 0.3, n % 4 === 0 ? C.orange : C.pale2, cx, fh + 0.66, cz + d / 2 + 0.13));
    levels[2]!.push(box(w, 0.2, d, C.pale2, cx, H + 0.1, cz));
    this.labels[m0] = `Lane house ${n + 1}, ground floor`;
    this.labels[m0 + 1] = `Lane house ${n + 1}, first floor`;
    this.spots[m0] = V(cx, 0.5, cz);
    this.spots[m0 + 1] = V(cx, fh + 0.44, cz);
    this.addLevels(levels, 'live');
    if (n % 3 === 0) {
      this.sheet.level = 2;
      this.tank(cx, H + 0.2, cz - 0.4, 'live');
      this.sheet.level = 0;
    }
  }

  private waterTower(x: number, z: number): void {
    this.begin(x, z, 2.2, 2.2);
    const parts = [cyl(1.0, 1.0, 1.1, C.stone, x, 4.9, z, 16), tint(new THREE.ConeGeometry(1.05, 0.5, 16).translate(x, 5.7, z), C.stone), cyl(0.45, 0.6, 0.4, C.stone, x, 4.2, z, 12)];
    for (const [dx, dz] of [
      [-0.7, -0.7],
      [0.7, -0.7],
      [-0.7, 0.7],
      [0.7, 0.7],
    ] as const) {
      parts.push(cyl(0.08, 0.1, 4.4, C.stone, x + dx, 2.2, z + dz, 6));
      parts.push(rod(V(x + dx, 1.4, z + dz), V(x - dz, 2.8, z + dx), 0.03, C.inkSoft));
    }
    this.add(parts);
  }

  private market(rect: Rect): void {
    const n = Math.floor((rect.x1 - rect.x0) / 1.1);
    for (let i = 0; i < n; i++) {
      const x = rect.x0 + 0.55 + i * 1.1;
      const z = (rect.z0 + rect.z1) / 2;
      this.begin(x, z, 1.0, 0.8);
      const awning = [C.stone, C.mustard, C.pale2, C.white][i % 4]!;
      const parts = [box(0.9, 0.6, 0.6, C.warm, x, 0.3, z - 0.1), quad(0.7, 0.36, C.slate, x, 0.3, z + 0.21)];
      for (let k = 0; k < 4; k++) parts.push(box(0.12, 0.08, 0.12, [C.mustard, C.coral, C.leaf][k % 3]!, x - 0.3 + k * 0.2, 0.04, z + 0.36));
      this.add(parts);
      this.add(box(1.0, 0.03, 0.5, awning, x, 0.72, z + 0.3), 'paper', flapX(0.72, z + 0.05, 0.9));
    }
  }

  private temple(x: number, z: number): void {
    this.begin(x, z, 1.6, 1.6);
    const parts = [box(1.6, 0.25, 1.6, C.stone, x, 0.12, z), box(1.2, 0.9, 1.2, C.marble, x, 0.7, z), quad(0.4, 0.6, C.slate, x, 0.55, z + 0.61)];
    for (let k = 0; k < 4; k++) {
      const s = 1.0 - k * 0.2;
      parts.push(box(s, 0.38, s, k % 2 ? C.marble : C.stone, x, 1.3 + k * 0.36, z));
    }
    this.add(parts);
    this.add([cyl(0.04, 0.12, 0.3, C.mustard, x, 2.75, z, 8), rod(V(x, 2.6, z), V(x, 3.3, z), 0.015, C.slate), quad(0.26, 0.16, C.coral, x + 0.13, 3.2, z)], 'paper', pop(x, 2.6, z));
  }

  /** The distribution transformer: two poles, a platform, the tank with its fins and bushings, the fuse box. */
  private substation(x: number, z: number): void {
    this.begin(x, z, 1.4, 0.8, 0.3);
    const parts: THREE.BufferGeometry[] = [];
    for (const dx of [-0.55, 0.55]) parts.push(cyl(0.07, 0.09, 3.4, C.stone, x + dx, 1.7, z, 8));
    parts.push(box(1.4, 0.06, 0.7, C.slate, x, 1.55, z), box(0.7, 0.75, 0.45, 0x9aa6be, x, 1.97, z));
    for (let k = -0.25; k <= 0.25; k += 0.1) parts.push(box(0.04, 0.55, 0.06, 0x8692ad, x + k, 1.95, z + 0.25));
    for (const bx of [-0.2, 0, 0.2]) parts.push(cyl(0.04, 0.05, 0.25, C.white, x + bx, 2.47, z, 6));
    parts.push(box(1.6, 0.06, 0.08, C.slate, x, 3.2, z));
    for (const bx of [-0.6, 0, 0.6]) parts.push(cyl(0.04, 0.06, 0.18, C.white, x + bx, 3.32, z, 6));
    parts.push(box(0.36, 0.42, 0.14, C.white, x + 0.55, 0.9, z + 0.12), quad(0.16, 0.1, C.coral, x + 0.55, 0.9, z + 0.2));
    for (const bx of [-0.6, 0, 0.6]) parts.push(rod(V(x + bx, 3.4, z), V(x + bx - 2.0, 2.9, z + 3.3), 0.012, C.slate));
    this.add(parts);
  }

  /** A row of poles along a lane with sagging wires; `tangle` adds the wires that cross the lane. */
  private poles(x0: number, x1: number, z: number, tangle: boolean): void {
    this.begin((x0 + x1) / 2, z, 0, 0.2, 0.5);
    const parts: THREE.BufferGeometry[] = [];
    const xs: number[] = [];
    for (let x = x0; x <= x1 + 0.01; x += 2.6) xs.push(x);
    for (const x of xs) parts.push(cyl(0.05, 0.06, 3.0, C.stone, x, 1.5, z, 6), box(0.6, 0.05, 0.05, C.slate, x, 2.85, z));
    for (let i = 0; i + 1 < xs.length; i++)
      for (const [dz, dy] of [
        [-0.25, 2.88],
        [0.25, 2.88],
        [0, 2.6],
      ] as const) {
        const a = V(xs[i]!, dy, z + dz);
        const b = V(xs[i + 1]!, dy, z + dz);
        const m = a.clone().lerp(b, 0.5).setY(dy - 0.28);
        parts.push(rod(a, m, 0.012, C.slate), rod(m, b, 0.012, C.slate));
      }
    if (tangle)
      for (let i = 0; i < xs.length * 3; i++) {
        const a = V(xs[i % xs.length]!, 2.4 + this.random() * 0.4, z);
        const b = V(a.x + (this.random() - 0.5) * 3, 1.6 + this.random() * 0.8, z + 1.5 + this.random() * 2.4);
        const m = a.clone().lerp(b, 0.5);
        m.y -= 0.35;
        parts.push(rod(a, m, 0.01, C.slate), rod(m, b, 0.01, C.slate));
      }
    this.add(parts, 'wire');
  }

  // ---- the old city ----

  private oldCity(): void {
    this.fort(-42, -28);
    this.trees(R(-48, -25.6, -36, -21.8), 7, 'ashoka');
    this.mosque(-26, -26.4);
    for (let x = -32; x < -20; x += 2.4) this.haveli(x, -22.4, 2.2, 1.6);
    // the bazaar: havelis close on both sides of a lane strung with wires
    for (const z of [-28.6, -23.4]) {
      let x = -16.3;
      while (x < -3.5) {
        const w = 1.4 + this.random() * 1.0;
        this.haveli(x + w / 2, z, w - 0.1, 2.4);
        x += w;
      }
    }
    this.poles(-16, -3.2, -26.8, true);
    this.gurudwara(11.5, -27.6);
    for (let x = 6.4; x < 17; x += 2.1) this.haveli(x, -22.6, 1.9, 1.6);
    this.trees(R(6, -30, 8, -25), 3);
    this.minarTower(39, -26.4);
    this.trees(R(36, -30, 42, -22), 6, 'neem');
  }

  /** An old haveli: two or three floors, arched shopfronts, jharokhas, sometimes a small dome on the parapet. */
  private haveli(cx: number, cz: number, w: number, d: number): void {
    const floors = 2 + Math.floor(this.random() * 2);
    const fh = 0.9;
    const H = floors * fh;
    const skin = [C.white, C.pale, C.warm, C.stone, C.pale2][Math.floor(this.random() * 5)]!;
    this.begin(cx, cz, w, d);
    const z = cz + d / 2 + 0.01;
    const parts: THREE.BufferGeometry[] = [box(w, H, d, skin, cx, H / 2, cz), box(w + 0.06, 0.16, d + 0.06, C.stone, cx, H + 0.08, cz)];
    const bays = Math.max(1, Math.round(w / 0.7));
    for (let b = 0; b < bays; b++) {
      const bx = cx - w / 2 + (w / bays) * (b + 0.5);
      parts.push(arch(bx, 0, 0.44, 0.62, C.slate, z));
      for (let f = 1; f < floors; f++) {
        if (this.random() < 0.4) parts.push(box(0.46, 0.4, 0.22, C.pale2, bx, f * fh + 0.45, cz + d / 2 + 0.11), quad(0.3, 0.26, this.mondrian(), bx, f * fh + 0.46, cz + d / 2 + 0.23));
        else parts.push(quad(0.28, 0.4, this.mondrian(), bx, f * fh + 0.46, z));
      }
    }
    this.add(parts);
    if (this.random() < 0.3) this.add(dome(0.22, C.marble, cx - w / 2 + 0.3, H + 0.16, cz + d / 2 - 0.3), 'paper', pop(cx - w / 2 + 0.3, H + 0.16, cz + d / 2 - 0.3));
    if (this.random() < 0.35) this.kiteAnchors.push(V(cx, H + 0.3, cz));
  }

  /** A sandstone fort wall with merlons, round bastions and a tall gate flying the flag. */
  private fort(cx: number, cz: number): void {
    const len = 12.6;
    this.begin(cx, cz, len, 1.6);
    const parts: THREE.BufferGeometry[] = [box(len, 2.2, 1.0, C.sandstone, cx, 1.1, cz)];
    for (let x = cx - len / 2 + 0.2; x < cx + len / 2; x += 0.5) parts.push(box(0.25, 0.25, 1.0, C.sandstone2, x, 2.32, cz));
    for (const bx of [cx - len / 2, cx - len / 4, cx + len / 4, cx + len / 2]) parts.push(cyl(0.7, 0.8, 2.6, C.sandstone2, bx, 1.3, cz + 0.2, 14));
    parts.push(box(2.6, 3.4, 1.6, C.sandstone, cx, 1.7, cz + 0.2), arch(cx, 0, 1.0, 2.0, C.slate, cz + 1.01), quad(1.8, 0.12, C.marble, cx, 2.6, cz + 1.01));
    this.add(parts);
    for (const dx of [-0.8, 0.8]) this.add([cyl(0.32, 0.32, 0.4, C.marble, cx + dx, 3.6, cz + 0.2, 10), dome(0.36, C.marble, cx + dx, 3.8, cz + 0.2)], 'paper', pop(cx + dx, 3.4, cz + 0.2));
    this.flag(cx, 3.4, cz + 0.2, 2.2, 0.9);
  }

  /** The national flag on a pole: three bands and the wheel, in the quiet palette. */
  private flag(x: number, y: number, z: number, pole: number, size: number): void {
    const h = size * 0.66;
    const top = y + pole;
    this.add(
      [
        cyl(0.03, 0.04, pole, C.slate, x, y + pole / 2, z, 6),
        quad(size, h / 3, 0xe8b07c, x + size / 2, top - h / 6, z),
        quad(size, h / 3, C.white, x + size / 2, top - h / 2, z),
        quad(size, h / 3, 0x9cb88c, x + size / 2, top - (5 * h) / 6, z),
        tint(new THREE.RingGeometry(h * 0.1, h * 0.13, 16).translate(x + size / 2, top - h / 2, z + 0.005), C.ink),
      ],
      'paper',
      pop(x, y, z),
    );
  }

  private mosque(cx: number, cz: number): void {
    this.begin(cx, cz, 7.4, 4.2);
    const parts: THREE.BufferGeometry[] = [box(7.4, 0.6, 4.2, C.sandstone, cx, 0.3, cz), box(5.4, 2.2, 2.2, C.sandstone, cx, 1.7, cz - 0.6)];
    for (const ax of [-1.8, -0.9, 0, 0.9, 1.8]) parts.push(ax === 0 ? arch(cx, 0.6, 0.84, 1.85, C.marble, cz + 0.51) : arch(cx + ax, 0.6, 0.6, 1.35, C.marble, cz + 0.51));
    parts.push(box(5.6, 0.18, 2.3, C.marble, cx, 2.86, cz - 0.6));
    this.add(parts);
    for (const [dx, r] of [
      [-1.8, 0.65],
      [0, 0.95],
      [1.8, 0.65],
    ] as const)
      this.add([cyl(r * 0.85, r * 0.85, 0.35, C.marble, cx + dx, 3.12, cz - 0.6, 14), dome(r, C.marble, cx + dx, 3.28, cz - 0.6, 1.35), cyl(0.02, 0.05, 0.35, C.mustard, cx + dx, 3.28 + r * 1.35 + 0.15, cz - 0.6, 6)], 'paper', pop(cx + dx, 2.95, cz - 0.6));
    for (const dx of [-3.1, 3.1]) {
      const p: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 6; k++) p.push(cyl(0.26 - k * 0.012, 0.28 - k * 0.012, 0.8, k % 2 ? C.marble : C.sandstone, cx + dx, 1.0 + k * 0.8, cz - 0.6, 12));
      p.push(cyl(0.38, 0.38, 0.08, C.marble, cx + dx, 3.0, cz - 0.6, 12), cyl(0.3, 0.3, 0.4, C.marble, cx + dx, 5.6, cz - 0.6, 8), dome(0.3, C.marble, cx + dx, 5.8, cz - 0.6, 1.2));
      this.add(p);
    }
  }

  private gurudwara(cx: number, cz: number): void {
    this.begin(cx, cz, 3.6, 3.0);
    const parts = [box(3.6, 0.3, 3.0, C.marble, cx, 0.15, cz), box(3.0, 1.8, 2.4, C.white, cx, 1.2, cz), quad(0.7, 1.0, C.slate, cx, 0.8, cz + 1.21)];
    for (const k of [-1, 1]) parts.push(quad(0.4, 0.5, C.window, cx + k * 0.9, 1.4, cz + 1.21));
    this.add(parts);
    this.add([cyl(0.7, 0.8, 0.4, C.white, cx, 2.3, cz, 14), dome(0.8, C.mustard, cx, 2.5, cz, 1.3), cyl(0.02, 0.05, 0.4, C.mustard, cx, 3.75, cz, 6)], 'paper', pop(cx, 2.1, cz));
    for (const [dx, dz] of [
      [-1.3, -1.0],
      [1.3, -1.0],
      [-1.3, 1.0],
      [1.3, 1.0],
    ] as const)
      this.add(dome(0.24, C.mustard, cx + dx, 2.1, cz + dz, 1.3), 'paper', pop(cx + dx, 2.1, cz + dz));
  }

  /** A fluted victory tower: five tapering storeys with balconies. */
  private minarTower(cx: number, cz: number): void {
    this.begin(cx, cz, 2.4, 2.4);
    const parts: THREE.BufferGeometry[] = [cyl(1.4, 1.5, 0.3, C.stone, cx, 0.15, cz, 20)];
    let y = 0.3;
    let r = 1.0;
    for (let k = 0; k < 5; k++) {
      const h = 2.4 - k * 0.25;
      parts.push(cyl(r * 0.84, r, h, k < 3 ? C.sandstone : C.marble, cx, y + h / 2, cz, 16));
      y += h;
      r *= 0.84;
      parts.push(cyl(r + 0.22, r + 0.18, 0.1, C.stone, cx, y + 0.05, cz, 16));
    }
    for (let k = 0; k < 4; k++) parts.push(box(0.5, 0.8 + k * 0.2, 0.3, C.sandstone2, cx - 2.2 + k * 0.4, 0.4 + k * 0.1, cz + 1.7));
    this.add(parts);
    this.add(cyl(0.12, 0.2, 0.5, C.marble, cx, y + 0.3, cz, 8), 'paper', pop(cx, y, cz));
  }

  // ---- the circle: a two-ring colonnade around a park ----

  private circle(cx: number, cz: number): void {
    const ring = (radius: number, depth: number, height: number, parts: number) => {
      for (let s = 0; s < 6; s++) {
        const a0 = (s / 6) * Math.PI * 2 + Math.PI / 6 + 0.16;
        const a1 = ((s + 1) / 6) * Math.PI * 2 + Math.PI / 6 - 0.16;
        for (let p = 0; p < parts; p++) {
          const a = a0 + ((p + 0.5) / parts) * (a1 - a0);
          const len = (radius * (a1 - a0)) / parts + 0.05;
          const x = cx + Math.cos(a) * radius;
          const z = cz + Math.sin(a) * radius;
          const g: THREE.BufferGeometry[] = [box(len, height, depth, C.marble, 0, height / 2, 0), box(len + 0.04, 0.12, depth + 0.3, C.white, 0, height + 0.06, 0.15)];
          for (let cxx = -len / 2 + 0.15; cxx < len / 2; cxx += 0.32) g.push(box(0.1, height - 0.2, 0.1, C.white, cxx, (height - 0.2) / 2, depth / 2 + 0.25));
          g.push(quad(len, height - 0.25, C.pale2, 0, (height - 0.25) / 2, depth / 2 + 0.01));
          for (let wx = -len / 2 + 0.3; wx < len / 2 - 0.2; wx += 0.5) g.push(quad(0.24, 0.3, C.window, wx, height - 0.55, depth / 2 + 0.02), quad(0.24, 0.3, C.window, wx, height - 0.55, -depth / 2 - 0.01));
          for (const geo of g) geo.rotateY(-a + Math.PI / 2).translate(x, 0, z);
          this.begin(x, z, 0, depth);
          this.add(g);
        }
      }
    };
    ring(10.1, 2.0, 2.0, 4);
    ring(6.5, 1.8, 1.8, 3);
    this.flag(cx, 0, cz, 8.5, 2.6);
    this.trees(R(cx - 3, cz - 3, cx + 3, cz + 3), 7, 'neem');
    for (const [x, z] of [
      [7, -16.5],
      [31, -16.5],
      [7, 7.5],
      [31, 7.5],
    ] as const)
      this.trees(R(x - 1.2, z - 1, x + 1.2, z + 1), 3);
  }

  // ---- the ceremonial axis: a lawn avenue with canals, a memorial gate at one end, a domed palace at the other ----

  private ceremonial(): void {
    this.gate(-8.6, 21);
    this.chhatri(-4.2, 21);
    this.palace(-42.4, 21);
    for (let x = -46; x < -11; x += 2.4) for (const z of [16.4, 25.6]) this.tree(x, z, 'neem', 1.2);
  }

  private gate(cx: number, cz: number): void {
    const stone = 0xe6d6bd;
    this.begin(cx, cz, 4.0, 1.4);
    const parts: THREE.BufferGeometry[] = [];
    for (const dx of [-1.25, 1.25]) parts.push(box(1.3, 4.0, 1.4, stone, cx + dx, 2.0, cz));
    parts.push(box(3.9, 1.0, 1.4, stone, cx, 4.5, cz), box(4.1, 0.14, 1.6, C.stone, cx, 5.05, cz), box(3.4, 0.5, 1.2, stone, cx, 5.35, cz), box(3.6, 0.1, 1.3, C.stone, cx, 5.62, cz));
    parts.push(arch(cx, 0, 1.2, 3.75, C.white, cz + 0.71), quad(3.2, 0.3, C.stone, cx, 4.55, cz + 0.71));
    this.add(parts);
    this.add(tint(new THREE.SphereGeometry(0.7, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1).translate(cx, 5.67, cz), stone), 'paper', pop(cx, 5.67, cz));
  }

  private chhatri(cx: number, cz: number): void {
    this.begin(cx, cz, 1.6, 1.6);
    const parts = [box(1.6, 0.2, 1.6, C.stone, cx, 0.1, cz)];
    for (const [dx, dz] of [
      [-0.6, -0.6],
      [0.6, -0.6],
      [-0.6, 0.6],
      [0.6, 0.6],
    ] as const)
      parts.push(box(0.14, 1.6, 0.14, C.stone, cx + dx, 1.0, cz + dz));
    parts.push(box(1.7, 0.18, 1.7, C.stone, cx, 1.88, cz));
    this.add(parts);
    this.add(dome(0.7, C.stone, cx, 1.97, cz, 1.1), 'paper', pop(cx, 1.97, cz));
  }

  private palace(cx: number, cz: number): void {
    this.begin(cx, cz, 10, 3.4);
    const parts: THREE.BufferGeometry[] = [box(10, 1.2, 3.4, C.sandstone, cx, 0.6, cz), box(9.4, 1.4, 3.0, C.warm, cx, 1.9, cz), box(10, 0.14, 3.4, C.stone, cx, 2.66, cz)];
    for (let x = cx - 4.4; x <= cx + 4.4; x += 0.4) parts.push(box(0.1, 1.3, 0.1, C.white, x, 1.9, cz + 1.6));
    parts.push(box(3.0, 0.6, 2.4, C.warm, cx, 3.0, cz));
    this.add(parts);
    this.add([cyl(1.0, 1.0, 0.6, C.warm, cx, 3.6, cz, 18), tint(new THREE.SphereGeometry(1.0, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.75, 1).translate(cx, 3.9, cz), 0xc9a68c)], 'paper', pop(cx, 3.3, cz));
    this.flag(cx, 4.65, cz, 1.0, 0.6);
  }

  // ---- gardens: a tomb with a white dome, and a lotus of marble petals ----

  private gardens(): void {
    this.tomb(12, 21.5);
    this.lotus(26, 21.4);
    this.trees(R(6, 13, 32, 15.8), 9);
    this.trees(R(6, 28, 32, 30.6), 8);
    this.trees(R(17.6, 16, 20.4, 28), 4, 'ashoka');
  }

  private tomb(cx: number, cz: number): void {
    this.begin(cx, cz, 6.4, 6.4);
    const parts: THREE.BufferGeometry[] = [box(6.4, 0.9, 6.4, C.sandstone, cx, 0.45, cz)];
    for (let k = -2; k <= 2; k++) parts.push(arch(cx + k * 1.2, 0.1, 0.76, 0.7, C.marble, cz + 3.21));
    parts.push(box(3.8, 2.4, 3.8, C.sandstone, cx, 2.1, cz));
    for (const k of [-1, 0, 1]) parts.push(arch(cx + k * 1.2, 1.1, k ? 0.72 : 1.0, k ? 1.55 : 2.0, C.marble, cz + 1.91));
    parts.push(cyl(1.2, 1.25, 0.7, C.marble, cx, 3.65, cz, 18));
    this.add(parts);
    this.add([dome(1.3, C.marble, cx, 4.0, cz, 1.15), cyl(0.03, 0.08, 0.6, C.mustard, cx, 5.7, cz, 6)], 'paper', pop(cx, 3.9, cz));
    for (const [dx, dz] of [
      [-1.6, -1.6],
      [1.6, -1.6],
      [-1.6, 1.6],
      [1.6, 1.6],
    ] as const)
      this.add([cyl(0.3, 0.3, 0.5, C.marble, cx + dx, 3.55, cz + dz, 10), dome(0.32, C.marble, cx + dx, 3.8, cz + dz)], 'paper', pop(cx + dx, 3.3, cz + dz));
  }

  private lotus(cx: number, cz: number): void {
    this.begin(cx, cz, 7, 7);
    const parts: THREE.BufferGeometry[] = [cyl(3.4, 3.6, 0.5, C.marble, cx, 0.25, cz, 28), cyl(2.6, 2.6, 0.3, C.stone, cx, 0.65, cz, 28)];
    const petal = (ring: number, k: number, tilt: number, size: number, y: number) => {
      const g = new THREE.SphereGeometry(1, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.55 * size, 1.9 * size, 0.28 * size);
      g.rotateX(-tilt);
      g.translate(0, 0, ring);
      g.rotateY((k / 9) * Math.PI * 2 + (ring > 1.5 ? Math.PI / 9 : 0));
      g.translate(cx, y, cz);
      return tint(g, C.marble);
    };
    for (let k = 0; k < 9; k++) parts.push(petal(2.0, k, 0.55, 1.0, 0.7), petal(1.2, k, 0.3, 1.1, 0.8), petal(0.5, k, 0.08, 1.05, 0.9));
    this.add(parts);
  }

  // ---- the elevated metro along the arterial, with a station at the crossing ----

  private metro(): void {
    const x = 3.4;
    for (let z = -29.6; z < 30; z += 4.4) {
      this.begin(x, z, 0, 0.8, 0.12 + 0.36 * ((z - BACK) / SHEET.d));
      const len = Math.min(4.4, 30 - z);
      this.add([
        cyl(0.32, 0.36, 3.0, C.stone, x, 1.5, z, 10),
        box(1.6, 0.4, 0.7, C.stone, x, 3.1, z),
        box(2.0, 0.34, len, C.white, x, 3.47, z + len / 2),
        box(0.08, 0.3, len, C.pale2, x - 1.0, 3.75, z + len / 2),
        box(0.08, 0.3, len, C.pale2, x + 1.0, 3.75, z + len / 2),
      ]);
    }
    this.begin(x, -4, 3.4, 5.2, 0.3);
    this.add([
      box(3.4, 0.2, 5.2, C.white, x, 3.7, -4),
      box(3.4, 1.0, 0.1, C.glass, x, 4.3, -6.55),
      box(0.1, 1.0, 5.2, C.glass, x - 1.65, 4.3, -4),
      box(0.1, 1.0, 5.2, C.glass, x + 1.65, 4.3, -4),
      tint(new THREE.CylinderGeometry(1.9, 1.9, 5.4, 18, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).scale(1, 0.45, 1).translate(x, 4.8, -4), C.pale),
      box(0.8, 0.12, 3.4, C.stone, x - 2.2, 1.8, -5.8),
      box(0.8, 0.12, 3.4, C.stone, x - 2.2, 1.8, -2.6),
    ]);
  }

  // ---- the river and its cable-stayed bridge ----

  private river(): void {
    const z = -11;
    this.begin(46.5, z, 7.6, 1.8, 0.25);
    const parts: THREE.BufferGeometry[] = [box(7.6, 0.35, 1.8, C.white, 46.2, 0.6, z)];
    for (const px of [43.4, 49]) parts.push(cyl(0.25, 0.3, 0.6, C.stone, px, 0.3, z, 8));
    const top = V(46.0, 9.5, z - 0.2);
    parts.push(rod(V(45.3, 0.6, z - 0.7), top, 0.16, C.stone), rod(V(45.3, 0.6, z + 0.7), top, 0.16, C.stone), rod(top, V(46.0, 10.6, z - 0.4), 0.12, C.stone));
    for (let k = 0; k < 9; k++) {
      const p = V(46.0, 9.5 - (0.15 + k * 0.1) * 3, z - 0.2);
      parts.push(rod(p, V(43 + k * 0.8, 0.78, z + 0.6), 0.015, C.slate), rod(p, V(43 + k * 0.8, 0.78, z - 0.6), 0.015, C.slate));
    }
    this.add(parts);
    // ghats down to the water on the near bank
    this.begin(42.2, 24, 1.2, 6);
    const steps: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) steps.push(box(1.2 - k * 0.25, 0.12, 6, C.stone, 42.4 + k * 0.12, 0.06 + k * 0.12, 24));
    steps.push(cyl(0.4, 0.4, 0.5, C.stone, 42, 0.95, 22), dome(0.42, C.marble, 42, 1.2, 22));
    this.add(steps);
  }

  /** Fill a block with ordinary houses and trees, none of them on the live feeder. */
  private colony(rect: Rect, school = false): void {
    let z0 = rect.z0;
    if (school) {
      const x = rect.x0 + 3.6;
      const z = rect.z0 + 1.6;
      this.begin(x, z, 6.4, 2.0);
      const parts: THREE.BufferGeometry[] = [box(6.4, 1.8, 2.0, C.warm, x, 0.9, z), box(6.6, 0.1, 2.2, C.sandstone, x, 1.85, z)];
      for (let k = -2.7; k <= 2.7; k += 0.6) parts.push(quad(0.34, 0.36, C.window, x + k, 0.5, z + 1.01), quad(0.34, 0.36, C.window, x + k, 1.3, z + 1.01));
      this.add(parts);
      this.flag(x + 3.6, 0, z + 1.6, 2.6, 0.7);
      z0 = rect.z0 + 4;
    }
    const cols = Math.max(1, Math.floor((rect.x1 - rect.x0) / 2.7));
    const rows = Math.max(1, Math.floor((rect.z1 - z0) / 3.0));
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = rect.x0 + (rect.x1 - rect.x0) * ((c + 0.5) / cols);
        const z = z0 + (rect.z1 - z0) * ((r + 0.5) / rows);
        if (this.random() < 0.12) this.tree(x, z);
        else this.builderFloor(x, z, 0, false);
      }
    this.trees(rect, Math.round(((rect.x1 - rect.x0) * (rect.z1 - rect.z0)) / 40));
  }
}
