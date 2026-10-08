// The landing page: one fixed canvas under a scrolling story. Scrolling stands up a pop-up book of an Indian city,
// follows one flat's meter as it prints a day of readings, walks through a round of Veil on five real houses, and
// ends in the interactive city, where the 240 homes of the live feeder run the real protocol in the engine worker.
// Every number in the city panel comes from that worker; every number in the story is traced (npm run trace).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Lenis from 'lenis';
import e5 from '../experiments/results/e5.json';
import { simulateLoad } from '../src/load.ts';
import { MIN_GROUP_SIZE } from '../src/params.ts';
import type { CollusionResult } from './collusion.ts';
import type { Snapshot } from './engine.ts';
import { City, DDA, HOMES } from './landing/city.ts';
import { Explainer } from './landing/explain.ts';
import { C, clamp01, ease, explode, flushMeters, focus, hovered, lerp, rise, rng, setMeter } from './landing/kit.ts';
import { tableTexture } from './landing/paint.ts';
import { PaperPlane } from './landing/plane.ts';
import { Receipt, type Day } from './landing/receipt.ts';
import { Riso } from './landing/riso.ts';
import { Kites, Traffic } from './landing/traffic.ts';
import type { VerifiedResult } from './verified.ts';
import type { Command, Event } from './worker.ts';

type Mode = 'raw' | 'veil' | 'operator';
type View = 'paper' | 'section' | 'explode' | 'wiring' | 'blueprint';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtW = (w: number) => (Math.abs(w) >= 10_000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w).toLocaleString('en-IN')} W`);
const hhmm = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(Math.round(minute) % 60).padStart(2, '0')}`;
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = () => innerWidth <= 860;
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private browsing: the setting lasts this visit only
    }
  },
};
const loadBar = (pct: number, text?: string) => {
  $('loadBar').style.transform = `scaleX(${pct / 100})`;
  if (text) $('loadText').textContent = text;
};

// ---- Can this browser draw the city? If not, the story still reads, and nothing else starts. ----
if (!document.createElement('canvas').getContext('webgl2')) {
  document.body.classList.add('no-gl', 'ready');
  for (const s of document.querySelectorAll('.slip')) s.classList.add('in');
  await new Promise(() => {});
}

// ---- The cover title lands word by word, like stickers pressed onto the page, once the book is ready ----
{
  let i = 0;
  const split = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) split(child);
      else if (child.nodeType === Node.TEXT_NODE && child.textContent!.trim()) {
        const bits = child.textContent!.split(/(\s+)/);
        child.replaceWith(
          ...bits.map((bit) => {
            if (!bit.trim()) return document.createTextNode(bit);
            const w = document.createElement('span');
            w.className = 'w';
            w.style.setProperty('--i', String(i++));
            w.textContent = bit;
            return w;
          }),
        );
      }
    }
  };
  split($('coverTitle'));
}

// ---- Quality: a lighter tier for phones and small machines, overridable in the View tab or with ?quality= ----
const asked = new URLSearchParams(location.search).get('quality') ?? store.get('veil-quality');
const weak = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4 || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
const quality: 'low' | 'high' = asked === 'low' || asked === 'high' ? asked : weak ? 'low' : 'high';
const maxDpr = Math.min(devicePixelRatio, quality === 'low' ? 1.25 : 2);
let dpr = maxDpr; // stepped down by the frame-time governor below when frames run long

// ---- The engine starts at once: its key setup takes a while, and the story gives it the time. ----
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const send = (c: Command) => worker.postMessage(c);

loadBar(15, 'setting the type…');
await Promise.race([
  Promise.all(['800 32px "Plus Jakarta Sans"', '700 16px "Plus Jakarta Sans"', '600 26px "IBM Plex Mono"'].map((f) => document.fonts.load(f))),
  new Promise((r) => setTimeout(r, 2500)),
]).catch(() => undefined);
loadBar(35, 'cutting out the city…');
await new Promise((r) => setTimeout(r, 0)); // let the bar paint before the heavy build

// ---- Scene ----
const canvas = $<HTMLCanvasElement>('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(dpr);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // redrawn only while something folds, prints or the sun moves
const riso = new Riso(renderer, quality === 'low' ? 0 : 2); // the print pass inks every edge, so 2x MSAA is enough

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xf1b98a, 150, 380);
const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 600);

const hemi = new THREE.HemisphereLight(0xfff3dc, 0xf2c6d2, 2.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(quality === 'low' ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -64, right: 64, top: 64, bottom: -64, near: 1, far: 260 });
sun.shadow.bias = -0.0004;
sun.shadow.radius = 2;
scene.add(sun);

const table = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ map: tableTexture() }));
table.rotation.x = -Math.PI / 2;
table.position.y = -0.13;
table.receiveShadow = true;
scene.add(table);

const city = new City();
scene.add(city.root);
loadBar(70, 'folding the buildings…');
const traffic = new Traffic();
scene.add(traffic.root);
const kites = new Kites(city.kiteAnchors);
scene.add(kites.root);
const plane = new PaperPlane();
scene.add(plane.mesh);
const wiring = city.wiring();
scene.add(wiring);

// ---- The story's flat: the flat of the hero block whose simulated day shows the most kinds of appliance ----
const load = simulateLoad(
  Array.from({ length: HOMES }, (_, i) => i + 1),
  2,
  60,
  'veil demo',
); // the engine's own call, so the story's homes match the city
const heroBlock = DDA.first + 4 * DDA.flats;
let heroMeter = heroBlock;
let best = -1;
for (let m = heroBlock; m < heroBlock + DDA.flats; m++) {
  const kinds = new Set(load.events.filter((e) => e.home === m + 1).map((e) => e.appliance)).size;
  if (kinds > best) [best, heroMeter] = [kinds, m];
}
city.setHero(heroMeter);
const heroLabel = city.labels[heroMeter]!;
for (const el of document.querySelectorAll('.hero-room')) el.textContent = heroLabel.split(', ')[1]!;
const power = load.power.get(heroMeter + 1)!;
const day: Day = {
  label: heroLabel.toUpperCase().replace(', ', ' · '),
  quarter: Array.from({ length: 96 }, (_, q) => {
    let s = 0;
    for (let m = 0; m < 15; m++) s += power[q * 15 + m]!;
    return s / 15;
  }),
  events: load.events
    .filter((e) => e.home === heroMeter + 1)
    .sort((a, b) => a.start - b.start)
    .map((e) => ({ appliance: e.appliance, minute: e.start })),
};
const NAMES = { ac: 'the AC', pump: 'the water pump', iron: 'the iron', mixer: 'the mixer', induction: 'the induction stove', washer: 'the washing machine' };
const firsts = new Map<string, number>();
for (const e of day.events) if (!firsts.has(e.appliance)) firsts.set(e.appliance, e.minute);
const listed = [...firsts].slice(0, 4).map(([a, m]) => `${NAMES[a as keyof typeof NAMES]} at ${hhmm(m)}`);
$('diary').textContent = listed.length
  ? `In this flat's day: ${listed.slice(0, -1).join(', ')}${listed.length > 1 ? ' and ' : ''}${listed.at(-1)}. None of it is labelled in the data; each one leaves its own step in the curve.`
  : 'Even a quiet flat shows its fans, lights and fridge cycling through the day.';
