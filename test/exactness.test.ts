// Exactness gate (Phase 1, re-run on each protocol change since): over 10,000 random readings (signed) and dropout
// patterns, every published total equals the true total of the meters in F bit for bit, and every pattern that cannot
// be recovered is suppressed or aborted instead of published. VEIL_EXACTNESS_TARGET runs a shorter pass.
import { expect, it } from 'vitest';
import type { GroupParams, MeterId, RoundResult } from '../src/protocol.ts';
import { distinctIds, Rng, runRound, setupGroup, startEpoch, type Pattern } from './support.ts';

const SEED = 0x7e11;
const TARGET = Number(process.env.VEIL_EXACTNESS_TARGET ?? 10_000);
const ROUNDS_PER_EPOCH = 12; // two epochs per group, so key rollover is exercised too

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

/**
 * 90% of rounds lose 1..30% of meters before the deadline; 30% also lose 1..15% of reporters before confirming,
 * 30% lose 1..15% of the rest before checking, and 30% lose 1..15% of the rest before releasing.
 */
function dropoutPattern(rng: Rng, ids: readonly MeterId[]): Pattern {
  const order = rng.shuffle(ids);
  const late = (n: number) => (rng.chance(0.3) ? rng.int(1, Math.max(1, Math.floor(n * 0.15))) : 0);
  const reporting = order.slice(rng.chance(0.1) ? 0 : rng.int(1, Math.max(1, Math.floor(ids.length * 0.3))));
  const confirming = reporting.slice(late(reporting.length));
  const checking = confirming.slice(late(confirming.length));
  const releasing = checking.slice(late(checking.length));
  return { reporting: new Set(reporting), confirming: new Set(confirming), checking: new Set(checking), releasing: new Set(releasing) };
}

/** Independent oracle: what the round must return, and over which meters. */
function expected(p: GroupParams, pattern: Pattern, readings: ReadonlyMap<MeterId, bigint>): { status: RoundResult['status']; total?: bigint; final?: Set<MeterId> } {
  const { graph, threshold: t, minGroupSize } = p;
  const active = pattern.reporting;
  if (active.size < minGroupSize) return { status: 'suppressed' };
  const checking = pattern.checking ?? pattern.confirming;
  const nbrs = (i: MeterId) => graph.get(i)!;
  // A meter deals if it confirms with t active neighbours. F keeps the dealers with t neighbours in F, so every member
  // can hear agreement from t of them.
  const final = new Set([...active].filter((i) => pattern.confirming.has(i) && nbrs(i).filter((j) => active.has(j)).length >= t));
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of [...final]) if (nbrs(i).filter((j) => final.has(j)).length < t) changed = final.delete(i);
  }
  if (final.size < minGroupSize) return { status: 'suppressed' };
  const checked = (i: MeterId) => pattern.confirming.has(i) && checking.has(i);
  // A member of F reveals its own secret and removal if t of its F neighbours checked, so their agreement reaches it.
  const released = (i: MeterId) => final.has(i) && checked(i) && pattern.releasing.has(i) && nbrs(i).filter((j) => final.has(j) && checked(j)).length >= t;
  const needsRemoval = (i: MeterId) => nbrs(i).some((j) => active.has(j) && !final.has(j));
  for (const i of final) if (needsRemoval(i) && !released(i) && !checked(i)) return { status: 'aborted' }; // nothing escrowed
  // Asked for shares, a meter answers if it checked and is still up, unless it is in F and its own release failed.
  const holder = (j: MeterId) => checked(j) && pattern.releasing.has(j) && (!final.has(j) || released(j));
  for (const i of final) {
    if (released(i)) continue;
    if (nbrs(i).filter((j) => active.has(j) && holder(j)).length < t) return { status: 'aborted' }; // self-mask shares
    if (needsRemoval(i) && nbrs(i).filter((j) => final.has(j) && released(j)).length < t) return { status: 'aborted' }; // escrow-key shares
  }
  let total = 0n;
  for (const i of final) total += readings.get(i)!;
  return { status: 'published', total, final };
}

