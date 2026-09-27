// Validation of the Indian load simulator (src/load.ts) against measured data: CEEW's smart meters in Mathura and
// Bareilly, May-August 2020 (group statistics) and the iAWE house in Delhi, summer 2013 (appliance sizes and cycles).
// Data: $VEIL_DATA/ceew/{mathura,bareilly}_2020.csv and $VEIL_DATA/iawe/electricity/*.csv (default ~/veil-data).
// Run: npm run load-validation   (writes experiments/results/load-validation.md and .json)
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { simulateLoad, type Appliance } from '../src/load.ts';
import { environment, writeResult } from './lib.ts';

const DATA = process.env.VEIL_DATA ?? join(homedir(), 'veil-data');
const SEED = 'veil load validation 1';
const HOMES = 100;
const DAYS = 60;

const quantile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function* rows(file: string) {
  let header = true;
  for await (const line of createInterface({ input: createReadStream(file) })) {
    if (header) header = false;
    else yield line.split(',');
  }
}

interface GroupStats {
  homes: number;
  daily: { p10: number; median: number; p90: number; mean: number }; // kWh per home-day
  peak: number; // median over homes of the largest 3-minute mean demand, kW
  profile: number[]; // mean demand by hour, as a multiple of the daily mean
}

function summarise(days: number[], peaks: number[], hourly: number[]): GroupStats {
  const m = mean(hourly);
  return {
    homes: peaks.length,
    daily: { p10: quantile(days, 0.1), median: quantile(days, 0.5), p90: quantile(days, 0.9), mean: mean(days) },
    peak: quantile(peaks, 0.5),
    profile: hourly.map((h) => h / m),
  };
}

/** CEEW, May to August: kWh per meter-day (days above 0.2 kWh), peak 3-minute kW, mean kW by hour. */
async function ceew(): Promise<GroupStats> {
  const day = new Map<string, number>();
  const peak = new Map<string, number>();
  const hour = new Array<number>(24).fill(0);
  const count = new Array<number>(24).fill(0);
  for (const district of ['mathura_2020', 'bareilly_2020']) {
    for await (const [stamp, kwh, , , , meter] of rows(join(DATA, 'ceew', `${district}.csv`))) {
      const month = stamp!.slice(0, 7);
      const k = Number(kwh);
      if (month < '2020-05' || month > '2020-08' || !meter || !Number.isFinite(k)) continue;
      const h = Number(stamp!.slice(11, 13));
      const key = `${district}/${meter}`;
      day.set(`${key}/${stamp!.slice(0, 10)}`, (day.get(`${key}/${stamp!.slice(0, 10)}`) ?? 0) + k);
      peak.set(key, Math.max(peak.get(key) ?? 0, k * 20));
      hour[h]! += k * 20;
      count[h]!++;
    }
  }
  return summarise([...day.values()].filter((v) => v > 0.2), [...peak.values()], hour.map((h, i) => h / count[i]!));
}

/** The simulator, averaged to CEEW's 3-minute readings. */
function simulated(): GroupStats {
  const homes = Array.from({ length: HOMES }, (_, i) => i + 1);
  const load = simulateLoad(homes, DAYS, 60, SEED);
  const days: number[] = [];
  const peaks: number[] = [];
  const hour = new Array<number>(24).fill(0);
  for (const p of load.power.values()) {
    let peak = 0;
    for (let d = 0; d < DAYS; d++) {
      let wh = 0;
      for (let i = d * 1440; i < (d + 1) * 1440; i++) wh += p[i]! / 60;
      days.push(wh / 1000);
      for (let i = d * 1440; i < (d + 1) * 1440; i += 3) peak = Math.max(peak, (p[i]! + p[i + 1]! + p[i + 2]!) / 3 / 1000);
    }
    peaks.push(peak);
    for (let i = 0; i < p.length; i++) hour[Math.floor((i % 1440) / 60)]! += p[i]! / 1000 / (p.length / 24);
  }
  return summarise(days.filter((v) => v > 0.2), peaks, hour.map((h) => h / HOMES));
}

interface Runs {
  count: number;
  watts: number; // median power while on
  minutes: number; // median run length
  perDay: number;
}

/** iAWE: runs above `threshold` W in one appliance channel (gaps up to `merge` s join a run; runs under 5 s dropped). */
async function iawe(channel: number, threshold: number, merge = 30): Promise<Runs> {
  const runs: { start: number; end: number; watts: number[] }[] = [];
  let first = Infinity;
  let last = -Infinity;
  for await (const [stamp, w] of rows(join(DATA, 'iawe', 'electricity', `${channel}.csv`))) {
    const t = Number(stamp);
    const watts = Number(w);
    if (!Number.isFinite(t) || !Number.isFinite(watts)) continue;
    first = Math.min(first, t);
    last = Math.max(last, t);
    if (watts < threshold) continue;
    const run = runs.at(-1);
    if (run && t - run.end <= merge) {
      run.end = t;
      run.watts.push(watts);
    } else runs.push({ start: t, end: t, watts: [watts] });
  }
  const kept = runs.filter((r) => r.end - r.start >= 5);
  return {
    count: kept.length,
    watts: quantile(kept.map((r) => quantile(r.watts, 0.5)), 0.5),
    minutes: quantile(kept.map((r) => (r.end - r.start) / 60), 0.5),
    perDay: kept.length / ((last - first) / 86_400),
  };
}