const receipt = new Receipt(day, new THREE.Vector3(city.heroCabinet.x + 0.36, 0.36, city.heroCabinet.z));
scene.add(receipt.mesh);

// ---- The explainer: five houses, their readings at one minute of the simulated evening ----
let minute = 1170;
const readingsAt = (m: number) => city.explainHomes.map((h) => Math.max(0, Math.round(load.power.get(h.meter + 1)![m]!)));
while (readingsAt(minute).reduce((a, b) => a + b, 0) >= 9000 && minute > 0) minute -= 7;
const explainer = new Explainer(
  $('tags'),
  city.explainHomes.map((h, i) => ({ top: h.top, label: `House ${i + 1}` })),
  readingsAt(minute),
);
scene.add(explainer.root);

// ---- Light: a day that moves through the story, and follows the simulator's clock in the city ----
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
const SKY = { dayTop: srgb(0xfbd592), dayLow: srgb(0xf1b98a), duskTop: srgb(0xf8897a), duskLow: srgb(0xe46c58) };
const skyTop = new THREE.Color();
const skyLow = new THREE.Color();
let litMinute = -1;
let blueprint = 0;
function light(minuteOfDay: number): void {
  const m = Math.round(minuteOfDay);
  if (m === litMinute) return;
  litMinute = m;
  const t = clamp01((m - 360) / (1200 - 360)); // 06:00 to 20:00; nights stay at dusk, the page stays light
  const elevation = Math.sin(t * Math.PI);
  const dusk = 0.4 * clamp01(1 - elevation / 0.5); // never past a soft dusk: the page stays light
  sun.position.set(80 * Math.cos(Math.PI * t), 22 + 58 * elevation, 48);
  sun.color.setHex(0xffffff).lerp(new THREE.Color(0xffb07a), dusk);
  sun.intensity = 2.1 - 0.6 * dusk;
  hemi.color.setHex(0xfff3dc).lerp(new THREE.Color(0xffc6a4), dusk);
  hemi.groundColor.setHex(0xf2c6d2).lerp(new THREE.Color(0xd98aa0), dusk);
  skyTop.copy(SKY.dayTop).lerp(SKY.duskTop, dusk);
  skyLow.copy(SKY.dayLow).lerp(SKY.duskLow, dusk);
  (scene.fog as THREE.Fog).color.setRGB(skyLow.r, skyLow.g, skyLow.b, THREE.SRGBColorSpace);
  renderer.shadowMap.needsUpdate = true;
  $('lightLabel').textContent = hhmm(m);
}

// ---- Camera poses ----
interface Pose {
  pos: THREE.Vector3;
  at: THREE.Vector3;
}
const P = (x: number, y: number, z: number, ax: number, ay: number, az: number): Pose => ({ pos: new THREE.Vector3(x, y, z), at: new THREE.Vector3(ax, ay, az) });
const POSES: Record<string, Pose> = {
  flat: P(0, 66, 42, 0, 0, -6),
  open: P(0, 40, 76, 0, 7, -8),
  meter: P(-8.2, 11.5, 3.2, -8.6, 0, -4.6),
  why: P(-17, 36, 30, -17, 0, -5),
  how: P(-26, 9.2, 14.5, -26, 8.2, -1.2),
  drop: P(-25.4, 9.2, 14.2, -26, 8.2, -1.2),
  ledger: P(-25, 9.6, 15.2, -26, 8.6, -1.2),
  proof: P(40, 32, 64, 0, 4, -6),
  limits: P(-40, 30, 60, -4, 4, -6),
  city: P(-4, 38, 50, -12, 0, -6),
  feeder: P(-17, 26, 24, -17, 0, -5),
  old: P(-14, 22, -4, -18, 2, -26),
  circle: P(19, 30, 24, 19, 0, -5),
  gardens: P(16, 20, 46, 17, 2, 21),
  river: P(28, 18, 10, 45, 3, -10),
};
const mix = (a: Pose, b: Pose, t: number): Pose => ({ pos: a.pos.clone().lerp(b.pos, t), at: a.at.clone().lerp(b.at, t) });

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 5;
controls.maxDistance = 140;
controls.enabled = false;
let userMoved = false;
let flyTo: Pose | null = null;
controls.addEventListener('start', () => {
  userMoved = true;
  flyTo = null;
});
const camPos = POSES.flat!.pos.clone();
const look = POSES.flat!.at.clone();

