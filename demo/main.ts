// The demo page: a Three.js city of the group's homes around their transformer, and a panel for each demo mode.
// Every number shown comes from the engine worker, which runs the protocol; nothing here is scripted.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import e5 from '../experiments/results/e5.json';
import { MIN_GROUP_SIZE } from '../src/params.ts';
import type { CollusionResult } from './collusion.ts';
import type { Snapshot } from './engine.ts';
import type { Command, Event } from './worker.ts';

type Mode = 'raw' | 'veil' | 'operator' | 'audit';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtW = (w: number) => (Math.abs(w) >= 10_000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w).toLocaleString('en-IN')} W`);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const send = (c: Command) => worker.postMessage(c);

const MODES: Record<Mode, string> = {
  raw: 'Raw: what a utility sees today. Each house is lit by its own load, so routines, occupancy and appliances show.',
  veil: 'Veil: the operator learns only the total. Houses go neutral while the transformer total keeps moving.',
  operator: 'Operator view: the masked values the coordinator receives look random, yet they sum exactly to the total.',
  audit: 'Audit: totals go on a ledger that accepts one total per round, and an auditor can recompute it from signed evidence.',
};
let mode: Mode = 'veil';
let last: Snapshot | undefined;
const history: { total: number | null }[] = [];

// ---- Scene ----
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);
scene.fog = new THREE.Fog(0x0b1020, 70, 140);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
camera.position.set(34, 38, 46);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.maxPolarAngle = Math.PI * 0.45;
controls.minDistance = 20;
controls.maxDistance = 120;
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xbcd3ff, 0x1a1a2e, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(30, 50, 20);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ color: 0x141b30 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Homes on a 16 x 16 grid around a 4 x 4 plaza that holds the transformer: 240 plots.
const SPACING = 3.2;
const plots: THREE.Vector3[] = [];
for (let r = 0; r < 16; r++)
  for (let c = 0; c < 16; c++) if (!(r >= 6 && r < 10 && c >= 6 && c < 10)) plots.push(new THREE.Vector3((c - 7.5) * SPACING, 0, (r - 7.5) * SPACING));

let houses: THREE.InstancedMesh | undefined;
let roofs: THREE.InstancedMesh | undefined;
function buildCity(n: number): void {
  houses = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 1.5, 2), new THREE.MeshStandardMaterial({ roughness: 0.7 }), n);
  roofs = new THREE.InstancedMesh(new THREE.ConeGeometry(1.6, 1, 4), new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
  const wires: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = plots[i]!;
    houses.setMatrixAt(i, m.makeTranslation(p.x, 0.75, p.z));
    roofs.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, 2, p.z), q, new THREE.Vector3(1, 1, 1)));
    houses.setColorAt(i, new THREE.Color(0x64748b));
    roofs.setColorAt(i, new THREE.Color(0x464f63));
    wires.push(0, 3.5, 0, p.x, 1.6, p.z);
  }
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
  scene.add(new THREE.LineSegments(wireGeometry, new THREE.LineBasicMaterial({ color: 0x2a3a66, transparent: true, opacity: 0.35 })));
  scene.add(houses, roofs);
}

const transformer = new THREE.Group();
transformer.add(new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, 6), new THREE.MeshStandardMaterial({ color: 0x2b3553 })));
const core = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 3.4, 24), new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.4 }));
core.position.y = 2;
transformer.add(core);
const glow = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.18, 12, 48), new THREE.MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x7dd3fc, emissiveIntensity: 1 }));
glow.rotation.x = Math.PI / 2;
glow.position.y = 3.9;
transformer.add(glow);
scene.add(transformer);

const RAMP = [0x1e2a4a, 0x2563eb, 0xf59e0b, 0xfde047].map((c) => new THREE.Color(c));
function loadColour(w: number, out: THREE.Color): THREE.Color {
  if (w < 0) return out.set(0x22c55e); // rooftop solar exporting
  const x = Math.min(1, Math.log1p(w) / Math.log1p(4000)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return out.copy(RAMP[i]!).lerp(RAMP[i + 1]!, x - i);
}
const NEUTRAL = new THREE.Color(0x64748b);
const LEFT_OUT = new THREE.Color(0xb7791f);
const UNPLUGGED = new THREE.Color(0x151515);
const ROOF_OFF = new THREE.Color(0x7f1d1d);

function paint(): void {
  if (!houses || !roofs || !last) return;
  const c = new THREE.Color();
  for (let i = 0; i < houses.count; i++) {
    const s = last.state[i]!;
    if (s === 2) c.copy(UNPLUGGED);
    else if (mode === 'raw') loadColour(last.readings[i]!, c);
    else c.copy(s === 1 ? LEFT_OUT : NEUTRAL);
    houses.setColorAt(i, c);
    roofs.setColorAt(i, s === 2 ? ROOF_OFF : c.multiplyScalar(0.7));
  }
  houses.instanceColor!.needsUpdate = true;
  roofs.instanceColor!.needsUpdate = true;
  const kw = (last.total ?? 0) / 1000;
  (glow.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.3 + Math.min(2.5, kw / 150);
}

function legend(): void {
  const item = (colour: string, text: string) => `<span><i style="background:${colour}"></i>${text}</span>`;
  $('legend').innerHTML =
    mode === 'raw'
      ? item('#1e2a4a', 'idle') + item('#2563eb', 'fans, fridge') + item('#f59e0b', 'AC, pump') + item('#fde047', 'several kW') + item('#22c55e', 'solar export') + item('#151515', 'unplugged')
      : item('#64748b', 'in the total') + item('#b7791f', 'left out this round') + item('#151515', 'unplugged');
}

function resize(): void {
  const { clientWidth: w, clientHeight: h } = stage;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => {
  controls.update();
  glow.rotation.z += 0.004;
  renderer.render(scene, camera);
});

// Picking: click unplugs or plugs in, shift-click picks the home for the billing channel, hover shows the home.
const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(e: PointerEvent): number | undefined {
  if (!houses) return undefined;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  return ray.intersectObject(houses)[0]?.instanceId;
}
let downAt = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // a drag, not a click
  const i = pick(e);
  if (i === undefined) return;
  if (e.shiftKey) {
    send({ type: 'bill', id: i + 1 });
    ($('billingOn') as HTMLInputElement).checked = true;
    $('billingBox').classList.remove('hidden');
  } else send({ type: 'toggle', id: i + 1 });
});
renderer.domElement.addEventListener('pointermove', (e) => {
  const tip = $('tip');
  const i = pick(e);
  if (i === undefined || !last) return void (tip.style.display = 'none');
  const s = last.state[i];
  const what = s === 2 ? 'unplugged' : mode === 'raw' ? fmtW(last.readings[i]!) : s === 1 ? 'left out of this round' : 'in the total; reading hidden';
  tip.innerHTML = `Home ${i + 1}: ${what}`;
  const r = stage.getBoundingClientRect();
  Object.assign(tip.style, { display: 'block', left: `${e.clientX - r.left + 12}px`, top: `${e.clientY - r.top + 12}px` });
});

// ---- Panel ----
function setMode(m: Mode): void {
  mode = m;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === m);
  $('modeText').textContent = MODES[m];
  $('operatorCard').classList.toggle('hidden', m !== 'operator');
  $('auditCard').style.outline = m === 'audit' ? '1px solid var(--accent)' : '';
  legend();
  paint();
}
$('tabs').addEventListener('click', (e) => {
  const m = (e.target as HTMLElement).dataset.mode as Mode | undefined;
  if (m) setMode(m);
});

function chartCanvas(id: string): [CanvasRenderingContext2D, number, number] {
  const c = $<HTMLCanvasElement>(id);
  const w = c.clientWidth;
  const h = c.clientHeight;
  c.width = w * devicePixelRatio;
  c.height = h * devicePixelRatio;
  const g = c.getContext('2d')!;
  g.scale(devicePixelRatio, devicePixelRatio);
  g.font = '11px system-ui, sans-serif';
  return [g, w, h];
}

function spark(): void {
  const [g, w, h] = chartCanvas('spark');
  const totals = history.map((x) => x.total ?? NaN).filter((x) => !Number.isNaN(x));
  if (totals.length < 2) return;
  const lo = Math.min(...totals) * 0.98;
  const hi = Math.max(...totals) * 1.02;
  const x = (i: number) => (i / 59) * w;
  const y = (v: number) => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8);
  g.strokeStyle = '#7dd3fc';
  g.lineWidth = 1.5;
  g.beginPath();
  history.forEach((p, i) => (p.total === null ? undefined : i === 0 ? g.moveTo(x(i), y(p.total)) : g.lineTo(x(i), y(p.total))));
  g.stroke();
}

function show(s: Snapshot): void {
  last = s;
  const leftOut = s.state.reduce((a, v) => a + (v === 0 ? 0 : 1), 0);
  history.push({ total: s.total });
  if (history.length > 60) history.shift();
  const hh = String(Math.floor(s.minute / 60)).padStart(2, '0');
  const mm = String(s.minute % 60).padStart(2, '0');
  $('clock').textContent = `round ${s.round} · ${hh}:${mm}`;
  $('total').textContent = s.total === null ? 'withheld' : fmtW(s.total);
  $('included').textContent = `${s.included} of ${s.state.length} homes`;
  $('status').innerHTML =
    s.status === 'published'
      ? `Published. ${leftOut ? `<span class="warn">${leftOut} left out</span> this round; ` : ''}round took ${Math.round(Object.values(s.ms).reduce((a, b) => a + b, 0))} ms.`
      : s.status === 'suppressed'
        ? `<span class="warn">Withheld</span>: fewer than ${MIN_GROUP_SIZE} homes would be in the total.`
        : `<span class="fail">Aborted</span>: ${s.reason}`;

  const c = s.counters;
  $('invariant').innerHTML =
    s.total === null
      ? 'No total this round.'
      : `Veil total ${fmtW(s.total)} ${s.total === s.truth ? '<span class="ok">=</span>' : '<span class="fail">≠</span>'} true total of the ${s.included} homes included ${fmtW(s.truth!)}`;
  $('counters').innerHTML = [
    ['rounds', c.rounds],
    ['published', c.published],
    ['exact', c.exact],
    ['mismatches', `<b class="${c.mismatches ? 'fail' : 'ok'}">${c.mismatches}</b>`],
    ['withheld (group too small)', c.suppressed],
    ['aborted', c.aborted],
  ]
    .map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`)
    .join('');

  $('maskedCount').textContent = String(s.maskedCount);
  $('masked').innerHTML = s.masked.map((h) => `<span>${h}</span>`).join('');
  $('decoded').textContent = s.total === null ? '—' : fmtW(s.total);

  const unplugged = s.state.reduce((a, v) => a + (v === 2 ? 1 : 0), 0);
  const after = s.ms.confirm + s.ms.collect + s.ms.check + s.ms.route + s.ms.release + s.ms.gather + s.ms.unmask + s.ms.recover;
  $('recovery').innerHTML = [
    ['unplugged', unplugged],
    ['left out this round (unplugged or missed the deadline)', leftOut],
    ['reports collected', `${Math.round(s.ms.report + s.ms.close)} ms`],
    ['confirm, check, release and any unmasking', `${Math.round(after)} ms`],
    ['meter-side CPU, per meter', `${s.meterMs.toFixed(1)} ms`],
  ]
    .map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`)
    .join('');
  if (s.aborts.length) $('recovery').innerHTML += `<tr><td class="warn" colspan="2">${s.aborts.length} meter(s) refused: ${s.aborts[0]}</td></tr>`;

  if (!$('billingBox').classList.contains('hidden')) billing(s);
  spark();
  paint();
}

function billing(s: Snapshot): void {
  const [g, w, h] = chartCanvas('billChart');
  const kwh = s.billing.kwh;
  const top = Math.max(0.5, ...kwh);
  const bw = w / 8;
  g.fillStyle = '#93a0bd';
  g.fillText(`Home ${s.billing.house}, kWh per 30 min (latest block still filling)`, 0, 11);
  kwh.forEach((v, i) => {
    const bh = (Math.max(0, v) / top) * (h - 34);
    g.fillStyle = i === kwh.length - 1 ? '#7dd3fc' : '#3b82f6';
    g.fillRect(i * bw + 4, h - 14 - bh, bw - 8, bh);
    g.fillStyle = '#e6e9f2';
    g.fillText(v.toFixed(2), i * bw + 4, h - 17 - bh);
  });
  g.fillStyle = '#93a0bd';
  g.fillText('older ← → now', 0, h - 2);
}
$('billingOn').addEventListener('change', (e) => {
  $('billingBox').classList.toggle('hidden', !(e.target as HTMLInputElement).checked);
  if (last) billing(last);
});

// Group size: E5's measured detection AUC against group size, with the chosen minimum marked.
const e5Points = e5.results.filter((r) => r.observation !== 'masked reports of one home').map((r) => ({ n: r.n, auc: r.informed.auc }));
const sizeSlider = $<HTMLInputElement>('size');
sizeSlider.max = String(e5Points.length - 1);
sizeSlider.value = String(e5Points.findIndex((p) => p.n === MIN_GROUP_SIZE));
function sizeChart(): void {
  const [g, w, h] = chartCanvas('sizeChart');
  const sel = e5Points[Number(sizeSlider.value)]!;
  const lx = (n: number) => 24 + (Math.log10(n) / 3) * (w - 34);
  const ly = (a: number) => 8 + ((1 - a) / 0.55) * (h - 26);
  g.strokeStyle = '#26314f';
  g.fillStyle = '#93a0bd';
  for (const a of [0.5, e5.criterion, 1]) {
    g.beginPath();
    g.moveTo(24, ly(a));
    g.lineTo(w - 6, ly(a));
    g.stroke();
    g.fillText(a.toFixed(1), 0, ly(a) + 4);
  }
  for (const n of [1, 10, 100, 1000]) g.fillText(String(n), lx(n) - 6, h - 4);
  g.strokeStyle = 'rgba(74,222,128,.7)';
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(lx(MIN_GROUP_SIZE), 4);
  g.lineTo(lx(MIN_GROUP_SIZE), h - 16);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = '#7dd3fc';
  g.beginPath();
  e5Points.forEach((p, i) => (i ? g.lineTo(lx(p.n), ly(p.auc)) : g.moveTo(lx(p.n), ly(p.auc))));
  g.stroke();
  g.fillStyle = '#fde047';
  g.beginPath();
  g.arc(lx(sel.n), ly(sel.auc), 4.5, 0, 7);
  g.fill();
  const verdict =
    sel.n === 1 ? 'a single home: the pump is plain to see' : sel.auc > e5.criterion ? 'the detector still works' : 'the detector is close to guessing (0.5)';
  $('sizeText').innerHTML = `${sel.n} ${sel.n === 1 ? 'home' : 'homes'}: AUC ${sel.auc.toFixed(3)}, ${verdict}. Veil publishes only totals of at least <b>${MIN_GROUP_SIZE}</b> homes (dashed line).`;
}
sizeSlider.addEventListener('input', sizeChart);

// Collusion.
let colluding = false;
function collude(): void {
  const c = Number($<HTMLInputElement>('collude').value);
  $('colludeLabel').textContent = `${c} of 6 neighbours corrupt`;
  if (colluding) return;
  colluding = true;
  $('colludeResult').textContent = 'running the attack…';
  send({ type: 'collusion', corrupt: c, reading: '2345' });
}
$('collude').addEventListener('change', collude);
function colluded(r: CollusionResult): void {
  colluding = false;
  const now = Number($<HTMLInputElement>('collude').value);
  if (now !== r.corrupt) return collude();
  $('colludeResult').innerHTML = r.exposed
    ? `<span class="fail">exposed by the ${r.by} split: ${r.guess} W</span> (true ${r.truth} W)`
    : `<span class="ok">hidden</span> in all ${r.splits} attempts, active-set and final-set splits (t = ${r.t})`;
}

$('tamper').addEventListener('click', () => send({ type: 'tamper', delta: 1000 }));
function tampered(r: Extract<Event, { type: 'tamper' }>['result']): void {
  if (!r) return void ($('auditOut').textContent = 'No total published yet.');
  $('auditOut').innerHTML =
    `Round ${r.round}: the ledger holds <b>${fmtW(Number(r.recorded))}</b>.<br>` +
    `Second total: <span class="${r.ledger.startsWith('rejected') ? 'ok' : 'fail'}">${r.ledger}</span>.<br>` +
    `Auditor recomputing from the signed evidence: ${r.audit.length ? `<span class="ok">flagged</span> (${r.audit.join('; ')})` : '<span class="fail">no problem found</span>'}.`;
  setMode('audit');
  $('auditCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let paused = false;
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  send({ type: 'pause', paused });
});

// ---- Worker events ----
const started = performance.now();
const timer = setInterval(() => ($('elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(0)} s`), 500);
worker.onmessage = (e: MessageEvent<Event>) => {
  const ev = e.data;
  if (ev.type === 'progress') $('progress').textContent = ev.text;
  else if (ev.type === 'ready') {
    clearInterval(timer);
    $('overlay').classList.add('hidden');
    $('engineInfo').textContent = `${ev.houses} homes, k=${ev.k}, t=${ev.t}, ${ev.threads} meter threads; setup ${(ev.setupMs / 1000).toFixed(0)} s`;
    buildCity(ev.houses);
    collude();
  } else if (ev.type === 'snapshot') show(ev.snap);
  else if (ev.type === 'tamper') tampered(ev.result);
  else if (ev.type === 'collusion') colluded(ev.result);
  else if (ev.type === 'error') {
    $('overlay').classList.remove('hidden');
    $('progress').innerHTML = `<span class="fail">Engine error</span><pre class="mono" style="white-space:pre-wrap">${ev.message}</pre>`;
  }
};
setMode('veil');
sizeChart();
