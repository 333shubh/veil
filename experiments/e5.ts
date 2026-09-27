// E5: does the masked stream leak? A water-pump detection attack on one home's raw readings, on its masked reports, and
// on group totals of increasing size; the detection AUC against group size sets the minimum group size.
// Run: npm run e5   (writes experiments/results/e5.md and e5.json)
import { hkdf, u32Stream } from '../src/crypto.ts';
import { simulateLoad, type ApplianceEvent } from '../src/load.ts';
import { choose, DESIGN } from '../src/params.ts';
import type { MeterId } from '../src/protocol.ts';
import { decode } from '../src/ring.ts';
import { setupGroup } from '../src/simulation.ts';
import { environment, writeResult } from './lib.ts';

const HOMES = 1000;
const DAYS = 7;
const INTERVAL = 10; // seconds: the protocol reports every few seconds
const GROUP_SIZES = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000];
const TARGETS = 40;
const WINDOW = 30; // samples (5 minutes)
const CRITERION = 0.6; // an attack AUC at or below this is accepted, fixed before the run
const SEED = 'veil E5 seed 1';

const homes: MeterId[] = Array.from({ length: HOMES }, (_, i) => i + 1);
const load = simulateLoad(homes, DAYS, INTERVAL, SEED);
const next = u32Stream(hkdf(Buffer.from(SEED), Buffer.from('e5')));
const pick = (n: number) => Math.floor((next() / 2 ** 32) * n);
function sample<T>(items: readonly T[], count: number): T[] {
  const out = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + pick(out.length - i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, count);
}

/**
 * Pump score for a window: the strongest rise into `band` watts that falls back by a similar amount 30 s to 3.5
 * minutes later. A generic attacker uses the whole pump band; an informed one knows the target's pump wattage.
 */
function score(series: ArrayLike<number>, from: number, band: [number, number]): number {
  let best = 0;
  for (let t = Math.max(1, from); t < from + WINDOW && t < series.length; t++) {
    const up = series[t]! - series[t - 1]!;
    if (up < band[0] || up > band[1]) continue;
    for (let d = 3; d <= 21 && t + d < series.length; d++) {
      const down = series[t + d - 1]! - series[t + d]!;
      if (down >= 0.8 * up && down <= 1.2 * up) {
        best = Math.max(best, Math.min(up, down));
        break;
      }
    }
  }
  return best;
}

/** Mann-Whitney AUC with its Hanley-McNeil standard error. */
function auc(pos: number[], neg: number[]): { auc: number; se: number; accuracy: number } {
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  const a = wins / (pos.length * neg.length);
  const q1 = a / (2 - a);
  const q2 = (2 * a * a) / (1 + a);
  const se = Math.sqrt((a * (1 - a) + (pos.length - 1) * (q1 - a * a) + (neg.length - 1) * (q2 - a * a)) / (pos.length * neg.length));
  // Best balanced accuracy over thresholds (optimistic for the attacker).
  let accuracy = 0.5;
  for (const th of new Set([...pos, ...neg])) {
    const tpr = pos.filter((s) => s >= th).length / pos.length;
    const tnr = neg.filter((s) => s < th).length / neg.length;
    accuracy = Math.max(accuracy, (tpr + tnr) / 2);
  }
  return { auc: a, se, accuracy };
}

// Targets: homes with a water pump; positives are 5-minute windows where the pump starts. Negatives are the same
// time of day on another day when the target's pump did not start within 10 minutes, so the attack must attribute a
// start to the target rather than recognise the hours when pumps run.
const pumps = new Map<MeterId, ApplianceEvent[]>();
for (const e of load.events) if (e.appliance === 'pump') pumps.set(e.home, [...(pumps.get(e.home) ?? []), e]);
const targets = homes.filter((h) => pumps.has(h)).slice(0, TARGETS);
const windows = targets.map((h) => {
  const starts = pumps.get(h)!.map((e) => e.start);
  const positives = starts.map((s) => s - WINDOW / 2).filter((w) => w > 0 && w + WINDOW + 30 < load.samples);
  const perDay = 86_400 / INTERVAL;
  const negatives: number[] = [];
  for (const w of positives) {
    for (let tries = 0; tries < 50; tries++) {
      const shifted = w + (1 + pick(DAYS - 1)) * perDay;
      const other = shifted % (DAYS * perDay);
      if (other > 0 && other + WINDOW + 30 < load.samples && starts.every((s) => Math.abs(s - (other + WINDOW / 2)) > 60)) {
        negatives.push(other);
        break;
      }
    }
  }
  return { home: h, watts: pumps.get(h)![0]!.watts, positives, negatives };
});