// ---- Scroll ----
// Section geometry is measured once per resize, never in the frame loop: reading layout there after the loop's own
// style writes forced the browser to lay the page out again on every frame.
const IDS = ['cover', 'meter', 'why', 'how', 'drop', 'ledger', 'proof', 'limits', 'bridge', 'city'] as const;
const S = Object.fromEntries(IDS.map((id) => [id, $(id)])) as Record<string, HTMLElement>;
const geo: Record<string, { top: number; height: number }> = {};
let viewH = innerHeight;
let footerTop = Infinity;
let docMax = 1;
function measure(): void {
  viewH = innerHeight;
  for (const id of IDS) {
    const r = S[id]!.getBoundingClientRect();
    geo[id] = { top: r.top + scrollY, height: r.height };
  }
  footerTop = $('footer').getBoundingClientRect().top + scrollY;
  docMax = Math.max(1, document.documentElement.scrollHeight - viewH);
}
measure();
new ResizeObserver(() => measure()).observe(document.body);
const through = (id: string) => clamp01((scrollY - geo[id]!.top) / Math.max(1, geo[id]!.height - viewH));
const entering = (id: string) => clamp01(1 - (geo[id]!.top - scrollY) / viewH);
function story(): { pose: Pose; p: Record<string, number> } {
  const p: Record<string, number> = {
    cover: through('cover'),
    meter: through('meter'),
    why: through('why'),
    how: through('how'),
    drop: through('drop'),
    ledger: through('ledger'),
    proof: entering('proof'),
    limits: entering('limits'),
    city: entering('city'),
  };
  let pose = mix(POSES.flat!, POSES.open!, ease(clamp01((p.cover! - 0.03) / 0.7)));
  for (const [id, frac] of [
    ['meter', 0.2],
    ['why', 0.4],
    ['how', 0.15],
    ['drop', 0.2],
    ['ledger', 0.3],
    ['proof', 0.9],
    ['limits', 0.9],
    ['city', 1],
  ] as const)
    pose = mix(pose, POSES[id]!, ease(clamp01(p[id]! / frac)));
  return { pose, p };
}

// the paper slips pop into place as they arrive
const reveal = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')), { threshold: 0.2 });
for (const s of document.querySelectorAll('.slip')) reveal.observe(s);

let mode: Mode = 'veil';
let view: View = 'paper';
let last: Snapshot | undefined;
let interactive = false;
let selected = -1;

// ---- Window colours ----
const palette = rng(5);
const decor = Array.from({ length: HOMES }, () => {
  const k = palette();
  return k < 0.1 ? ([C.mustard, 0.35] as const) : k < 0.15 ? ([C.red, 0.25] as const) : k < 0.2 ? ([C.blue, 0] as const) : ([C.window, 0] as const);
});
const SEALED = 0xc3b6e8;
function raw(w: number): [number, number] {
  if (w < 0) return [C.sage, 0.3];
  if (w < 150) return [C.window, 0];
  if (w < 600) return [0xf6d98a, 0.35];
  if (w < 1500) return [C.orange, 0.5];
  return [C.red, 0.6];
}
type Stage = 'story' | 'meter' | 'explain' | 'drop' | 'city';
function paintWindows(stage: Stage, minuteOfDay: number): void {
  const explainFloors = new Set(city.explainHomes.flatMap((h) => [h.meter, h.meter + 1, h.meter + 2, h.meter + 3]));
  const offline = city.explainHomes[2]!.meter;
  for (let i = 0; i < HOMES; i++) {
    if (stage === 'story') setMeter(i, decor[i]![0], decor[i]![1]);
    else if (stage === 'meter') setMeter(i, ...(i === heroMeter ? raw(power[minuteOfDay]!) : ([C.window, 0] as [number, number])));
    else if (stage === 'explain' || stage === 'drop') {
      if (stage === 'drop' && i >= offline && i < offline + 4) setMeter(i, C.slate, 0);
      else if (explainFloors.has(i)) setMeter(i, C.mustard, 0.4);
      else setMeter(i, C.window, 0);
    } else if (!last) setMeter(i, C.window, 0);
    else {
      const s = last.state[i]!;
      if (s === 2) setMeter(i, C.slate, 0);
      else if (mode === 'raw') setMeter(i, ...raw(last.readings[i]!));
      else if (s === 1) setMeter(i, C.mustard, 0.3);
      else setMeter(i, SEALED, 0);
    }
  }
  flushMeters();
}

// ---- Frame loop ----
function resize(): void {
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight, false);
  riso.setSize(innerWidth, innerHeight, dpr);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// The frame-time governor: when frames run long for a while, render fewer pixels; when they have run at the display's
// rate for several seconds, try more again. A step up that had to be taken back is not tried again this visit.
const MIN_DPR = Math.min(maxDpr, 0.7);
let govMs = 0;
let govFrames = 0;
let calm = 0;
let raised = false;
let capped = false;
// ?fps shows the frame rate and the render scale, for checking a machine by eye
const meter = new URLSearchParams(location.search).has('fps') ? document.body.appendChild(document.createElement('output')) : null;
meter?.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:60;font:600 12px var(--mono);background:var(--deep);color:var(--paper);padding:6px 10px;border-radius:8px');
function govern(ms: number): void {
  if (ms > 120) return; // a hitch (a tab switch, a collection), not a trend
  govMs += ms;
  if (++govFrames < 40) return;
  const avg = govMs / govFrames;
  if (meter) meter.textContent = `${(1000 / avg).toFixed(0)} fps · ${avg.toFixed(1)} ms · scale ${dpr.toFixed(2)}`;
  govMs = govFrames = 0;
  if (avg > 20 && dpr > MIN_DPR) {
    dpr = Math.max(MIN_DPR, dpr * 0.82);
    if (raised) capped = true;
    calm = 0;
    resize();
  } else if (avg < 17.8 && dpr < maxDpr && !capped) {
    if (++calm >= 6) {
      dpr = Math.min(maxDpr, dpr * 1.12);
      raised = true;
      calm = 0;
      resize();
    }
  } else calm = 0;
}

// ---- Smooth scrolling: wheel and keys glide like turning a page; off for reduced motion ----
const lenis = still ? null : new Lenis({ autoRaf: false, anchors: true, lerp: 0.1, wheelMultiplier: 0.9, prevent: (node) => interactive && node === canvas });
$('toTop').addEventListener('click', () => (lenis ? lenis.scrollTo(0, { duration: 2.4 }) : scrollTo(0, 0)));

const pointer = { x: 0, y: 0 };
const sway = { x: 0, y: 0 };
addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = (e.clientY / innerHeight) * 2 - 1;
});

// ---- Compile every program behind the loader, so nothing hitches the first time it comes into view ----
loadBar(80, 'inking the plates…');
{
  const parts = [traffic.root, kites.root, wiring, explainer.root, plane.mesh, receipt.mesh];
  const shown = parts.map((o) => o.visible);
  for (const o of parts) o.visible = true;
  rise.value = 1;
  camera.position.copy(POSES.city!.pos);
  camera.lookAt(POSES.city!.at);
  await renderer.compileAsync(scene, camera).catch(() => undefined);
  renderer.shadowMap.needsUpdate = true;
  riso.render(scene, camera, 0); // also builds the shadow programs
  parts.forEach((o, i) => (o.visible = shown[i]!));
  rise.value = 0;
}

