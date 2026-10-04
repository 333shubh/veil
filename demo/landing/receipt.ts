// The receipt: a paper strip that feeds out of the chawl's meter cabinet and runs along the street, printed with one
// day of that room's 15-minute readings and the appliances the simulator switched on. Scrolling prints it.
import * as THREE from 'three';
import type { ApplianceEvent } from '../../src/load.ts';

const NAMES: Record<ApplianceEvent['appliance'], string> = {
  ac: 'AC',
  pump: 'WATER PUMP',
  iron: 'IRON',
  mixer: 'MIXER',
  induction: 'INDUCTION STOVE',
  washer: 'WASHING MACHINE',
};

export interface Day {
  label: string; // e.g. "CHAWL 1 · ROOM 14"
  quarter: number[]; // 96 mean watts, one per 15 minutes
  events: { appliance: ApplianceEvent['appliance']; minute: number }[];
}

const LENGTH = 8.4;
const WIDTH = 1.7;
const DROP = 0.16;
const BEND = 0.2;
const SEGMENTS = 240;
const LEAD = (DROP + (Math.PI * BEND) / 2 + 0.25) / LENGTH; // fraction of the strip before the chart starts

function chart(day: Day): THREE.CanvasTexture {
  const W = 2600;
  const H = Math.round((W * WIDTH) / LENGTH);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#e9524a';
  g.fillRect(0, 0, W, 10);
  g.fillRect(0, H - 10, W, 10);
  g.strokeStyle = 'rgba(61,93,168,.4)';
  g.setLineDash([8, 8]);
  g.lineWidth = 2;
  g.strokeRect(14, 18, W - 28, H - 36);
  g.setLineDash([]);

  const x0 = LEAD * W + 40;
  const x1 = W - 40;
  const top = 120;
  const base = H - 70;
  const peak = Math.max(1500, ...day.quarter);
  const bw = (x1 - x0) / 96;
  g.fillStyle = '#3d5da8';
  g.font = '700 34px "IBM Plex Mono", monospace';
  g.fillText(`${day.label}  ·  ONE DAY OF 15-MINUTE READINGS`, x0, 50);
  g.textAlign = 'right';
  g.fillText(`peak ${(peak / 1000).toFixed(1)} kW`, x1, 64);
  g.textAlign = 'left';
  day.quarter.forEach((w, i) => {
    const h = (Math.max(0, w) / peak) * (base - top);
    g.fillStyle = w > 1200 ? '#e9524a' : '#3d5da8';
    g.fillRect(x0 + i * bw + 2, base - h, bw - 4, h);
  });
  g.fillStyle = '#3d5da8';
  g.fillRect(x0, base, x1 - x0, 3);
  g.font = '600 26px "IBM Plex Mono", monospace';
  for (let hr = 0; hr <= 24; hr += 3) g.fillText(String(hr).padStart(2, '0') + ':00', x0 + hr * 4 * bw - 30, base + 34);

  // label the appliances, skipping labels that would collide
  g.font = '700 26px "IBM Plex Mono", monospace';
  let lastX = -1e9;
  for (const e of day.events) {
    const x = x0 + (e.minute / 15) * bw;
    if (x - lastX < 170) continue;
    lastX = x;
    g.fillStyle = '#e9524a';
    g.fillRect(x, top - 10, 3, 24);
    g.fillText(NAMES[e.appliance], x + 8, top + 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class Receipt {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;

  constructor(day: Day, start: THREE.Vector3) {
    const pos: number[] = [];
    const uv: number[] = [];
    const zc = start.z + WIDTH / 2;
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = (i / SEGMENTS) * LENGTH;
      let x: number;
      let y: number;
      if (s < DROP) [x, y] = [start.x, start.y - s];
      else if (s < DROP + (Math.PI * BEND) / 2) {
        const a = (s - DROP) / BEND;
        x = start.x + BEND - BEND * Math.cos(a);
        y = start.y - DROP - BEND * Math.sin(a);
      } else {
        x = start.x + BEND + (s - DROP - (Math.PI * BEND) / 2);
        y = start.y - DROP - BEND + 0.03 + 0.015 * Math.sin(s * 2.1);
      }
      pos.push(x, y, zc - WIDTH / 2, x, y, zc + WIDTH / 2);
      uv.push(i / SEGMENTS, 1, i / SEGMENTS, 0);
    }
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.geometry.setIndex(index);
    this.geometry.computeVertexNormals();
    this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshLambertMaterial({ map: chart(day), side: THREE.DoubleSide }));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.setProgress(0);
  }

  /** 0 nothing printed, 1 the whole day. Returns the minute of the day at the print head. */
  setProgress(p: number): number {
    const shown = Math.round(LEAD * SEGMENTS + p * (1 - LEAD) * SEGMENTS);
    this.geometry.setDrawRange(0, p <= 0 ? 0 : shown * 6);
    this.mesh.visible = p > 0;
    return Math.min(1439, Math.floor(p * 1440));
  }
}