const started = performance.now();
const results: { observation: string; n: number; generic: ReturnType<typeof auc>; informed: ReturnType<typeof auc> }[] = [];
function attack(observation: string, n: number, seriesFor: (target: (typeof windows)[number], index: number) => ArrayLike<number>) {
  const s = { generic: { pos: [] as number[], neg: [] as number[] }, informed: { pos: [] as number[], neg: [] as number[] } };
  windows.forEach((w, index) => {
    const series = seriesFor(w, index);
    const informed: [number, number] = [w.watts - 80, w.watts + 80];
    for (const [list, starts] of [['pos', w.positives], ['neg', w.negatives]] as const) {
      for (const from of starts) {
        s.generic[list].push(score(series, from, [500, 900]));
        s.informed[list].push(score(series, from, informed));
      }
    }
  });
  const row = { observation, n, generic: auc(s.generic.pos, s.generic.neg), informed: auc(s.informed.pos, s.informed.neg) };
  results.push(row);
  console.log(`[e5] ${observation} N=${n}: AUC generic ${row.generic.auc.toFixed(3)}, informed ${row.informed.auc.toFixed(3)}`);
}

// Group totals, as Veil publishes them exactly; N = 1 is the raw meter.
for (const n of GROUP_SIZES) {
  attack(n === 1 ? 'raw readings of one home' : 'group total', n, (w) => {
    const members = [w.home, ...sample(homes.filter((h) => h !== w.home), n - 1)];
    const total = new Float64Array(load.samples);
    for (const m of members) {
      const p = load.power.get(m)!;
      for (let i = 0; i < load.samples; i++) total[i]! += p[i]!;
    }
    return total;
  });
}

// One home's masked reports, produced by Meter.report in a 50-meter group at E7's k and t.
const { k, t } = choose(50, DESIGN)!;
const group = setupGroup(Array.from({ length: 50 }, (_, i) => i + 1), 1, k, t);
const meter = group.meters.get(1)!;
attack('masked reports of one home', 1, (w, index) => {
  const series = new Float64Array(load.samples);
  const needed = new Set<number>();
  for (const from of [...w.positives, ...w.negatives]) for (let i = from - 1; i < from + WINDOW + 28 && i < load.samples; i++) needed.add(i);
  for (const i of needed) series[i] = Number(decode(meter.report(index * load.samples + i, BigInt(load.power.get(w.home)![i]!)).y));
  return series;
});

const totals = results.filter((r) => r.observation !== 'masked reports of one home');
const chosen = totals.find((r) => r.informed.auc + 1.96 * r.informed.se <= CRITERION);
let e7Floor = 3; // smallest group E7 can size
while (!choose(e7Floor, DESIGN)) e7Floor++;
const minimum = Math.max(chosen?.n ?? Infinity, e7Floor);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const kwh = [...load.power.values()].map((p) => p.reduce((a, w) => a + w, 0) * (INTERVAL / 3600) / 1000 / DAYS);
const md = [
  '# E5: does the masked stream leak?',
  '',
  `Generated by \`npm run e5\` on ${new Date().toISOString().slice(0, 10)}: ${environment()}. Seed "${SEED}". Run time ${seconds} s.`,
  '',
  `Load: ${HOMES} simulated Indian homes (\`src/load.ts\`, checked against CEEW and iAWE in load-validation.md), ${DAYS} ` +
    `summer days at one sample every ${INTERVAL} s; mean ${(kwh.reduce((a, b) => a + b, 0) / kwh.length).toFixed(1)} kWh per home per day.`,
  '',
  `Attack: for ${targets.length} target homes with a water pump, score each 5-minute window for the target's pump switching ` +
    'on (a rise into the pump band that falls back 30 s to 3.5 minutes later). The generic attacker uses 500-900 W, which ' +
    "also catches mixer-grinders and other loads; the informed attacker knows the target pump's wattage to within 80 W. " +
    `${windows.reduce((a, w) => a + w.positives.length, 0)} windows with a pump start against ` +
    `${windows.reduce((a, w) => a + w.negatives.length, 0)} without, at the same time of day on other days. AUC 0.5 ` +
    'is chance; "accuracy" is the best balanced accuracy over thresholds.',
  '',
  '| observation | group size | AUC, generic (95% CI) | accuracy, generic | AUC, informed (95% CI) | accuracy, informed |',
  '|---|---|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.observation} | ${r.n} | ${r.generic.auc.toFixed(3)} ± ${(1.96 * r.generic.se).toFixed(3)} | ${r.generic.accuracy.toFixed(3)} | ` +
      `${r.informed.auc.toFixed(3)} ± ${(1.96 * r.informed.se).toFixed(3)} | ${r.informed.accuracy.toFixed(3)} |`,
  ),
  '',
  '## Minimum group size',
  '',
  `Criterion, fixed before the run: the informed attack's AUC must be at most ${CRITERION} at the upper end of its 95% ` +
    `interval. ${chosen ? `The smallest group size that meets it is ${chosen.n}.` : `No group size up to ${HOMES} meets it.`} ` +
    `E7 also needs at least ${e7Floor} meters for meters left out of a round to stay under 2^${DESIGN.recoveryLog2} at ` +
    `${DESIGN.dropout * 100}% dropout. Minimum group size: **${Number.isFinite(minimum) ? minimum : `more than ${HOMES}`}**.`,
];
writeResult('e5', md, { environment: environment(), seconds: Number(seconds), seed: SEED, criterion: CRITERION, results, chosen: chosen?.n ?? null, e7Floor, minimum: Number.isFinite(minimum) ? minimum : null });
console.log(`[e5] minimum group size ${minimum}; done in ${seconds} s`);