it(`publishes exact totals over ${TARGET.toLocaleString('en-US')} random readings and dropout patterns`, () => {
  const rng = new Rng(SEED);
  const n = { groups: 0, epochs: 0, rounds: 0, published: 0, suppressed: 0, aborted: 0 };
  const exact = { withDropouts: 0, leftOutAfterReporting: 0, silentAfterConfirming: 0, unmasked: 0, escrowOpened: 0, noDropouts: 0, negativeTotals: 0, negativeReadings: 0, readings: 0 };
  const failures: string[] = [];
  const meterAborts = new Map<string, number>();
  const started = performance.now();

  while (n.published < TARGET && failures.length < 50) {
    const size = rng.int(3, 40);
    const ids = distinctIds(rng, size);
    const k = rng.chance(0.2) || size <= 4 ? size - 1 : 2 * rng.int(1, Math.min(6, Math.floor((size - 2) / 2)));
    const t = rng.int(Math.floor(k / 2) + 1, k);
    const firstEpoch = rng.int(0, 0xfffffffe);
    const group = setupGroup(ids, firstEpoch, k, t);
    const bound = ((1n << 63n) - 1n) / BigInt(size); // keeps every true total inside int64
    n.groups++;

    for (let epoch = 0; epoch < 2 && n.published < TARGET; epoch++) {
      if (epoch > 0) startEpoch(group, firstEpoch + epoch, k, t);
      n.epochs++;
      const firstRound = rng.int(0, 0xffffffff - ROUNDS_PER_EPOCH);
      for (let r = 0; r < ROUNDS_PER_EPOCH && n.published < TARGET; r++) {
        const round = firstRound + r;
        const readings = new Map(ids.map((id) => [id, reading(rng, bound)]));
        const pattern = dropoutPattern(rng, ids);
        const { result, aborts, releases, unmasks } = runRound(group, round, readings, pattern);
        const want = expected(group.params, pattern, readings);
        n.rounds++;
        n[result.status]++;
        for (const a of aborts) meterAborts.set(a, (meterAborts.get(a) ?? 0) + 1);

        const total = result.status === 'published' ? result.total : undefined;
        const final = result.status === 'published' ? result.evidence.final : undefined;
        const sameFinal = want.final === undefined || (final?.length === want.final.size && final.every((i) => want.final!.has(i)));
        if (result.status !== want.status || total !== want.total || !sameFinal) {
          failures.push(`group ${n.groups} round ${round}: got ${result.status} ${total ?? ''}, want ${want.status} ${want.total ?? ''}`);
          continue;
        }
        if (result.status !== 'published') continue;
        if (pattern.reporting.size < size) exact.withDropouts++;
        else exact.noDropouts++;
        if (result.evidence.final.length < pattern.reporting.size) exact.leftOutAfterReporting++;
        if (pattern.releasing.size < pattern.confirming.size) exact.silentAfterConfirming++;
        if (unmasks.length > 0) exact.unmasked++;
        if (result.evidence.removals.some((r) => !releases.some((x) => x.id === r.id))) exact.escrowOpened++;
        if (result.total < 0n) exact.negativeTotals++;
        for (const id of result.evidence.final) {
          exact.readings++;
          if (readings.get(id)! < 0n) exact.negativeReadings++;
        }
      }
    }
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`[exactness] seed=0x${SEED.toString(16)} ${JSON.stringify({ ...n, mismatches: failures.length, seconds })}`);
  console.log(`[exactness] exact totals: ${JSON.stringify(exact)}`);
  console.log(`[exactness] meter-side refusals: ${JSON.stringify(Object.fromEntries(meterAborts))}`);
  expect(failures.slice(0, 5)).toEqual([]);
  // Honest meters refuse only when crashes leave too few neighbours agreeing, never over conflicting views.
  expect([...meterAborts.keys()].filter((a) => !/^only \d+ neighbours agree on the final set|^not waiting to unmask/.test(a))).toEqual([]);
  expect(n.published).toBe(TARGET);
}, 60 * 60_000);
