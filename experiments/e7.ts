// E7: is the neighbourhood size safe? Monte Carlo on generated graphs checks the exact model where failures are
// common enough to count; the exact model then sets k for each group size at the chosen bounds.
// Run: npm run e7   (writes experiments/results/e7.md)
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { hkdf, u32Stream } from '../src/crypto.ts';
import { harary } from '../src/graph.ts';
import { choose, DESIGN, evaluate, MAX_K, perMeter, strongestThreshold, type Design } from '../src/params.ts';

const SEED = 'veil E7 seed 1';
const MASTER = hkdf(Buffer.from(SEED), Buffer.from('e7'));
const TRIALS = 2000;
const Z = 3.29; // two-sided 99.9%
const GROUP_SIZES = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const MC_RATES: [number, number][] = [[0.1, 0.1], [0.2, 0.2], [1 / 3, 0.1]];
const MC_SIZES = [50, 200, 1000];
const MC_KS = [4, 8, 12, 16];
const SWEEP_CORRUPT = [0.05, 0.1, 0.2, 1 / 3];
const SWEEP_DROPOUT = [0.01, 0.05, 0.1, 0.2];

const sci = (p: number) => (p === 0 ? '0' : p.toExponential(1));
const bits = (l: number) => (l === -Infinity ? '-inf' : l.toFixed(1));
const rate = (x: number) => (Math.abs(x - 1 / 3) < 1e-9 ? '1/3' : String(x));

interface Stat {
  mean: number;
  se: number; // across trials, so correlation between meters in one graph is accounted for
  samples: number;
}

function stat(fractions: number[], perTrial: number): Stat {
  const mean = fractions.reduce((a, b) => a + b, 0) / fractions.length;
  const variance = fractions.reduce((a, b) => a + (b - mean) ** 2, 0) / (fractions.length - 1);
  return { mean, se: Math.sqrt(variance / fractions.length), samples: fractions.length * perTrial };
}

/** Exact value inside the MC interval; undefined when fewer than 20 events are expected. */
function agrees(s: Stat, exact: number): boolean | undefined {
  if (exact * s.samples < 20) return undefined;
  return Math.abs(s.mean - exact) <= Z * s.se;
}

