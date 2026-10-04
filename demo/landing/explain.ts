// The explainer: five neighbouring houses in the live district, each with a paper tag over its roof. Scrolling walks
// through one round in miniature: the readings, the pair masks (threads between neighbours), the masked reports that
// go up to the utility, and the sum in which every mask meets its opposite. Then one house drops out and its
// neighbours release what cancels its masks; then the total goes on the ledger.
//
// The numbers are real arithmetic on the simulator's readings for these five meters, with 4-digit masks so they fit
// on a tag. The protocol itself uses 64-bit masks, k = 54 neighbours and fresh masks every round.
import * as THREE from 'three';
import { C, rng } from './kit.ts';

const MOD = 10_000;
const mod = (x: number) => ((x % MOD) + MOD) % MOD;
const fmt = (x: number) => String(x).padStart(4, '0');

export interface Stage {
  how: number; // progress through "how it works", or -1
  drop: number; // progress through "a meter drops", or -1
  ledger: number; // progress through "the ledger", or -1
}

export class Explainer {
  readonly root = new THREE.Group();
  private readonly tags: HTMLDivElement[] = [];
  private readonly maskTags: HTMLDivElement[] = [];
  private readonly sumTag: HTMLDivElement;
  private readonly threads: THREE.Mesh[] = [];
  private readonly ups: THREE.Mesh[] = [];
  private readonly pairs: [number, number][];
  private readonly masks: number[];
  private readonly masked: number[];
  private readonly mids: THREE.Vector3[] = [];
  private readonly utility: THREE.Vector3;
  private readonly threadMat = new THREE.MeshBasicMaterial({ color: C.ink, transparent: true, opacity: 0 });
  private readonly cutMat = new THREE.MeshBasicMaterial({ color: C.coral, transparent: true, opacity: 0 });
  private readonly upMat = new THREE.MeshBasicMaterial({ color: C.inkSoft, transparent: true, opacity: 0 });
  private readonly v = new THREE.Vector3();

  private readonly layer: HTMLElement;
  private readonly homes: { top: THREE.Vector3; label: string }[];
  private readonly readings: number[];

  constructor(layer: HTMLElement, homes: { top: THREE.Vector3; label: string }[], readings: number[]) {
    this.layer = layer;
    this.homes = homes;
    this.readings = readings;
    const n = homes.length;
    const random = rng(54);
    this.pairs = Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as [number, number]);
    this.masks = this.pairs.map(() => 1000 + Math.floor(random() * 9000));
    // in each pair the first adds the mask and the second subtracts it
    this.masked = readings.map((r, i) => {
      let y = r;
      this.pairs.forEach(([a, b], p) => {
        if (a === i) y += this.masks[p]!;
        if (b === i) y -= this.masks[p]!;
      });
      return mod(y);
    });
    const centre = homes.reduce((a, h) => a.add(h.top), new THREE.Vector3()).multiplyScalar(1 / n);
    this.utility = centre.clone().add(new THREE.Vector3(0, 7.2, -3));

