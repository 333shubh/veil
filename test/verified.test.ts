// Verified mode and the plausibility checks: what each catches when a meter lies about its reading.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeLiar } from '../src/adversary.ts';
import { audit, Ledger, recordFor } from '../src/ledger.ts';
import { commit, prove, proofBytes, verify } from '../src/pedersen.ts';
import { implausible } from '../src/plausibility.ts';
import type { MeterId, RoundEvidence } from '../src/protocol.ts';
import { distinctIds, everyone, Rng, runRound, setupGroup } from './support.ts';

const BITS = 16;
const ctx = (s: string) => Buffer.from(s);

describe('range proofs', () => {
  it('accept every reading at the edges of the range and reject tampering', () => {
    for (const x of [-32768n, -1n, 0n, 1n, 32767n]) {
      const r = BigInt('0x' + randomBytes(32).toString('hex'));
      const proof = prove(x, r, BITS, ctx('a'));
      expect(proof.length).toBe(proofBytes(BITS));
      expect(verify(commit(x, r), proof, BITS, ctx('a'))).toBe(true);
      expect(verify(commit(x, r), proof, BITS, ctx('b'))).toBe(false); // bound to its meter and round
      expect(verify(commit(x + 1n, r), proof, BITS, ctx('a'))).toBe(false);
      const bent = Uint8Array.from(proof);
      bent[bent.length - 1]! ^= 1;
      expect(verify(commit(x, r), bent, BITS, ctx('a'))).toBe(false);
    }
  });

  it('cannot be made for a reading outside the range', () => {
    expect(() => prove(32768n, 1n, BITS, ctx('a'))).toThrow(RangeError);
    expect(() => prove(-32769n, 1n, BITS, ctx('a'))).toThrow(RangeError);
  });
});

function fixture(seed: number, options: { proofSample?: number } = {}) {
  const rng = new Rng(seed);
  const ids = distinctIds(rng, 10);
  const group = setupGroup(ids, 3, 6, 4, 3, { rangeBits: BITS, ...options });
  const readings = new Map<MeterId, bigint>(ids.map((id) => [id, BigInt(rng.int(-5_000, 20_000))]));
  const sum = (set: Iterable<MeterId>) => [...set].reduce((acc, id) => acc + readings.get(id)!, 0n);
  return { ids, group, readings, sum };
}

const published = (r: { status: string }) => r as { status: 'published'; total: bigint; evidence: RoundEvidence };

describe('verified mode', () => {
  it('publishes exact totals whose commitments sum to them, and the ledger checks the arithmetic', () => {
    const { ids, group, readings, sum } = fixture(61);
    const trace = runRound(group, 1, readings, everyone(ids));
    expect(trace.result).toMatchObject({ status: 'published', total: sum(ids) });
    const { total, evidence } = published(trace.result);
    expect(evidence.blinding).toBeDefined();
    const record = recordFor(group.operator, evidence, total);
    expect(audit(record, evidence, group.params.graph, group.registry)).toEqual({ total, problems: [] });
    group.ledger.record(record);
    // A false total fails at the validators, not only at an auditor: it is not the sum of the co-signed commitments.
    const trace2 = runRound(group, 2, readings, everyone(ids));
    const r2 = published(trace2.result);
    expect(() => group.ledger.record(recordFor(group.operator, r2.evidence, r2.total + 5n))).toThrow(/sum of the co-signed commitments/);
  });

  it('stays exact through dropouts, an unmask and an escrowed removal', () => {
    const { ids, group, readings, sum } = fixture(62);
    const gone = ids[0]!;
    const neighbour = group.params.graph.get(gone)![0]!;
    const rest = new Set(ids.filter((id) => id !== gone));
    const releasing = new Set([...rest].filter((id) => id !== neighbour));
    const trace = runRound(group, 1, readings, { reporting: new Set(ids), confirming: rest, releasing });
    expect(trace.result).toMatchObject({ status: 'published', total: sum(rest) });
    expect(trace.requests).toBeDefined();
    const { total, evidence } = published(trace.result);
    expect(audit(recordFor(group.operator, evidence, total), evidence, group.params.graph, group.registry).problems).toEqual([]);
  });

  it('refuses a round in which a meter changed its masked value but not its commitment', () => {
    const { ids, group, readings } = fixture(63);
    makeLiar(group, ids[2]!, { masked: 50_000n });
    expect(runRound(group, 1, readings, everyone(ids)).result).toEqual({ status: 'aborted', reason: 'the total differs from the sum of the committed readings' });
  });

  it('leaves out a meter that claims an out-of-range reading, when its proof is checked', () => {
    const { ids, group, readings, sum } = fixture(64);
    const liar = ids[2]!;
    makeLiar(group, liar, { claimed: 50_000n });
    const trace = runRound(group, 1, readings, everyone(ids));
    expect(trace.result).toMatchObject({ status: 'published', total: sum(ids.filter((id) => id !== liar)) });
  });

  it('with no proofs sampled, publishes the lie, which validators checking proofs then refuse', () => {
    const { ids, group, readings, sum } = fixture(65, { proofSample: 0 });
    const liar = ids[2]!;
    makeLiar(group, liar, { claimed: 50_000n });
    const trace = runRound(group, 1, readings, everyone(ids));
    expect(trace.result).toMatchObject({ status: 'published', total: sum(ids) + 50_000n });
    const { total, evidence } = published(trace.result);
    const proofs = new Map(trace.reports.map((r) => [r.id, r.proof!]));
    const record = recordFor(group.operator, evidence, total);
    const strict = new Ledger(group.operator.publicKey, group.registry, { checkProofs: true });
    strict.anchor(group.anchor);
    expect(() => strict.record(record, proofs)).toThrow(`no valid range proof for the commitment of meter ${liar}`);
    group.ledger.record(record, proofs); // the default ledger checks arithmetic only, which the lie satisfies
  });

  it('cannot catch a lie that stays in range', () => {
    const { ids, group, readings, sum } = fixture(66);
    // The meter proves its false reading honestly: a valid proof exists for it, as for any in-range reading.
    const liar = group.meters.get(ids[2]!)!;
    const honest = liar.report.bind(liar);
    liar.report = (round, reading) => honest(round, reading + 1_000n);
    expect(runRound(group, 1, readings, everyone(ids)).result).toMatchObject({ status: 'published', total: sum(ids) + 1_000n });
  });
});

describe('plausibility checks', () => {
  const bounds = { minPerHome: -200, maxPerHome: 3_000, maxStepPerHome: 100 };
  it('flag totals whose mean per home is out of bounds or jumps', () => {
    expect(implausible({ total: 200_000n, homes: 200 }, bounds)).toEqual([]);
    expect(implausible({ total: 700_000n, homes: 200 }, bounds)).toEqual(['mean 3500 W per home is above 3000 W']);
    expect(implausible({ total: -50_000n, homes: 200 }, bounds)).toEqual(['mean -250 W per home is below -200 W']);
    expect(implausible({ total: 240_000n, homes: 200 }, bounds, { total: 200_000n, homes: 200 })).toEqual(['mean moved 200 W per home in one round, more than 100 W']);
  });
});