const clock = new THREE.Clock();
const followClock = $<HTMLInputElement>('followClock');
let painted = '';
let paintedMinute = -1;
let lastFold = [-1, -1];
let shadowFrames = 0;
let lastPrint = -1;
let loaded = false;
let manualMinute = 660;
let lastFrame = performance.now();
const right = new THREE.Vector3();
const target = { focus: 0, explode: 0, blueprint: 0 };
loadBar(90, 'opening the book…');
renderer.setAnimationLoop((now: number) => {
  govern(now - lastFrame);
  lastFrame = now;
  lenis?.raf(now);
  const dt = Math.min(0.05, clock.getDelta());
  const time = still ? 0 : clock.elapsedTime;
  chrome();
  if (scrollY >= footerTop) return; // the back cover hides the whole canvas: draw nothing

  const s = story();
  const p = s.p;

  // the book: the skyline page stands first, then the pieces rise from the back of the sheet to the front
  const page = clamp01(p.cover! / 0.32);
  const up = clamp01((p.cover! - 0.05) / 0.72);
  if (page !== lastFold[0] || up !== lastFold[1] || shadowFrames > 0) {
    shadowFrames = page !== lastFold[0] || up !== lastFold[1] ? 2 : shadowFrames - 1;
    lastFold = [page, up];
    city.setPage(ease(page));
    rise.value = up;
    renderer.shadowMap.needsUpdate = true;
  }

  // the views ease in and out; while they move, the shadows follow
  const k = 1 - Math.exp(-dt * 4);
  const before = focus.value + explode.value;
  focus.value += ((interactive ? target.focus : 0) - focus.value) * k;
  explode.value += ((interactive ? target.explode : 0) - explode.value) * k;
  blueprint += ((interactive ? target.blueprint : 0) - blueprint) * k;
  if (Math.abs(focus.value + explode.value - before) > 1e-4) renderer.shadowMap.needsUpdate = true;
  wiring.visible = interactive && view === 'wiring';

  // the day: morning on the cover, evening by the last chapter; in the city, the simulator's clock or the slider
  const storyDay = 540 + 570 * clamp01(scrollY / Math.max(1, geo.city!.top));
  light(interactive ? (followClock.checked && last ? last.minute : manualMinute) : storyDay);
  riso.setLook(blueprint, skyTop, skyLow, true);

  const standing = up > 0.95;
  const inMeter = p.meter! > 0.02 && p.why! < 0.4;
  const explaining = p.how! > 0 && p.proof! < 0.3;
  traffic.root.visible = standing && !inMeter && focus.value < 0.5;
  kites.root.visible = standing && !explaining && focus.value < 0.5;
  if (!still) {
    if (traffic.root.visible) traffic.update(dt);
    if (kites.root.visible) kites.update(time);
  }

  // the meter prints its day
  const print = inMeter ? clamp01((p.meter! - 0.2) / 0.5) : 0;
  const printed = receipt.setProgress(print);
  if (print !== lastPrint) {
    lastPrint = print;
    renderer.shadowMap.needsUpdate = true;
  }
  city.setHeroBlink(inMeter, time);

  // the explainer
  const how = p.how! > 0 && p.drop! === 0 ? p.how! : -1;
  const drop = p.drop! > 0 && p.ledger! === 0 ? p.drop! : -1;
  const ledger = p.ledger! > 0 && p.proof! < 0.3 ? p.ledger! : -1;
  explainer.update({ how, drop, ledger }, camera);

  const stage: Stage = p.city! > 0.5 ? 'city' : drop >= 0.12 ? 'drop' : how >= 0 || drop >= 0 || ledger >= 0 ? 'explain' : inMeter ? 'meter' : 'story';
  if (stage !== painted || (stage === 'meter' && printed !== paintedMinute)) {
    painted = stage;
    paintedMinute = printed;
    paintWindows(stage, printed);
  }

  const nowInCity = p.city! > 0.995;
  if (nowInCity !== interactive) {
    interactive = nowInCity;
    document.body.classList.toggle('in-city', interactive);
    controls.enabled = interactive;
    if (interactive) {
      controls.target.copy(look);
      userMoved = false;
    } else hideTip();
  }
  const shift = narrow() ? 0 : p.city! > 0 ? lerp(-240, 60, p.city!) : p.proof! > 0.2 ? lerp(-240, 0, clamp01((p.proof! - 0.2) / 0.5)) : -240;
  camera.setViewOffset(innerWidth, innerHeight, shift, 0, innerWidth, innerHeight);

  if (interactive) {
    const goal = flyTo ?? (userMoved ? null : POSES.city!);
    if (goal) {
      const kk = 1 - Math.exp(-dt * 3.5);
      camera.position.lerp(goal.pos, kk);
      controls.target.lerp(goal.at, kk);
      if (flyTo && camera.position.distanceTo(flyTo.pos) < 0.3) flyTo = null;
    }
    controls.update();
    look.copy(controls.target);
    camPos.copy(camera.position);
  } else {
    const kk = 1 - Math.exp(-dt * 4.5);
    camPos.lerp(s.pose.pos, kk);
    look.lerp(s.pose.at, kk);
    // a little parallax with the pointer, like turning a pop-up book in your hands; eased, so the book never jerks
    const ks = 1 - Math.exp(-dt * 3);
    sway.x += ((still ? 0 : pointer.x) - sway.x) * ks;
    sway.y += ((still ? 0 : pointer.y) - sway.y) * ks;
    right.subVectors(look, camPos).cross(camera.up).normalize();
    camera.position.copy(camPos).addScaledVector(right, sway.x * 1.6).addScaledVector(camera.up, -sway.y * 0.9);
    camera.lookAt(look);
  }
  plane.update(camera, look, dt, time, !interactive && !still && up > 0.5);
  if (interactive) placeLabel();
  riso.render(scene, camera, time);
  if (!loaded) {
    loaded = true;
    loadBar(100, 'ready');
    setTimeout(() => {
      $('loader').classList.add('done');
      document.body.classList.add('ready');
    }, 250);
  }
});

