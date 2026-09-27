// Exact failure probabilities for a random-Harary group, used to choose k and t (experiment E7).
// Adversary: floor(corrupt * N) meters, corrupted before the epoch's graph seed is published.
// Dropout: each meter misses a round (no report, or no shares) independently with probability `dropout`.

export interface Design {
  corrupt: number; // fraction of meters colluding with the operator
  dropout: number; // chance that a meter misses a round
  privacyLog2: number; // bound per group per epoch on a privacy failure (below)
  recoveryLog2: number; // bound per group per round on a meter being left out of the total
  roundsPerEpoch: number;
}

/**
 * Spec bound of 2^-40 on privacy; one-day epochs of 5-second rounds. Dropout 10% is set for Indian households: in CEEW's
 * smart-meter data from Mathura and Bareilly, a daily epoch's meters miss a round 8.9% and 6.9% of the time on average
 * (experiments/india-dropout.ts). Power cuts make it bursty; E4 covers the heavier rounds.
 */
export const DESIGN: Design = { corrupt: 0.2, dropout: 0.1, privacyLog2: -40, recoveryLog2: -20, roundsPerEpoch: 17_280 };

/** log2 of union bounds over the group. */
export interface Failure {
  privacy: number; // some honest meter has >= t corrupt neighbours, or partition (below), in one epoch
  partition: number; // in some round, the honest reporters split into parts the operator could total separately
  recovery: number; // in one round, some needed meter has fewer than t live neighbours, so it is left out
}

export interface Choice extends Failure {
  n: number;
  k: number;
  t: number;
  tRange: [number, number]; // every t in here meets both bounds; the largest is chosen, favouring privacy
}

/** Per-meter probabilities behind the union bounds, as plain numbers (for checking against simulation). */
export interface PerMeter {
  breach: number; // an honest meter has >= t corrupt neighbours
  stranded: number; // a meter has fewer than t live neighbours
  runsBad: number; // k given meters are all corrupt or silent
}

type Q = [bigint, bigint]; // exact rational: numerator, denominator

const mul = (x: Q, y: Q): Q => [x[0] * y[0], x[1] * y[1]];
const add = (x: Q, y: Q): Q => [x[0] * y[1] + y[0] * x[1], x[1] * y[1]];

function lg(v: bigint): number {
  const shift = Math.max(0, v.toString(2).length - 60);
  return Math.log2(Number(v >> BigInt(shift))) + shift;
}
const log2 = ([p, q]: Q): number => (p === 0n ? -Infinity : lg(p) - lg(q));

function ratio(x: number): Q {
  if (!(x >= 0 && x <= 1)) throw new RangeError(`probability ${x} outside [0, 1]`);
  return [BigInt(Math.round(x * 1e9)), 1_000_000_000n];
}

const combs = new Map<string, bigint>();
function comb(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  const r = Math.min(k, n - k);
  const key = `${n}:${r}`;
  let v = combs.get(key);
  if (v === undefined) {
    v = 1n;
    for (let i = 1; i <= r; i++) v = (v * BigInt(n - r + i)) / BigInt(i);
    combs.set(key, v);
  }
  return v;
}

interface Model {
  n: number;
  k: number;
  c: number;
  breach: (t: number) => Q;
  stranded: (t: number) => Q;
  runsBad: Q;
}

function model(n: number, k: number, d: Design): Model {
  const c = Math.floor(d.corrupt * n + 1e-9);
  const [a, b] = ratio(d.dropout);
  const bk = b ** BigInt(k);
  // An honest meter's neighbours are a uniform k-subset of the other n - 1 meters, c of them corrupt.
  const breachTail = Array<bigint>(k + 2).fill(0n);
  for (let j = k; j >= 0; j--) breachTail[j] = breachTail[j + 1]! + comb(c, j) * comb(n - 1 - c, k - j);
  // Live neighbours: Binomial(k, 1 - dropout), kept as numerators over b^k.
  const strandedHead = Array<bigint>(k + 2).fill(0n);
  for (let j = 0; j <= k; j++) strandedHead[j + 1] = strandedHead[j]! + comb(k, j) * (b - a) ** BigInt(j) * a ** BigInt(k - j);
  // k given ring positions all corrupt or silent.
  let allBad = 0n;
  for (let j = 0; j <= k; j++) allBad += comb(c, j) * comb(n - c, k - j) * a ** BigInt(k - j) * b ** BigInt(j);
  return {
    n,
    k,
    c,
    breach: (t) => [breachTail[t]!, comb(n - 1, k)],
    stranded: (t) => [strandedHead[t]!, bk],
    runsBad: [allBad, comb(n, k) * bk],
  };
}

function bounds(m: Model, t: number, d: Design): Failure {
  // Harary ring: the honest reporters split only if two disjoint runs of k/2 positions hold none of them.
  const partition: Q = m.k >= m.n - 1 ? [0n, 1n] : mul([BigInt(d.roundsPerEpoch) * comb(m.n, 2), 1n], m.runsBad);
  return {
    privacy: log2(add(mul([BigInt(m.n - m.c), 1n], m.breach(t)), partition)),
    partition: log2(partition),
    recovery: log2(mul([BigInt(m.n), 1n], m.stranded(t))),
  };
}

/** Largest neighbourhood considered; the exact model's cost grows with k^2 and setup cost grows with k. */
export const MAX_K = 1000;

/** Candidate neighbourhood sizes: even k up to N - 2 (random Harary), then N - 1 (complete), all at most MAX_K. */
export function neighbourhoodSizes(n: number): number[] {
  const ks: number[] = [];
  for (let k = 2; k < Math.min(n - 1, MAX_K + 1); k += 2) ks.push(k);
  return n - 1 <= MAX_K ? [...ks, n - 1] : ks;
}

export function evaluate(n: number, k: number, t: number, d: Design): Failure {
  return bounds(model(n, k, d), t, d);
}

export function perMeter(n: number, k: number, t: number, d: Design): PerMeter {
  const m = model(n, k, d);
  return { breach: 2 ** log2(m.breach(t)), stranded: 2 ** log2(m.stranded(t)), runsBad: 2 ** log2(m.runsBad) };
}

/** Largest t > k/2 whose recovery meets the bound, or undefined if none does. */
export function strongestThreshold(n: number, k: number, d: Design): number | undefined {
  const m = model(n, k, d);
  for (let t = k; t > k / 2; t--) if (bounds(m, t, d).recovery <= d.recoveryLog2) return t;
  return undefined;
}

/** Smallest k (up to MAX_K) meeting both bounds with some t > k/2, or undefined if none does. */
export function choose(n: number, d: Design): Choice | undefined {
  for (const k of neighbourhoodSizes(n)) {
    const m = model(n, k, d);
    const ok: number[] = [];
    for (let t = Math.floor(k / 2) + 1; t <= k; t++) {
      const f = bounds(m, t, d);
      if (f.privacy <= d.privacyLog2 && f.recovery <= d.recoveryLog2) ok.push(t);
    }
    if (ok.length > 0) {
      const t = ok[ok.length - 1]!;
      return { n, k, t, tRange: [ok[0]!, t], ...bounds(m, t, d) };
    }
  }
  return undefined;
}
