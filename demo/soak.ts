// Phase 6 gate: run the demo's engine, bundled with the browser crypto backend, for a fixed wall time and count
// published totals that differ from the true sum of the homes they include. Manual unplugs, ledger tampering and the
// collusion slider are exercised along the way. Meters run in worker threads, as they do in browser workers.
// Usage: node demo/dist/soak.mjs [seconds]
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { environment, stats } from '../experiments/lib.ts';
import type { CollusionResult } from './collusion.ts';
import type { VerifiedResult } from './verified.ts';
import { Engine, Remote, type Channel } from './engine.ts';
import type { Response } from './shard.ts';

const seconds = Number(process.argv[2] ?? 600);
const threads = Math.min(8, Math.max(1, availableParallelism() - 2));
const workers: Worker[] = [];
const channel = (): Channel => {
  const w = new Worker(new URL('./shard-thread.mjs', import.meta.url));
  workers.push(w);
  return { send: (req) => w.postMessage(req), listen: (fn) => w.on('message', (res: Response) => fn(res)) };
};
const start = performance.now();
const engine = await Engine.create(Array.from({ length: threads }, channel), (step) => console.log(step));
const setupMs = performance.now() - start;
console.log(`setup ${(setupMs / 1000).toFixed(1)} s: ${JSON.stringify(engine.setupMs)}`);

const roundMs: number[] = [];
const unplugged: number[] = [];
let tampers = 0;
let tampersCaught = 0;
const LIE = 500_000; // W
let liedRounds = 0;
let liesFlagged = 0;
let cleanRounds = 0;
let falseAlarms = 0;
let seed = 7;
const pick = () => (seed = (seed * 48_271) % 2_147_483_647) % engine.ids.length;
const end = performance.now() + seconds * 1000;
let snap = await engine.step();
while (performance.now() < end) {
  const r = snap.round + 1;
  if (r % 10 === 0) {
    // Unplug a random home; once ten are out, plug the oldest back in first.
    if (unplugged.length >= 10) engine.toggle(unplugged.shift()!);
    const id = engine.ids[pick()]!;
    if (!unplugged.includes(id)) {
      engine.toggle(id);
      unplugged.push(id);
    }
  }
  if (r % 100 === 0) engine.bill(engine.ids[pick()]!);
  // A home lies by +500 kW for 20 rounds in every 100; the plausibility checks should flag those rounds only.
  if (r % 100 === 60) engine.lie(engine.ids[pick()]!, LIE);
  if (r % 100 === 80) engine.lie(1, 0);
  const t0 = performance.now();
  snap = await engine.step();
  roundMs.push(performance.now() - t0);
  if (snap.status === 'published') {
    const flagged = snap.implausible.length > 0;
    if (snap.lie) (liedRounds++, flagged && liesFlagged++);
    else (cleanRounds++, flagged && falseAlarms++);
  }
  if (r % 50 === 0 && snap.status === 'published') {
    const t = engine.tamper(1000)!;
    tampers++;
    if (t.ledger.startsWith('rejected') && t.audit.length > 0) tampersCaught++;
  }
  if (r % 50 === 0) console.log(`round ${r}: ${JSON.stringify(snap.counters)} ${JSON.stringify(snap.ms)}`);
}

const collusion = new Remote(channel());
const sweep: CollusionResult[] = [];
for (let c = 0; c <= 6; c++) sweep.push((await collusion.call<CollusionResult>('collusion', c, 2345n)).value);
const verified: VerifiedResult[] = [];
for (const kind of ['masked', 'claimed', 'inRange'] as const) verified.push((await collusion.call<VerifiedResult>('verified', kind)).value);
for (const w of workers) await w.terminate();
const c = snap.counters;
const s = stats(roundMs);
const wall = (performance.now() - start) / 1000;
const pass = c.mismatches === 0 && seconds >= 600 && tampersCaught === tampers;
const md = [
  '# Demo soak (Phase 6 gate)',
  '',
  `Environment: ${environment()}. Engine bundled by demo/build.ts with the browser crypto backend (@noble).`,
  '',
  `${engine.ids.length} simulated homes in ${threads} meter threads, k=${engine.k}, t=${engine.t}; 1% background dropout plus up to 10 homes unplugged at a time.`,
  `Run: ${wall.toFixed(0)} s wall time (target ${seconds} s), setup ${(setupMs / 1000).toFixed(1)} s.`,
  '',
  '| rounds | published | exact | mismatches | suppressed | aborted |',
  '|---:|---:|---:|---:|---:|---:|',
  `| ${c.rounds} | ${c.published} | ${c.exact} | ${c.mismatches} | ${c.suppressed} | ${c.aborted} |`,
  '',
  `Round wall time (meters in parallel threads, coordinator and ledger in one): median ${s.median.toFixed(0)} ms, p95 ${s.p95.toFixed(0)} ms, max ${s.max.toFixed(0)} ms.`,
  '',
  `Tampering: ${tampersCaught}/${tampers} second totals rejected by the ledger and flagged by the audit.`,
  '',
  `Lying meter: a home added ${LIE / 1000} kW to its reports in ${liedRounds} published rounds; the plausibility checks flagged ${liesFlagged} of them, and ${falseAlarms} of the ${cleanRounds} rounds with no liar.`,
  '',
  'Collusion slider (16 homes, k=6, t=4; survivor-set and final-set attacks over every split of the honest neighbours):',
  '',
  '| corrupt neighbours | attempts | victim exposed |',
  '|---:|---:|:---|',
  ...sweep.map((x) => `| ${x.corrupt} | ${x.splits} | ${x.exposed ? `yes, by the ${x.by} split (${x.guess} W)` : 'no'} |`),
  '',
  'Verified-mode group (16 homes, k=6, t=4, 16-bit range proofs), one round per kind of lie:',
  '',
  '| the liar | round | liar in the total | published | true sum of the homes included | validators checking every proof |',
  '|---|---|---|---:|---:|---|',
  ...verified.map((v) => `| ${v.kind === 'masked' ? 'changes its masked value only' : v.kind === 'claimed' ? `claims +${Number(v.lie) / 1000} kW (out of range)` : `claims +${Number(v.lie) / 1000} kW (in range)`} | ${v.status}${v.reason ? `: ${v.reason}` : ''} | ${v.status === 'published' ? (v.liarIncluded ? 'yes' : 'no') : ''} | ${v.total ?? ''} | ${v.honest ?? ''} | ${v.validators ?? ''} |`),
  '',
  `Gate (zero mismatches over at least ten minutes): ${pass ? 'PASS' : 'FAIL'}`,
];
const dir = new URL('../../experiments/results/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('demo-soak.md', dir), md.join('\n') + '\n');
writeFileSync(
  new URL('demo-soak.json', dir),
  JSON.stringify({ environment: environment(), homes: engine.ids.length, threads, setupPhasesMs: engine.setupMs, k: engine.k, t: engine.t, seconds: wall, setupMs, counters: c, roundMs: s, tampers, tampersCaught, lies: { lie: LIE, liedRounds, liesFlagged, cleanRounds, falseAlarms }, verified, collusion: sweep, pass }, null, 2) + '\n',
);
console.log(md.join('\n'));