// ---- Chapter rail and progress: write-only, and only when they change ----
const RAIL: [string, string][] = [
  ['cover', 'cover'],
  ['meter', 'meter'],
  ['why', 'why'],
  ['how', 'how'],
  ['drop', 'drop'],
  ['ledger', 'ledger'],
  ['proof', 'proof'],
  ['limits', 'limits'],
  ['bridge', 'city'],
  ['city', 'city'],
];
const railLinks = [...document.querySelectorAll<HTMLAnchorElement>('.rail a')];
const progressBar = $('progress');
let chapter = '';
let progressShown = -1;
function chrome(): void {
  const mid = scrollY + viewH / 2;
  let current = 'cover';
  for (const [id, ch] of RAIL) if (geo[id]!.top < mid) current = ch;
  if (current !== chapter) {
    chapter = current;
    for (const a of railLinks) {
      a.classList.toggle('on', a.dataset.ch === current);
      if (a.dataset.ch === current) a.setAttribute('aria-current', 'step');
      else a.removeAttribute('aria-current');
    }
  }
  document.body.classList.toggle('past', scrollY + viewH * 0.6 > footerTop);
  const f = Math.round(1000 * Math.min(1, scrollY / docMax)) / 1000;
  if (f !== progressShown) {
    progressShown = f;
    progressBar.style.transform = `scaleX(${f})`;
  }
}

// ---- The transformer's floating label ----
const dtLabel = $('dt');
const v = new THREE.Vector3();
function placeLabel(): void {
  v.copy(city.transformer).project(camera);
  dtLabel.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -150%)`;
}

// ---- Picking ----
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(e: PointerEvent): number | undefined {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(city.pickables, false)[0];
  if (!hit?.face) return undefined;
  const m = (hit.object as THREE.Mesh).geometry.getAttribute('meter').getX(hit.face.a);
  if (m >= 0 && m < HOMES) return m;
  // a wall or a roof: the home whose window is nearest the point hit
  let found: number | undefined;
  let bestD = 2.2;
  city.spots.forEach((spot, i) => {
    const d = spot.distanceTo(hit.point);
    if (d < bestD) [found, bestD] = [i, d];
  });
  return found;
}
const tip = $('tip');
function hideTip(): void {
  tip.style.display = 'none';
  hovered.value = selected;
}
let downAt = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!interactive || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const i = pick(e);
  if (i !== undefined) select(i);
});
let pickPending = false;
canvas.addEventListener('pointermove', (e) => {
  if (!interactive || e.buttons) return hideTip();
  if (pickPending) return;
  pickPending = true;
  requestAnimationFrame(() => {
    pickPending = false;
    const i = pick(e);
    if (i === undefined) return hideTip();
    hovered.value = i;
    const st = last?.state[i];
    const what = !last ? 'meter starting up' : st === 2 ? 'unplugged' : mode === 'raw' ? `drawing ${fmtW(last.readings[i]!)}` : st === 1 ? 'left out of this round' : 'in the total · reading masked';
    tip.innerHTML = `<b>${city.labels[i]}</b><br>${what}`;
    tip.style.display = 'block';
    tip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
  });
});
canvas.addEventListener('pointerleave', hideTip);

for (const b of document.querySelectorAll<HTMLButtonElement>('#tour button'))
  b.addEventListener('click', () => {
    flyTo = POSES[b.dataset.go!]!;
    userMoved = true;
    for (const o of document.querySelectorAll('#tour button')) o.classList.toggle('on', o === b);
  });
function zoom(factor: number): void {
  const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
  if (offset.length() < controls.minDistance || offset.length() > controls.maxDistance) return;
  flyTo = { pos: controls.target.clone().add(offset), at: controls.target.clone() };
  userMoved = true;
}
$('zin').addEventListener('click', () => zoom(0.75));
$('zout').addEventListener('click', () => zoom(1.33));

// ---- Panel: tabs ----
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.ptabs button')];
function openTab(name: string): void {
  for (const o of tabButtons) o.setAttribute('aria-selected', String(o.dataset.tab === name));
  for (const b of document.querySelectorAll<HTMLElement>('.pbody')) b.classList.toggle('on', b.dataset.body === name);
  if (name === 'attack') sizeChart();
  if (name === 'audit' && last) billing(last);
}
for (const t of tabButtons) t.addEventListener('click', () => openTab(t.dataset.tab!));

// ---- Live: modes ----
const MODES: Record<Mode, string> = {
  raw: 'Today: the utility receives every home’s reading. Each window shows its own load, so routines and appliances show.',
  veil: 'Veil: the utility learns only the transformer total. Every window is sealed, while the total keeps moving.',
  operator: 'Operator: what the coordinator actually receives. Masked reports look random, yet they sum exactly to the total.',
};
function legend(): void {
  const item = (c: string, t: string) => `<span><i style="background:${c}"></i>${t}</span>`;
  $('legend').innerHTML =
    mode === 'raw'
      ? item('#c9d6e6', 'idle') + item('#f6d98a', 'fans, lights') + item('#f07e3e', 'pump, iron') + item('#e9524a', 'AC, several kW') + item('#4e5874', 'unplugged')
      : item('#c3b6e8', 'in the total, masked') + item('#f2c14e', 'left out this round') + item('#4e5874', 'unplugged');
}
function setMode(m: Mode): void {
  mode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) b.classList.toggle('on', b.dataset.mode === m);
  $('modeText').textContent = MODES[m];
  $('operatorSect').classList.toggle('hidden', m !== 'operator');
  legend();
  if (painted === 'city') paintWindows('city', 0);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
setMode('veil');

// ---- Live: picking a home without a mouse ----
const homeSelect = $<HTMLSelectElement>('homeSelect');
const groups = new Map<string, HTMLOptGroupElement>();
city.labels.forEach((label, i) => {
  const building = label.split(', ')[0]!;
  const name = building.startsWith('House') ? 'Builder floors' : building.startsWith('Lane house') ? 'Lane houses' : building;
  if (!groups.has(name)) {
    const g = document.createElement('optgroup');
    g.label = name;
    groups.set(name, g);
    homeSelect.append(g);
  }
  groups.get(name)!.append(new Option(label, String(i)));
});
homeSelect.addEventListener('change', () => {
  const i = Number(homeSelect.value);
  if (i < 0) return;
  select(i);
  const spot = city.spots[i]!;
  flyTo = { pos: spot.clone().add(new THREE.Vector3(3, 6, 9)), at: spot.clone() };
  userMoved = true;
});

// ---- Charts ----
function prepare(id: string): [CanvasRenderingContext2D, number, number] | undefined {
  const c = $<HTMLCanvasElement>(id);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w) return undefined;
  c.width = w * devicePixelRatio;
  c.height = h * devicePixelRatio;
  const g = c.getContext('2d')!;
  g.scale(devicePixelRatio, devicePixelRatio);
  g.font = '500 10.5px "IBM Plex Mono", monospace';
  return [g, w, h];
}
function line(id: string, values: number[], slots: number, colour: string, fill: boolean): void {
  const ready = prepare(id);
  if (!ready || values.length < 2) return;
  const [g, w, h] = ready;
  const lo = Math.min(...values) * 0.98;
  const hi = Math.max(...values, lo + 1) * 1.02;
  const x = (i: number) => (i / (slots - 1)) * w;
  const y = (val: number) => h - 3 - ((val - lo) / (hi - lo)) * (h - 6);
  g.beginPath();
  values.forEach((val, i) => (i ? g.lineTo(x(i), y(val)) : g.moveTo(x(i), y(val))));
  g.strokeStyle = colour;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.stroke();
  if (fill) {
    g.lineTo(x(values.length - 1), h);
    g.lineTo(0, h);
    g.closePath();
    g.fillStyle = 'rgba(61,93,168,.1)';
    g.fill();
  }
}

// ---- Snapshots ----
const totals: number[] = [];
const HISTORY = 60;
const homeHistory = Array.from({ length: HOMES }, () => [] as number[]);
function show(s: Snapshot): void {
  last = s;
  if (s.total !== null) totals.push(s.total);
  if (totals.length > HISTORY) totals.shift();
  s.readings.forEach((r, i) => {
    const h = homeHistory[i]!;
    h.push(r);
    if (h.length > HISTORY) h.shift();
  });
  const leftOut = s.state.reduce((a, x) => a + (x === 0 ? 0 : 1), 0);
  $('clock').textContent = `round ${s.round} · ${hhmm(s.minute)}`;
  $('total').textContent = s.total === null ? 'withheld' : fmtW(s.total);
  $('included').textContent = `${s.included} of ${s.state.length} homes`;
  dtLabel.textContent = s.total === null ? 'Transformer · withheld' : `Transformer · ${fmtW(s.total)}`;
  if (s.round % 10 === 0 && s.total !== null) $('announce').textContent = `Round ${s.round}: transformer total ${fmtW(s.total)}, exact.`;
  $('status').innerHTML =
    s.status === 'published'
      ? `Published.${leftOut ? ` <span class="warn">${leftOut} left out</span> this round.` : ''}`
      : s.status === 'suppressed'
        ? `<span class="warn">Withheld</span>: fewer than ${MIN_GROUP_SIZE} homes would be in the total.`
        : `<span class="fail">Aborted</span>: ${s.reason}`;
  $('invariant').innerHTML =
    s.total === null
      ? 'No total this round.'
      : `Veil total ${fmtW(s.total)} ${s.total === s.truth ? '<span class="ok">=</span>' : '<span class="fail">≠</span>'} true sum of the ${s.included} homes ${fmtW(s.truth!)}`;
  const c = s.counters;
  $('counters').innerHTML = [
    ['rounds', c.rounds],
    ['published', c.published],
    ['exact', c.exact],
    ['mismatches', `<span class="${c.mismatches ? 'fail' : 'ok'}">${c.mismatches}</span>`],
    ['flagged by plausibility checks', c.flagged],
    ['withheld (group too small)', c.suppressed],
  ]
    .map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`)
    .join('');
  $('maskedCount').textContent = String(s.maskedCount);
  $('masked').innerHTML = s.masked.map((h) => `<span>${h}</span>`).join('');
  line('spark', totals, HISTORY, '#3d5da8', true);
  homeCard();
  lieStatus(s);
  if ($('billChart').offsetParent) billing(s);
  if (painted === 'city') paintWindows('city', 0);
}

