// Canvas-drawn paper: the printed map on the floor sheet, the skyline page that folds up behind the city, the tree
// cards, the sky and the table. Everything is drawn once at load in world units, so the print lines up with the pieces.
import * as THREE from 'three';

export const SHEET = { w: 100, d: 66 };
export const PAGE_H = 38; // the skyline page's height
const PX = 24; // canvas pixels per world unit on the floor

const INK = '#3d5da8';
const PINK = '#e0457e';
const inkA = (a: number) => `rgba(61,93,168,${a})`;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** A halftone dot field over the current clip, the riso way of printing a tint. */
function dots(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string, step = 7, r = 1.2): void {
  g.fillStyle = colour;
  for (let j = 0, yy = y; yy < y + h + step; j++, yy += step * 0.866)
    for (let xx = x + (j % 2 ? step / 2 : 0); xx < x + w + step; xx += step) {
      g.beginPath();
      g.arc(xx, yy, r, 0, 7);
      g.fill();
    }
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface MapSpec {
  roads: Rect[];
  lanes: Rect[]; // narrow lanes without a centre line
  blocks: Rect[];
  lawns: Rect[];
  water: Rect[];
  plazas: Rect[];
  ring: { x: number; z: number; roads: [number, number][]; park: number; spokes: number };
  live: Rect;
  footprints: Rect[];
}

/** The printed floor: blocks, roads, lawns, the river, the circle, and the dashed edge of the live feeder. */
export function mapTexture(spec: MapSpec): THREE.CanvasTexture {
  const W = SHEET.w * PX;
  const H = SHEET.d * PX;
  const [c, g] = canvas(W, H);
  const X = (x: number) => (x + SHEET.w / 2) * PX;
  const Z = (z: number) => (z + SHEET.d / 2) * PX;
  const R = (r: Rect) => [X(r.x0), Z(r.z0), (r.x1 - r.x0) * PX, (r.z1 - r.z0) * PX] as const;
  const fill = (r: Rect, colour: string) => {
    g.fillStyle = colour;
    g.fillRect(...R(r));
  };
  const tint = (r: Rect, colour: string, step: number, rad: number) => {
    g.save();
    g.beginPath();
    g.rect(...R(r));
    g.clip();
    dots(g, ...R(r), colour, step, rad);
    g.restore();
  };

  g.fillStyle = '#e9edee';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = inkA(0.05);
  g.lineWidth = 1;
  for (let x = 0; x < W; x += PX * 2) (g.beginPath(), g.moveTo(x, 0), g.lineTo(x, H), g.stroke());
  for (let y = 0; y < H; y += PX * 2) (g.beginPath(), g.moveTo(0, y), g.lineTo(W, y), g.stroke());

  for (const b of spec.blocks) {
    fill(b, '#d3e0e9');
    tint(b, inkA(0.12), 7, 1.2);
    g.strokeStyle = inkA(0.45);
    g.lineWidth = 1.6;
    g.strokeRect(...R(b));
  }
  for (const l of spec.lawns) {
    fill(l, '#b9d38f');
    tint(l, 'rgba(80,130,50,.25)', 7, 1.4);
    g.strokeStyle = inkA(0.35);
    g.lineWidth = 1.4;
    g.strokeRect(...R(l));
  }
  for (const p of spec.plazas) {
    fill(p, '#ede6de');
    g.strokeStyle = inkA(0.3);
    g.strokeRect(...R(p));
  }

  // the circle: a park in the middle, ring roads and spokes
  const ring = spec.ring;
  const cx = X(ring.x);
  const cz = Z(ring.z);
  g.fillStyle = '#d3e0e9';
  g.beginPath();
  g.arc(cx, cz, ring.roads.at(-1)![1] * PX, 0, 7);
  g.fill();
  for (const [r0, r1] of ring.roads) {
    g.strokeStyle = '#ede6de';
    g.lineWidth = (r1 - r0) * PX;
    g.beginPath();
    g.arc(cx, cz, ((r0 + r1) / 2) * PX, 0, 7);
    g.stroke();
    g.strokeStyle = inkA(0.4);
    g.lineWidth = 1.4;
    for (const r of [r0, r1]) (g.beginPath(), g.arc(cx, cz, r * PX, 0, 7), g.stroke());
  }
  for (let k = 0; k < ring.spokes; k++) {
    const a = (k / ring.spokes) * Math.PI * 2 + Math.PI / ring.spokes;
    g.save();
    g.translate(cx, cz);
    g.rotate(a);
    g.fillStyle = '#ede6de';
    g.fillRect(ring.park * PX, -0.7 * PX, (ring.roads.at(-1)![1] - ring.park) * PX, 1.4 * PX);
    g.restore();
  }
  g.fillStyle = '#b9d38f';
  g.beginPath();
  g.arc(cx, cz, ring.park * PX, 0, 7);
  g.fill();
  g.strokeStyle = inkA(0.4);
  g.stroke();

  for (const w of spec.water) {
    fill(w, '#9fbbe0');
    tint(w, 'rgba(255,255,255,.6)', 8, 1.6);
    g.strokeStyle = inkA(0.4);
    g.lineWidth = 1.4;
    g.strokeRect(...R(w));
  }

  // roads: paper white, inked edges, a dashed centre line
  for (const r of [...spec.roads, ...spec.lanes]) fill(r, '#ede6de');
  g.lineWidth = 1.4;
  g.strokeStyle = inkA(0.45);
  for (const r of [...spec.roads, ...spec.lanes]) g.strokeRect(...R(r));
  g.strokeStyle = inkA(0.6);
  g.lineWidth = 2;
  g.setLineDash([14, 14]);
  for (const r of spec.roads) {
    g.beginPath();
    if (r.x1 - r.x0 > r.z1 - r.z0) {
      const z = Z((r.z0 + r.z1) / 2);
      g.moveTo(X(r.x0), z);
      g.lineTo(X(r.x1), z);
    } else {
      const x = X((r.x0 + r.x1) / 2);
      g.moveTo(x, Z(r.z0));
      g.lineTo(x, Z(r.z1));
    }
    g.stroke();
  }
  g.setLineDash([]);

  // cut lines where pieces stand
  g.strokeStyle = inkA(0.38);
  g.setLineDash([5, 4]);
  g.lineWidth = 1.2;
  for (const f of spec.footprints) g.strokeRect(...R(f));
  g.setLineDash([]);

  // the live feeder's edge and its label
  g.strokeStyle = PINK;
  g.lineWidth = 3.5;
  g.setLineDash([16, 10]);
  g.strokeRect(...R({ x0: spec.live.x0 - 0.5, z0: spec.live.z0 - 0.5, x1: spec.live.x1 + 0.5, z1: spec.live.z1 + 0.5 }));
  g.setLineDash([]);
  g.fillStyle = PINK;
  g.font = '800 20px "Plus Jakarta Sans", sans-serif';
  g.fillText('FEEDER 01  ·  240 METERS  ·  ONE TRANSFORMER', X(spec.live.x0), Z(spec.live.z1 + 1.6));

  // the stamp and the imprint
  g.save();
  g.translate(X(-47.6), Z(28.6));
  g.rotate(-0.03);
  g.strokeStyle = PINK;
  g.fillStyle = PINK;
  g.lineWidth = 5;
  roundRect(g, 0, 0, 170, 60, 12);
  g.stroke();
  g.lineWidth = 2;
  roundRect(g, 6, 6, 158, 48, 8);
  g.stroke();
  g.font = '800 34px "Plus Jakarta Sans", sans-serif';
  g.fillText('No. 01', 22, 43);
  g.restore();
  g.fillStyle = INK;
  g.font = '500 16px "IBM Plex Mono", monospace';
  g.fillText('A POP-UP BOOK ABOUT THE GRID  ·  PLATE 01', X(-38.6), Z(30.4));
  return texture(c);
}

/**
 * The skyline page that folds up behind the city: a cut-out silhouette of domes, minarets, a tower and high-rises,
 * printed in pale blue with ink lines, with a muted sun behind. 100 x 38 world units.
 */
export function skylineTexture(): THREE.CanvasTexture {
  const S = 20;
  const W = SHEET.w * S;
  const H = PAGE_H * S;
  const [c, g] = canvas(W, H);
  const r = mulberry(11);
  const base = H;
  const ink = (lw = 3) => {
    g.strokeStyle = INK;
    g.lineWidth = lw;
    g.stroke();
  };
  const body = (fill: string) => {
    g.fillStyle = fill;
    g.fill();
  };
  const grid = (x: number, y: number, w: number, h: number, cell = 22) => {
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.strokeStyle = inkA(0.45);
    g.lineWidth = 1.5;
    for (let xx = x + cell * 0.6; xx < x + w; xx += cell) for (let yy = y + cell * 0.6; yy < y + h - 6; yy += cell * 1.2) {
      g.strokeRect(xx, yy, cell * 0.5, cell * 0.7);
      if (r() < 0.06) {
        const k = r();
        g.fillStyle = k < 0.4 ? '#f2c14e' : k < 0.75 ? '#e9524a' : '#2e59b5';
        g.fillRect(xx, yy, cell * 0.5, cell * 0.7);
      }
    }
    g.restore();
  };

  // the sun, cut into the page
  g.fillStyle = '#f35a56';
  g.beginPath();
  g.arc(W * 0.66, H * 0.34, 140, 0, 7);
  g.fill();
  g.fillStyle = 'rgba(248,137,122,.75)';
  for (let y = H * 0.34 - 220; y < H * 0.34 + 220; y += 10)
    for (let x = W * 0.66 - 220; x < W * 0.66 + 220; x += 10) {
      const d = Math.hypot(x - W * 0.66, y - H * 0.34);
      if (d > 146 && d < 220) {
        g.beginPath();
        g.arc(x, y, 2.6 * (1 - (d - 146) / 74) + 0.4, 0, 7);
        g.fill();
      }
    }

  // far layer of towers across the whole page
  let x = 0;
  while (x < W) {
    const w = 70 + r() * 110;
    const h = 200 + r() * 360;
    g.beginPath();
    g.rect(x, base - h, w - 12, h);
    body('#d3e0e9');
    ink(2.5);
    grid(x, base - h, w - 12, h);
    x += w;
  }

  // landmarks in front of the towers
  const minaret = (mx: number, h: number) => {
    g.beginPath();
    g.moveTo(mx - 16, base);
    g.lineTo(mx - 12, base - h);
    g.lineTo(mx + 12, base - h);
    g.lineTo(mx + 16, base);
    g.closePath();
    body('#f3f1ec');
    ink();
    for (let k = 1; k < 4; k++) {
      g.beginPath();
      g.rect(mx - 20, base - (h * k) / 4 - 6, 40, 8);
      body('#f3f1ec');
      ink(2);
    }
    g.beginPath();
    g.arc(mx, base - h, 16, Math.PI, 0);
    body('#f3f1ec');
    ink(2);
  };
  const onion = (ox: number, oy: number, rad: number, fill: string) => {
    g.beginPath();
    g.moveTo(ox - rad, oy);
    g.bezierCurveTo(ox - rad * 1.2, oy - rad * 1.1, ox - rad * 0.2, oy - rad * 1.3, ox, oy - rad * 1.9);
    g.bezierCurveTo(ox + rad * 0.2, oy - rad * 1.3, ox + rad * 1.2, oy - rad * 1.1, ox + rad, oy);
    g.closePath();
    body(fill);
    ink();
  };
  // a mosque: hall, three domes, two minarets
  const mq = W * 0.2;
  g.beginPath();
  g.rect(mq - 230, base - 210, 460, 210);
  body('#f1e2d6');
  ink();
  onion(mq - 140, base - 210, 70, '#f3f1ec');
  onion(mq + 140, base - 210, 70, '#f3f1ec');
  onion(mq, base - 210, 105, '#f3f1ec');
  minaret(mq - 270, 440);
  minaret(mq + 270, 440);
  // a fluted tower
  const qt = W * 0.86;
  for (let k = 0; k < 5; k++) {
    const y0 = base - k * 130;
    const w0 = 120 - k * 18;
    g.beginPath();
    g.moveTo(qt - w0 / 2, y0);
    g.lineTo(qt - (w0 - 14) / 2, y0 - 130);
    g.lineTo(qt + (w0 - 14) / 2, y0 - 130);
    g.lineTo(qt + w0 / 2, y0);
    g.closePath();
    body('#ecc7b2');
    ink();
    for (let f = -2; f <= 2; f++) {
      g.beginPath();
      g.moveTo(qt + f * (w0 / 6), y0);
      g.lineTo(qt + f * ((w0 - 14) / 6), y0 - 130);
      g.strokeStyle = inkA(0.4);
      g.lineWidth = 1.5;
      g.stroke();
    }
    g.beginPath();
    g.rect(qt - w0 / 2 - 8, y0 - 136, w0 + 16, 10);
    body('#f3f1ec');
    ink(2);
  }
  // a tomb with a big dome
  const tb = W * 0.5;
  g.beginPath();
  g.rect(tb - 200, base - 230, 400, 230);
  body('#ecc7b2');
  ink();
  for (const ax of [-120, 0, 120]) {
    g.beginPath();
    g.moveTo(tb + ax - 40, base - 20);
    g.lineTo(tb + ax - 40, base - 150);
    g.quadraticCurveTo(tb + ax, base - 210, tb + ax + 40, base - 150);
    g.lineTo(tb + ax + 40, base - 20);
    body('#f3f1ec');
    ink(2);
  }
  onion(tb, base - 230, 120, '#f3f1ec');
  // a water tank on legs, the most ordinary landmark there is
  const wt = W * 0.37;
  g.beginPath();
  g.rect(wt - 80, base - 420, 160, 120);
  body('#f3f1ec');
  ink();
  for (const lx of [-60, -20, 20, 60]) {
    g.beginPath();
    g.moveTo(wt + lx, base - 300);
    g.lineTo(wt + lx * 1.4, base);
    ink(4);
  }
  // kites over the skyline
  for (let k = 0; k < 7; k++) {
    const kx = W * (0.08 + 0.13 * k + r() * 0.05);
    const ky = H * (0.08 + r() * 0.25);
    g.save();
    g.translate(kx, ky);
    g.rotate((r() - 0.5) * 0.6);
    g.beginPath();
    g.moveTo(0, -22);
    g.lineTo(18, 0);
    g.lineTo(0, 26);
    g.lineTo(-18, 0);
    g.closePath();
    body(k % 3 === 0 ? '#f2c14e' : k % 3 === 1 ? '#f3f1ec' : '#e9524a');
    ink(2);
    g.beginPath();
    g.moveTo(0, 26);
    g.quadraticCurveTo(30, 120, -10, 260);
    g.strokeStyle = inkA(0.5);
    g.lineWidth = 1.2;
    g.stroke();
    g.restore();
  }
  return texture(c);
}

/** The mid layer: a long strip of cut-out buildings standing just in front of the skyline page. */
export function layerTexture(): THREE.CanvasTexture {
  const S = 20;
  const W = SHEET.w * S;
  const H = 14 * S;
  const [c, g] = canvas(W, H);
  const r = mulberry(23);
  let x = 0;
  while (x < W) {
    const w = 60 + r() * 90;
    const h = 90 + r() * 180;
    g.fillStyle = '#e9edee';
    g.fillRect(x, H - h, w - 6, h);
    g.strokeStyle = INK;
    g.lineWidth = 2.5;
    g.strokeRect(x, H - h, w - 6, h);
    g.strokeStyle = inkA(0.45);
    g.lineWidth = 1.4;
    for (let yy = H - h + 14; yy < H - 18; yy += 24)
      for (let xx = x + 10; xx < x + w - 22; xx += 20) {
        g.strokeRect(xx, yy, 9, 13);
        if (r() < 0.07) {
          g.fillStyle = r() < 0.6 ? '#f2c14e' : '#e9524a';
          g.fillRect(xx, yy, 9, 13);
        }
      }
    if (r() < 0.35) {
      g.fillStyle = '#f07e3e';
      g.fillRect(x + w * 0.5 - 4, H - h - 12, 30, 12);
    }
    x += w;
  }
  return texture(c);
}

/** Tree cards: neem, amaltas in yellow bloom, gulmohar in muted red, and a slim ashoka. */
export type TreeKind = 'neem' | 'amaltas' | 'gulmohar' | 'ashoka';
export function treeTexture(kind: TreeKind): THREE.CanvasTexture {
  const [c, g] = canvas(256, 384);
  const r = mulberry(kind.length * 7);
  g.lineCap = 'round';
  g.strokeStyle = '#8b6d55';
  g.lineWidth = 12;
  g.beginPath();
  g.moveTo(128, 384);
  g.lineTo(128, kind === 'ashoka' ? 300 : 230);
  g.stroke();
  const leaf = kind === 'ashoka' ? '#5f8f3c' : '#7aa84a';
  if (kind === 'ashoka') {
    g.fillStyle = leaf;
    g.beginPath();
    g.ellipse(128, 170, 50, 150, 0, 0, 7);
    g.fill();
  } else {
    g.fillStyle = leaf;
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(128 + (r() - 0.5) * 150, 140 + (r() - 0.5) * 120, 50 + r() * 22, 0, 7);
      g.fill();
    }
  }
  g.strokeStyle = 'rgba(58,91,160,.6)';
  g.lineWidth = 3;
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(40,80,30,.22)';
  for (let y = 0; y < 384; y += 9) for (let x = (y / 9) % 2 ? 4 : 0; x < 256; x += 9) g.fillRect(x, y, 2.2, 2.2);
  g.globalCompositeOperation = 'source-over';
  if (kind === 'amaltas' || kind === 'gulmohar') {
    g.fillStyle = kind === 'amaltas' ? '#f2c14e' : '#f07e3e';
    for (let i = 0; i < 46; i++) {
      const a = r() * 7;
      const d = Math.sqrt(r());
      g.beginPath();
      g.arc(128 + Math.cos(a) * d * 95, 140 + Math.sin(a) * d * 85, 4 + r() * 4, 0, 7);
      g.fill();
    }
  }
  return texture(c);
}

/** The sky: a soft butter gradient with faint paper clouds. */
export function skyTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#fbd592');
  grad.addColorStop(0.62, '#f4c986');
  grad.addColorStop(1, '#f1b98a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = 'rgba(255,244,214,.7)';
  for (const [x, y, s] of [
    [90, 110, 1],
    [330, 70, 0.8],
    [430, 170, 0.6],
  ] as const) {
    for (const [dx, dy, rr] of [
      [0, 0, 26],
      [26, -8, 30],
      [54, 2, 22],
    ] as const) {
      g.beginPath();
      g.arc(x + dx * s, y + dy * s, rr * s, 0, 7);
      g.fill();
    }
  }
  return texture(c);
}

/** The table the book lies on: muted rose paper with a printed grid. */
export function tableTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#eb9cb4';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(187,108,133,.35)';
  for (let y = 0; y < 256; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < 256; x += 8) g.fillRect(x, y, 2, 2);
  g.strokeStyle = 'rgba(160,80,110,.55)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const t = texture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(36, 36);
  return t;
}
