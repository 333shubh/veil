// Phase 1 gate: over 10,000 random readings (signed) and dropout patterns, every published total equals
// the true total of the active meters bit for bit, and every pattern that cannot be recovered is
// suppressed or aborted instead of published.
import { expect, it } from 'vitest';
import type { GroupParams, MeterId, RoundResult } from '../src/protocol.ts';
import { distinctIds, randomGraph, Rng, runRound, setupGroup } from './support.ts';

const SEED = 0x7e11;
const TARGET = 10_000;
const ROUNDS_PER_EPOCH = 25;

function reading(rng: Rng, bound: bigint): bigint {
  switch (rng.int(0, 3)) {
    case 0:
      return BigInt(rng.int(-5_000, 20_000)); // interval energy in Wh; negative is solar export
    case 1:
      return rng.big(-bound, bound); // full signed range the group total allows
    case 2:
      return rng.pick([-bound, bound, 0n, -1n, 1n]);
    default:
      return BigInt(-rng.int(1, 5_000)); // export only
  }
}

/** 90% of rounds lose 1..30% of meters before the deadline; 30% also lose 1..15% of reporters before release. */
function dropoutPattern(rng: Rng, ids: readonly MeterId[]) {
  const order = rng.shuffle(ids);
  const dropped = rng.chance(0.1) ? 0 : rng.int(1, Math.max(1, Math.floor(ids.length * 0.3)));
  const reporting = order.slice(dropped);
  const crashed = rng.chance(0.3) ? rng.int(1, Math.max(1, Math.floor(reporting.length * 0.15))) : 0;
  return { reporting: new Set(reporting), responding: new Set(reporting.slice(crashed)) };
}

/** Independent oracle: what the round must return for this dropout pattern. */
function expected(
  p: GroupParams,
  reporting: ReadonlySet<MeterId>,
  responding: ReadonlySet<MeterId>,
  readings: ReadonlyMap<MeterId, bigint>,
): { status: RoundResult['status']; total?: bigint } {
  if (reporting.size < p.minGroupSize) return { status: 'suppressed' };
  for (const [i, ns] of p.graph) {
    // Survivors need their self-mask seed rebuilt; dropped meters next to a survivor need their mask key rebuilt.
    const needed = reporting.has(i) || ns.some((j) => reporting.has(j));
    if (needed && ns.filter((j) => responding.has(j)).length < p.threshold) return { status: 'aborted' };
  }
  let total = 0n;
  for (const i of reporting) total += readings.get(i)!;
  return { status: 'published', total };
}

it(`publishes exact totals over ${TARGET.toLocaleString('en-US')} random readings and dropout patterns`, () => {
  const rng = new Rng(SEED);
  const n = { epochs: 0, rounds: 0, published: 0, suppressed: 0, aborted: 0 };
  const exact = { withDropouts: 0, withCrashAfterReport: 0, noDropouts: 0, negativeTotals: 0, negativeReadings: 0, readings: 0 };
  const failures: string[] = [];
  const started = performance.now();

  while (n.published < TARGET && failures.length < 50) {
    const size = rng.int(3, 40);
    const ids = distinctIds(rng, size);
    const k = rng.int(2, Math.min(size - 1, 12));
    const graph = randomGraph(rng, ids, k);
    const minDegree = Math.min(...[...graph.values()].map((ns) => ns.length));
    const params: GroupParams = { epoch: rng.u32(), threshold: rng.int(Math.floor(k / 2) + 1, minDegree), minGroupSize: 3, graph };
    const group = setupGroup(params);
    const bound = ((1n << 63n) - 1n) / BigInt(size); // keeps every true total inside int64
    n.epochs++;

    const firstRound = rng.u32();
    for (let r = 0; r < ROUNDS_PER_EPOCH && n.published < TARGET; r++) {
      const round = firstRound + r;
      const readings = new Map(ids.map((id) => [id, reading(rng, bound)]));
      const { reporting, responding } = dropoutPattern(rng, ids);

      const { result, releases } = runRound(group, round, readings, reporting, responding);
      const want = expected(params, reporting, responding, readings);
      n.rounds++;
      n[result.status]++;

      const wrongKind = releases.some(
        (rel) => [...rel.selfMask.keys()].some((i) => !reporting.has(i)) || [...rel.maskKey.keys()].some((d) => reporting.has(d)),
      );
      const total = result.status === 'published' ? result.total : undefined;
      if (result.status !== want.status || total !== want.total || wrongKind) {
        failures.push(`epoch ${n.epochs} round ${round}: got ${result.status} ${total ?? ''}, want ${want.status} ${want.total ?? ''}`);
        continue;
      }
      if (result.status !== 'published') continue;
      if (reporting.size < size) exact.withDropouts++;
      else exact.noDropouts++;
      if (responding.size < reporting.size) exact.withCrashAfterReport++;
      if (result.total < 0n) exact.negativeTotals++;
      for (const id of reporting) {
        exact.readings++;
        if (readings.get(id)! < 0n) exact.negativeReadings++;
      }
    }
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`[phase1-gate] seed=0x${SEED.toString(16)} ${JSON.stringify({ ...n, mismatches: failures.length, seconds })}`);
  console.log(`[phase1-gate] exact totals: ${JSON.stringify(exact)}`);
  expect(failures.slice(0, 5)).toEqual([]);
  expect(n.published).toBe(TARGET);
}, 30 * 60_000);