function select(i: number): void {
  selected = i;
  hovered.value = i;
  homeSelect.value = String(i);
  $('homeCard').classList.toggle('hidden', i < 0);
  openTab('live');
  homeCard();
}
function homeCard(): void {
  if (selected < 0) return;
  const st = last?.state[selected];
  $('homeName').textContent = city.labels[selected]!;
  $('homeState').innerHTML = !last
    ? 'Meter starting up.'
    : st === 2
      ? '<span class="warn">Unplugged.</span> The total goes on without it.'
      : `${st === 1 ? '<span class="warn">Left out this round.</span> ' : 'In the total. '}Drawing ${fmtW(last.readings[selected]!)} right now.`;
  $('unplug').textContent = st === 2 ? 'Plug it back in' : 'Unplug this meter';
  line('homeSpark', homeHistory[selected]!, HISTORY, '#e9524a', false);
}
$('unplug').addEventListener('click', () => {
  if (selected >= 0) send({ type: 'toggle', id: selected + 1 });
});
$('billHome').addEventListener('click', () => {
  if (selected < 0) return;
  send({ type: 'bill', id: selected + 1 });
  openTab('audit');
});

// ---- Test it: collusion, lying meters, verified mode, group size ----
let colluding = false;
function collude(): void {
  const c = Number($<HTMLInputElement>('collude').value);
  $('colludeLabel').textContent = `${c} of 6 corrupt`;
  if (colluding) return;
  colluding = true;
  $('colludeResult').textContent = 'running the attack…';
  send({ type: 'collusion', corrupt: c, reading: '2345' });
}
$('collude').addEventListener('change', collude);
function colluded(r: CollusionResult): void {
  colluding = false;
  if (Number($<HTMLInputElement>('collude').value) !== r.corrupt) return collude();
  $('colludeResult').innerHTML = r.exposed ? `<span class="fail">exposed by the ${r.by} split: ${r.guess} W</span> (true ${r.truth} W)` : `<span class="ok">hidden</span> in all ${r.splits} attempts (t = ${r.t})`;
}
$('lie').addEventListener('click', () => send({ type: 'lie', id: 1 + Math.floor(Math.random() * HOMES), watts: Number($<HTMLSelectElement>('lieSize').value) }));
$('honest').addEventListener('click', () => send({ type: 'lie', id: 1, watts: 0 }));
function lieStatus(s: Snapshot): void {
  if (!s.lie) return void ($('lieOut').innerHTML = s.implausible.length ? `<span class="warn">Flagged with no liar</span>: ${s.implausible[0]}` : 'No home is lying.');
  const gap = s.total !== null && s.consumption !== null ? s.total - s.consumption : null;
  $('lieOut').innerHTML =
    `${city.labels[s.lie.house - 1]} reports ${fmtW(s.lie.watts)} more than it draws. ` +
    (gap === null ? 'No total this round.' : `The total is still exact over what homes reported, and ${fmtW(gap)} above what they drew. `) +
    (s.implausible.length ? `<span class="ok">Plausibility check flags it</span>: ${s.implausible.join('; ')}.` : '<span class="fail">Plausibility check passes it.</span>');
}
const LIE_TEXT: Record<VerifiedResult['kind'], string> = { masked: 'changes its masked value but not its commitment', claimed: 'claims +50 kW, outside the range', inRange: 'claims +5 kW, inside the range' };
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lie]'))
  b.addEventListener('click', () => {
    $('verifiedOut').textContent = 'running a verified round (proofs take a few seconds in a browser)…';
    send({ type: 'verified', kind: b.dataset.lie as VerifiedResult['kind'] });
  });