/** The simulator's appliance runs, per home that owns the appliance. */
function simulatedRuns(appliance: Appliance): Runs {
  const homes = Array.from({ length: HOMES }, (_, i) => i + 1);
  const load = simulateLoad(homes, DAYS, 60, SEED);
  const events = load.events.filter((e) => e.appliance === appliance);
  const owners = new Set(events.map((e) => e.home)).size;
  return {
    count: events.length,
    watts: quantile(events.map((e) => e.watts), 0.5),
    minutes: quantile(events.map((e) => e.end - e.start), 0.5),
    perDay: events.length / owners / DAYS,
  };
}

const started = performance.now();
const measured = await ceew();
const sim = simulated();
const correlation = (() => {
  const [a, b] = [measured.profile, sim.profile];
  const [ma, mb] = [mean(a), mean(b)];
  const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i]! - mb), 0);
  return cov / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
})();
const appliances: [string, Appliance, number, number, number?][] = [
  ['water pump', 'pump', 12, 300],
  ['air conditioner (compressor runs)', 'ac', 5, 800],
  ['iron', 'iron', 8, 300, 120],
];
const applianceRows = [];
for (const [name, appliance, channel, threshold, merge] of appliances) {
  applianceRows.push({ name, measured: await iawe(channel, threshold, merge), simulated: simulatedRuns(appliance) });
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const f = (x: number) => x.toFixed(2);
console.log(`[load-validation] daily kWh median CEEW ${f(measured.daily.median)} vs simulator ${f(sim.daily.median)}; profile correlation ${f(correlation)}`);

const md = [
  '# Load simulator against measured Indian data',
  '',
  `Generated by \`npm run load-validation\` on ${new Date().toISOString().slice(0, 10)}: ${environment()}. Seed "${SEED}". Run time ${seconds} s.`,
  '',
  'Measured: CEEW smart meters in Mathura and Bareilly, Uttar Pradesh, May-August 2020 (doi:10.7910/DVN/GOCHJH, CC0); the ' +
    'iAWE house in Delhi, May-August 2013 (per-appliance power every second). Simulated: `src/load.ts`, ' +
    `${HOMES} homes for ${DAYS} summer days, averaged to CEEW's 3-minute readings.`,
  '',
  '## Group statistics against CEEW',
  '',
  '| | homes | daily kWh p10 | median | p90 | mean | peak 3-minute demand, median (kW) |',
  '|---|---|---|---|---|---|---|',
  ...[['CEEW (measured)', measured], ['simulator', sim]].map(
    ([label, s]) => `| ${label} | ${(s as GroupStats).homes} | ${f((s as GroupStats).daily.p10)} | ${f((s as GroupStats).daily.median)} | ${f((s as GroupStats).daily.p90)} | ${f((s as GroupStats).daily.mean)} | ${f((s as GroupStats).peak)} |`,
  ),
  '',
  `Mean demand by hour of day, as a multiple of the daily mean (correlation between the two: ${f(correlation)}):`,
  '',
  `| hour | ${Array.from({ length: 24 }, (_, h) => h).join(' | ')} |`,
  `|---|${'---|'.repeat(24)}`,
  `| CEEW | ${measured.profile.map(f).join(' | ')} |`,
  `| simulator | ${sim.profile.map(f).join(' | ')} |`,
  '',
  '## Appliances against iAWE',
  '',
  '| appliance | iAWE runs | iAWE power (W) | iAWE run length (min) | iAWE runs per day | simulated power (W) | simulated run length (min) | simulated runs per day per owner |',
  '|---|---|---|---|---|---|---|---|',
  ...applianceRows.map(
    (r) => `| ${r.name} | ${r.measured.count} | ${r.measured.watts.toFixed(0)} | ${f(r.measured.minutes)} | ${f(r.measured.perDay)} | ${r.simulated.watts.toFixed(0)} | ${f(r.simulated.minutes)} | ${f(r.simulated.perDay)} |`,
  ),
  '',
  'iAWE is one house; its figures anchor appliance sizes, not household mix. CEEW anchors the mix.',
];
writeResult('load-validation', md, { environment: environment(), seconds: Number(seconds), seed: SEED, measured, simulated: sim, correlation, appliances: applianceRows });
console.log(`[load-validation] done in ${seconds} s`);