    this.pairs.forEach(([a, b]) => {
      const p0 = homes[a]!.top;
      const p1 = homes[b]!.top;
      const wrap = Math.abs(a - b) > 1;
      const mid = p0.clone().lerp(p1, 0.5).add(new THREE.Vector3(0, wrap ? 4.8 : 3.3, wrap ? -1.5 : 0));
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.045, 5), this.threadMat);
      this.threads.push(tube);
      this.mids.push(curve.getPoint(0.5));
      this.root.add(tube);
    });
    for (const h of homes) {
      const up = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(h.top, this.utility), 1, 0.03, 4), this.upMat);
      this.ups.push(up);
      this.root.add(up);
    }

    const tag = (cls: string) => {
      const el = document.createElement('div');
      el.className = `tag ${cls}`;
      layer.appendChild(el);
      return el;
    };
    for (let i = 0; i < n; i++) this.tags.push(tag('home'));
    for (let i = 0; i < n; i++) this.maskTags.push(tag('mask'));
    this.sumTag = tag('sum');
    this.root.visible = false;
  }

  update(s: Stage, camera: THREE.Camera): void {
    const active = s.how >= 0 || s.drop >= 0 || s.ledger >= 0;
    this.root.visible = active;
    this.layer.classList.toggle('on', active);
    if (!active) return;
    const n = this.homes.length;
    const how = s.how >= 0 ? s.how : 1;
    const dropping = s.drop >= 0 && s.ledger < 0;
    const offline = dropping && s.drop > 0.12 ? 2 : -1;
    const released = dropping && s.drop > 0.42;
    const showThreads = clamp((how - 0.2) / 0.12);
    const isMasked = how >= 0.45;
    const sent = clamp((how - 0.45) / 0.12);
    const summed = how >= 0.7;

    this.threadMat.opacity = 0.85 * showThreads;
    this.upMat.opacity = 0.6 * sent;
    this.cutMat.opacity = 0.9;
    this.pairs.forEach(([a, b], p) => (this.threads[p]!.material = offline >= 0 && (a === offline || b === offline) ? this.cutMat : this.threadMat));
    this.ups.forEach((u, i) => (u.visible = i !== offline));

    for (let i = 0; i < n; i++) {
      const el = this.tags[i]!;
      this.place(el, this.homes[i]!.top, camera, 0.6);
      const who = `<span class="who">${this.homes[i]!.label}</span>`;
      if (i === offline) el.innerHTML = `${who}<b class="off">offline</b><span class="sub">no report this round</span>`;
      else if (!isMasked) el.innerHTML = `${who}<b>${this.readings[i]} W</b><span class="sub">its reading</span>`;
      else el.innerHTML = `${who}<b class="noise">${fmt(this.masked[i]!)}</b><span class="sub">${released && this.touches(i, offline) ? `releases ${this.release(i, offline)}` : 'what it sends'}</span>`;
      el.classList.toggle('dim', i === offline);
    }
    this.pairs.forEach(([a, b], p) => {
      const el = this.maskTags[p]!;
      el.style.opacity = String(showThreads * (isMasked && how > 0.6 ? 0.55 : 1));
      this.place(el, this.mids[p]!, camera, 0);
      el.innerHTML = `+${fmt(this.masks[p]!)} <i>/</i> −${fmt(this.masks[p]!)}`;
      el.classList.toggle('cut', offline >= 0 && (a === offline || b === offline));
    });

    // the utility's sum
    const sumEl = this.sumTag;
    this.place(sumEl, this.utility, camera, 0);
    sumEl.style.opacity = String(sent);
    const all = this.readings.reduce((a, r) => a + r, 0);
    if (dropping) {
      const live = this.readings.filter((_, i) => i !== offline);
      const raw = mod(this.masked.filter((_, i) => i !== offline).reduce((a, y) => a + y, 0));
      const fixed = live.reduce((a, r) => a + r, 0);
      sumEl.innerHTML =
        offline < 0
          ? `<span class="who">The utility</span><b>${all} W</b>`
          : !released
            ? `<span class="who">The utility · 4 reports</span><b class="noise">${fmt(raw)}</b><span class="sub">masks shared with the missing house don't cancel</span>`
            : `<span class="who">The utility · 4 reports + releases</span><b>${fixed} W</b><span class="sub ok">exact total of the 4 that reported</span>`;
    } else if (s.ledger >= 0) {
      sumEl.innerHTML = `<span class="who">The utility</span><b>${all} W</b><span class="stamp ${s.ledger > 0.3 ? 'in' : ''}">On the ledger · round 1</span><span class="sub">${s.ledger > 0.55 ? 'every validator holds it; a second total for round 1 is refused' : 'signed and recorded'}</span>`;
    } else {
      const sum = mod(this.masked.reduce((a, y) => a + y, 0));
      sumEl.innerHTML = summed
        ? `<span class="who">The utility adds the reports</span><b>${sum} W</b><span class="sub ok">= ${this.readings.join(' + ')}, exactly</span>`
        : `<span class="who">The utility</span><b class="noise">${this.masked.map(fmt).join(' · ')}</b><span class="sub">five reports that mean nothing alone</span>`;
    }
  }

  private touches(i: number, off: number): boolean {
    return off >= 0 && this.pairs.some(([a, b]) => (a === i && b === off) || (b === i && a === off));
  }

  /** What neighbour i releases to cancel the mask it shares with the missing house. */
  private release(i: number, off: number): string {
    const p = this.pairs.findIndex(([a, b]) => (a === i && b === off) || (b === i && a === off));
    const [a] = this.pairs[p]!;
    return a === i ? `−${fmt(this.masks[p]!)}` : `+${fmt(this.masks[p]!)}`;
  }

  private place(el: HTMLElement, p: THREE.Vector3, camera: THREE.Camera, lift: number): void {
    this.v.copy(p).setY(p.y + lift).project(camera);
    el.style.transform = `translate(${((this.v.x + 1) / 2) * innerWidth}px, ${((1 - this.v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
    el.style.visibility = this.v.z > 1 ? 'hidden' : 'visible';
  }
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