function verifiedResult(r: VerifiedResult): void {
  const head = `A home ${LIE_TEXT[r.kind]}: `;
  if (r.status === 'aborted') return void ($('verifiedOut').innerHTML = `${head}<span class="ok">round refused</span>: ${r.reason}.`);
  if (r.status !== 'published') return void ($('verifiedOut').innerHTML = `${head}round ${r.status}.`);
  const lied = r.total !== r.honest;
  $('verifiedOut').innerHTML =
    head +
    (r.liarIncluded ? '' : '<span class="ok">its report was left out</span>: the range proof did not check. ') +
    `Published ${fmtW(Number(r.total))}${lied ? ` against a true ${fmtW(Number(r.honest))}: <span class="fail">the lie is in the total</span>` : ', the true sum of the homes included'}. Validators: ${r.validators}.`;
}
const e5Points = e5.results.filter((r) => r.observation !== 'masked reports of one home').map((r) => ({ n: r.n, auc: r.informed.auc }));
const sizeSlider = $<HTMLInputElement>('size');
sizeSlider.max = String(e5Points.length - 1);
sizeSlider.value = String(e5Points.findIndex((pt) => pt.n === MIN_GROUP_SIZE));
function sizeChart(): void {
  const ready = prepare('sizeChart');
  if (!ready) return;
  const [g, w, h] = ready;
  const sel = e5Points[Number(sizeSlider.value)]!;
  const lx = (n: number) => 26 + (Math.log10(n) / 3) * (w - 36);
  const ly = (a: number) => 8 + ((1 - a) / 0.55) * (h - 26);
  g.strokeStyle = 'rgba(61,93,168,.18)';
  g.fillStyle = '#6a6f86';
  for (const a of [0.5, e5.criterion, 1]) {
    g.beginPath();
    g.moveTo(26, ly(a));
    g.lineTo(w - 6, ly(a));
    g.stroke();
    g.fillText(a.toFixed(1), 0, ly(a) + 4);
  }
  for (const n of [1, 10, 100, 1000]) g.fillText(String(n), lx(n) - 6, h - 4);
  g.strokeStyle = '#e0457e';
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(lx(MIN_GROUP_SIZE), 4);
  g.lineTo(lx(MIN_GROUP_SIZE), h - 16);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = '#3d5da8';
  g.lineWidth = 2;
  g.beginPath();
  e5Points.forEach((pt, i) => (i ? g.lineTo(lx(pt.n), ly(pt.auc)) : g.moveTo(lx(pt.n), ly(pt.auc))));
  g.stroke();
  g.fillStyle = '#f07e3e';
  g.beginPath();
  g.arc(lx(sel.n), ly(sel.auc), 5, 0, 7);
  g.fill();
  const verdict = sel.n === 1 ? 'a single home: the pump is plain to see' : sel.auc > e5.criterion ? 'the detector still works' : 'the detector is close to guessing';
  $('sizeText').innerHTML = `${sel.n} ${sel.n === 1 ? 'home' : 'homes'}: AUC ${sel.auc.toFixed(3)}, ${verdict}. Veil publishes only totals of at least <b>${MIN_GROUP_SIZE}</b> homes (pink line).`;
}
sizeSlider.addEventListener('input', sizeChart);

// ---- Audit: the ledger, the billing channel, pause ----
$('tamper').addEventListener('click', () => send({ type: 'tamper', delta: 1000 }));
function tampered(r: Extract<Event, { type: 'tamper' }>['result']): void {
  if (!r) return void ($('auditOut').textContent = 'No total published yet.');
  $('auditOut').innerHTML =
    `Round ${r.round}: the ledger holds <b>${fmtW(Number(r.recorded))}</b>.<br>` +
    `Second total: <span class="${r.ledger.startsWith('rejected') ? 'ok' : 'fail'}">${r.ledger}</span>.<br>` +
    `Auditor recomputing from the signed evidence: ${r.audit.length ? `<span class="ok">flagged</span> (${r.audit.join('; ')})` : '<span class="fail">no problem found</span>'}.`;
}
function billing(s: Snapshot): void {
  $('billWho').textContent = city.labels[s.billing.house - 1] ?? '';
  const ready = prepare('billChart');
  if (!ready) return;
  const [g, w, h] = ready;
  const kwh = s.billing.kwh;
  const top = Math.max(0.5, ...kwh);
  const bw = w / 8;
  kwh.forEach((val, i) => {
    const bh = (Math.max(0, val) / top) * (h - 34);
    g.fillStyle = i === kwh.length - 1 ? '#f2c14e' : '#3d5da8';
    g.fillRect(i * bw + 4, h - 16 - bh, bw - 8, bh);
    g.fillStyle = '#2b2f45';
    g.fillText(val.toFixed(2), i * bw + 4, h - 19 - bh);
  });
  g.fillStyle = '#6a6f86';
  g.fillText('kWh per 30 min · older ← → now', 0, h - 3);
}
let paused = false;
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? 'Resume rounds' : 'Pause rounds';
  send({ type: 'pause', paused });
});