/** P(X >= hits) for X ~ Binomial(n, p): how surprising the Monte Carlo count is if p were the true rate. */
function upperTail(hits: number, n: number, p: number): number {
  if (hits === 0 || p >= 1) return 1;
  let term = (1 - p) ** n;
  let below = 0;
  for (let i = 0; i < hits; i++) {
    below += term;
    term *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.max(0, 1 - below);
}

/** The Monte Carlo count is not significantly above the bound (one-sided exact binomial test, alpha = 0.001). */
const within = (hits: number, bound: number) => upperTail(hits, TRIALS, Math.min(1, bound)) >= 0.001;

function monteCarlo(row: number, n: number, k: number, corrupt: number, dropout: number) {
  const t = Math.floor(k / 2) + 1;
  const c = Math.floor(corrupt * n + 1e-9);
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const next = u32Stream(hkdf(MASTER, Buffer.from(`mc/${row}`)));
  const uniform = () => next() / 2 ** 32;
  const breach: number[] = [];
  const stranded: number[] = [];
  let groupBreach = 0;
  let aborts = 0;
  let partitions = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const graph = harary(ids, k, hkdf(MASTER, Buffer.from(`graph/${row}/${trial}`)));
    const order = [...ids];
    for (let i = 0; i < c; i++) {
      const j = i + Math.floor(uniform() * (n - i));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const bad = new Set(order.slice(0, c));
    const live = new Set(ids.filter(() => uniform() >= dropout));
    let breached = 0;
    let strandedCount = 0;
    let aborted = false;
    for (const i of ids) {
      const ns = graph.get(i)!;
      if (!bad.has(i) && ns.filter((j) => bad.has(j)).length >= t) breached++;
      const liveNs = ns.filter((j) => live.has(j)).length;
      if (liveNs < t) {
        strandedCount++;
        if (live.has(i) || liveNs > 0) aborted = true; // its seed or key is needed and cannot be rebuilt
      }
    }
    const honest = ids.filter((i) => live.has(i) && !bad.has(i));
    if (honest.length > 1) {
      const seen = new Set([honest[0]!]);
      const stack = [honest[0]!];
      while (stack.length > 0) {
        for (const v of graph.get(stack.pop()!)!) {
          if (live.has(v) && !bad.has(v) && !seen.has(v)) {
            seen.add(v);
            stack.push(v);
          }
        }
      }
      if (seen.size < honest.length) partitions++;
    }
    breach.push(breached / (n - c));
    stranded.push(strandedCount / n);
    if (breached > 0) groupBreach++;
    if (aborted) aborts++;
  }

  const exact = perMeter(n, k, t, { ...DESIGN, corrupt, dropout });
  const pairs = (n * (n - 1)) / 2;
  const bound = {
    groupBreach: (n - c) * exact.breach,
    abort: n * exact.stranded,
    partition: k >= n - 1 ? 0 : pairs * exact.runsBad,
  };
  const b = stat(breach, n - c);
  const s = stat(stranded, n);
  const checks = [
    agrees(b, exact.breach),
    agrees(s, exact.stranded),
    within(groupBreach, bound.groupBreach),
    within(aborts, bound.abort),
    within(partitions, bound.partition),
  ];
  const ok = checks.every((x) => x !== false);
  const mark = (x: boolean | undefined) => (x === undefined ? ' (rare)' : x ? '' : ' **FAIL**');
  const line =
    `| ${n} | ${k} | ${t} | ${rate(corrupt)} | ${rate(dropout)} ` +
    `| ${sci(b.mean)} ± ${sci(Z * b.se)} | ${sci(exact.breach)}${mark(checks[0])} ` +
    `| ${sci(s.mean)} ± ${sci(Z * s.se)} | ${sci(exact.stranded)}${mark(checks[1])} ` +
    `| ${sci(groupBreach / TRIALS)} | ${sci(bound.groupBreach)} ` +
    `| ${sci(aborts / TRIALS)} | ${sci(bound.abort)} ` +
    `| ${sci(partitions / TRIALS)} | ${sci(bound.partition)} |`;
  return { ok, line, counted: checks.slice(0, 2).filter((x) => x !== undefined).length };
}

const started = performance.now();
const out: string[] = [];
const cpu = cpus();
out.push('# E7: is the neighbourhood size safe?', '');
out.push(
  `Generated by \`npm run e7\` on ${new Date().toISOString().slice(0, 10)}: seed "${SEED}", ${TRIALS} trials per Monte Carlo row, ` +
    `Node ${process.version}, ${cpu[0]?.model.trim()} (${cpu.length} threads), ${process.platform}.`,
  '',
);
out.push(
  'Graph: random Harary (`src/graph.ts`), so a meter\'s k neighbours are a uniform k-subset of the other N - 1. ' +
    'Adversary: floor(corrupt * N) meters corrupted before the graph seed is published. ' +
    'Dropout: each meter independently misses a round with probability `dropout`. ' +
    'Exact values come from `src/params.ts` (rational arithmetic, no approximation).',
  '',
);

// 1. Monte Carlo against the exact model.
out.push('## 1. Monte Carlo against the exact model', '');
out.push(
  `t = floor(k/2) + 1. Per-meter rates show the Monte Carlo mean ± its 99.9% interval next to the exact value; ` +
    `group rates are per trial next to the union bound, and must not exceed it significantly (exact binomial test, ` +
    `alpha 0.001). "(rare)" marks exact values with fewer than 20 expected events, which are not tested.`,
  '',
);
out.push(
  '| N | k | t | corrupt | dropout | breach per meter (MC) | exact | stranded per meter (MC) | exact | group breach (MC) | union bound | aborted round (MC) | union bound | partitioned round (MC) | bound |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
);
let mcRows = 0;
let mcFailures = 0;
let mcCounted = 0;
for (const [corrupt, dropout] of MC_RATES) {
  for (const n of MC_SIZES) {
    for (const k of MC_KS) {
      const rowStart = performance.now();
      const r = monteCarlo(mcRows++, n, k, corrupt, dropout);
      out.push(r.line);
      console.log(`[e7] mc ${mcRows}/${MC_RATES.length * MC_SIZES.length * MC_KS.length} N=${n} k=${k} ${r.ok ? 'ok' : 'DISAGREES'} (${((performance.now() - rowStart) / 1000).toFixed(1)} s)`);
      mcCounted += r.counted;
      if (!r.ok) mcFailures++;
    }
  }
}
console.log(`[e7] monte carlo: ${mcRows} rows x ${TRIALS} trials, ${mcCounted} per-meter comparisons tested, ${mcFailures} rows disagree`);

// 2. The gate: k for each group size at the design point.
const design = (d: Design) =>
  `corrupt ${rate(d.corrupt)}, dropout ${d.dropout}, privacy failure <= 2^${d.privacyLog2} per group per epoch ` +
  `(${d.roundsPerEpoch} rounds), aborted round <= 2^${d.recoveryLog2} per group per round, t > k/2`;
out.push('', '## 2. Chosen k per group size (gate)', '', `Design point: ${design(DESIGN)}.`, '');
out.push('| N | k | t | t range | log2 privacy failure | log2 partition | log2 aborted round | meets bounds |', '|---|---|---|---|---|---|---|---|');
const chosen = new Map<number, number>();
const missing: string[] = [];
for (const n of GROUP_SIZES) {
  const c = choose(n, DESIGN);
  if (c) {
    chosen.set(n, c.k);
    out.push(`| ${n} | ${c.k}${c.k === n - 1 ? ' (complete)' : ''} | ${c.t} | ${c.tRange.join('-')} | ${bits(c.privacy)} | ${bits(c.partition)} | ${bits(c.recovery)} | yes |`);
    console.log(`[e7] N=${n}: k=${c.k} t=${c.t} privacy 2^${bits(c.privacy)} abort 2^${bits(c.recovery)}`);
  } else if (n - 1 > MAX_K) {
    throw new Error(`no k up to ${MAX_K} for N=${n}`);
  } else {
    const t = Math.floor((n - 1) / 2) + 1;
    const f = evaluate(n, n - 1, t, DESIGN);
    missing.push(`N=${n} (complete graph, t=${t}: aborted round 2^${bits(f.recovery)})`);
    out.push(`| ${n} | none | | | ${bits(f.privacy)} at k=${n - 1}, t=${t} | | ${bits(f.recovery)} at k=${n - 1}, t=${t} | no: aborts |`);
    console.log(`[e7] N=${n}: no k; complete graph t=${t} gives privacy 2^${bits(f.privacy)} abort 2^${bits(f.recovery)}`);
  }
}

// 3. Failure probability against k.
const maxK = Math.max(...chosen.values()) + 8;
out.push('', '## 3. Privacy failure against k', '');
out.push(
  'log2 of the privacy union bound at the design point, with t set as high as the aborted-round bound allows. ' +
    '"abort" means no t > k/2 meets that bound. **Bold** is the chosen k: the first at or below the 2^-40 line.',
  '',
);
out.push(`| k | ${GROUP_SIZES.map((n) => `N=${n}`).join(' | ')} |`, `|---|${GROUP_SIZES.map(() => '---|').join('')}`);
for (let k = 4; k <= maxK; k += 2) {
  const cells = GROUP_SIZES.map((n) => {
    if (k >= n - 1) return '';
    const t = strongestThreshold(n, k, DESIGN);
    if (t === undefined) return 'abort';
    const l = bits(evaluate(n, k, t, DESIGN).privacy);
    return chosen.get(n) === k ? `**${l}**` : l;
  });
  out.push(`| ${k} | ${cells.join(' | ')} |`);
}
out.push(
  `| complete | ${GROUP_SIZES.map((n) => {
    if (n - 1 > maxK) return '';
    const t = strongestThreshold(n, n - 1, DESIGN);
    if (t === undefined) return 'abort';
    const l = bits(evaluate(n, n - 1, t, DESIGN).privacy);
    return chosen.get(n) === n - 1 ? `**${l}**` : l;
  }).join(' | ')} |`,
);

// 4. Sensitivity to the corruption and dropout rates.
out.push('', '## 4. Chosen k/t for other rates', '', 'Same bounds; "none" means even the complete graph aborts too often.', '');
out.push(`| corrupt | dropout | ${GROUP_SIZES.map((n) => `N=${n}`).join(' | ')} |`, `|---|---|${GROUP_SIZES.map(() => '---|').join('')}`);
for (const corrupt of SWEEP_CORRUPT) {
  for (const dropout of SWEEP_DROPOUT) {
    const cells = GROUP_SIZES.map((n) => {
      const c = choose(n, { ...DESIGN, corrupt, dropout });
      return c ? `${c.k}/${c.t}` : 'none';
    });
    out.push(`| ${rate(corrupt)} | ${dropout} | ${cells.join(' | ')} |`);
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const gate =
  mcFailures === 0 && missing.length === 0
    ? 'PASS'
    : `${mcFailures === 0 ? 'model checks pass' : `${mcFailures} Monte Carlo rows disagree`}; ` +
      `${missing.length === 0 ? 'k found for every group size' : `no k for ${missing.join(', ')}`}`;
out.push('', `Gate: ${gate}. Run time ${seconds} s.`, '');
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/e7.md', import.meta.url), out.join('\n'));
console.log(`[e7] gate: ${gate} (${seconds} s)`);