// ---- View ----
const VIEWS: Record<View, { focus: number; explode: number; blueprint: number }> = {
  paper: { focus: 0, explode: 0, blueprint: 0 },
  section: { focus: 1, explode: 0, blueprint: 0 },
  explode: { focus: 1, explode: 0.55, blueprint: 0 },
  wiring: { focus: 1, explode: 0, blueprint: 0 },
  blueprint: { focus: 0, explode: 0, blueprint: 1 },
};
for (const b of document.querySelectorAll<HTMLButtonElement>('#views button'))
  b.addEventListener('click', () => {
    view = b.dataset.view as View;
    Object.assign(target, VIEWS[view]);
    for (const o of document.querySelectorAll('#views button')) o.classList.toggle('on', o === b);
    if (view !== 'paper' && view !== 'blueprint') {
      flyTo = POSES.feeder!;
      userMoved = true;
    }
  });
$<HTMLInputElement>('hour').addEventListener('input', (e) => {
  manualMinute = Number((e.target as HTMLInputElement).value);
  $<HTMLInputElement>('followClock').checked = false;
});
$('qualityLabel').textContent = quality === 'low' ? 'light' : 'full';
for (const b of document.querySelectorAll<HTMLButtonElement>('#quality button')) {
  b.classList.toggle('on', b.dataset.q === quality);
  b.addEventListener('click', () => {
    if (b.dataset.q === quality) return;
    store.set('veil-quality', b.dataset.q!);
    location.reload();
  });
}

// ---- Try it: the reader changes House 3's reading; its report changes, the masks don't, the total stays exact ----
{
  const TRY = 2;
  const slider = $<HTMLInputElement>('tryReading');
  const others = city.explainHomes.reduce((a, _, i) => (i === TRY ? a : a + explainer.reading(i)), 0);
  slider.max = String(Math.max(100, Math.min(3000, Math.floor((9990 - others) / 10) * 10))); // the 4-digit tags hold totals under 10,000
  slider.value = String(explainer.reading(TRY));
  $('tryLabel').textContent = `${slider.value} W`;
  let cool: ReturnType<typeof setTimeout> | undefined;
  slider.addEventListener('input', () => {
    explainer.setReading(TRY, Number(slider.value));
    explainer.hot = TRY;
    $('tryLabel').textContent = `${slider.value} W`;
    clearTimeout(cool);
    cool = setTimeout(() => (explainer.hot = -1), 1600);
  });
}

// ---- Measured results: the numbers count up as each card lands, and the cards tilt in the hand ----
{
  const fine = matchMedia('(pointer: fine)').matches;
  const count = (b: HTMLElement): void => {
    const final = b.textContent!;
    const m = /^([\d,]+(?:\.\d+)?)(.*)$/.exec(final);
    if (!m || still) return;
    const value = Number(m[1]!.replaceAll(',', ''));
    const decimals = m[1]!.split('.')[1]?.length ?? 0;
    const commas = m[1]!.includes(',');
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 1100);
      const x = value * (1 - (1 - t) ** 3);
      b.textContent = t < 1 ? `${commas ? Math.round(x).toLocaleString('en-IN') : x.toFixed(decimals)}${m[2]}` : final;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const seen = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        seen.unobserve(e.target);
        const b = e.target.querySelector<HTMLElement>('b[data-count]');
        if (b) count(b);
      }),
    { threshold: 0.5 },
  );
  for (const card of document.querySelectorAll<HTMLElement>('.specimen')) {
    seen.observe(card);
    if (!fine || still) continue;
    let box: DOMRect | undefined;
    card.addEventListener('pointerenter', () => {
      box = card.getBoundingClientRect();
      card.classList.add('tilting');
    });
    card.addEventListener('pointermove', (e) => {
      if (!box) return;
      card.style.setProperty('--ry', `${((e.clientX - box.left) / box.width - 0.5) * 12}deg`);
      card.style.setProperty('--rx', `${-((e.clientY - box.top) / box.height - 0.5) * 10}deg`);
    });
    card.addEventListener('pointerleave', () => {
      box = undefined;
      card.classList.remove('tilting');
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    });
  }
}

// ---- The back cover's folder: one tab per reader, with arrow keys between them ----
{
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#folder [role=tab]')];
  const choose = (tab: HTMLButtonElement, focusIt: boolean): void => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')!).hidden = !on;
    }
    if (focusIt) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => choose(tab, false));
    tab.addEventListener('keydown', (e) => {
      const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -2;
      if (to === -2) return;
      e.preventDefault();
      choose(tabs[(to + tabs.length) % tabs.length]!, true);
    });
  });
}

// ---- Engine events ----
const STEPS = ['anchoring', 'drawing epoch keys', 'checking neighbours', 'deriving pair keys'];
const started = performance.now();
const elapsed = setInterval(() => ($('elapsed').textContent = `${Math.round((performance.now() - started) / 1000)} s`), 500);
worker.onmessage = (e: MessageEvent<Event>) => {
  const ev = e.data;
  if (ev.type === 'progress') {
    $('chipText').textContent = ev.text;
    const at = STEPS.findIndex((step) => ev.text.toLowerCase().includes(step));
    if (at >= 0) document.querySelectorAll('#steps li').forEach((li, i) => (li.className = i < at ? 'done' : i === at ? 'now' : ''));
  } else if (ev.type === 'ready') {
    clearInterval(elapsed);
    $('chip').classList.add('ready');
    $('chipText').textContent = `${ev.houses} meters live`;
    $('boot').classList.add('hidden');
    $('engineInfo').textContent = `${ev.threads} meter threads`;
    $('facts').innerHTML = [
      ['meters', ev.houses],
      ['neighbours each (k)', ev.k],
      ['needed to recover (t)', ev.t],
      ['key setup', `${(ev.setupMs / 1000).toFixed(0)} s`],
    ]
      .map(([k, val]) => `<span>${k}</span><b>${val}</b>`)
      .join('');
    collude();
  } else if (ev.type === 'snapshot') show(ev.snap);
  else if (ev.type === 'tamper') tampered(ev.result);
  else if (ev.type === 'collusion') colluded(ev.result);
  else if (ev.type === 'verified') verifiedResult(ev.result);
  else if (ev.type === 'error') {
    $('chipText').textContent = 'engine error';
    $('boot').innerHTML = `<h3>Engine error</h3><p class="muted">${ev.message.split('\n')[0]}</p>`;
  }
};
