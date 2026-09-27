// The ledger replicated across three validators with a quorum of two.
import { describe, expect, it } from 'vitest';
import { Consortium } from '../src/consortium.ts';
import { ed25519Keygen } from '../src/crypto.ts';
import { recordFor } from '../src/ledger.ts';
import type { MeterId, RoundEvidence } from '../src/protocol.ts';
import { distinctIds, everyone, Rng, runRound, setupGroup } from './support.ts';

const VALIDATORS = ['utility', 'regulator', 'consumer body'];

function fixture(seed: number, rangeBits?: number) {
  const rng = new Rng(seed);
  const ids = distinctIds(rng, 10);
  const g = setupGroup(ids, 1, 6, 4, 3, { rangeBits });
  const consortium = new Consortium(
    g.operator.publicKey,
    g.registry,
    VALIDATORS.map((name) => ({ name, key: ed25519Keygen() })),
  );
  expect(consortium.anchor(g.anchor).committed).toBe(true);
  const publish = (round: number) => {
    const readings = new Map<MeterId, bigint>(ids.map((id) => [id, BigInt(rng.int(-5_000, 20_000))]));
    const r = runRound(g, round, readings, everyone(ids)).result as { status: 'published'; total: bigint; evidence: RoundEvidence };
    expect(r.status).toBe('published');
    return r;
  };
  return { g, consortium, publish };
}

const byName = (c: Consortium, name: string) => c.validators.find((v) => v.name === name)!;

describe('replicated ledger', () => {
  it('commits a record every validator endorses, and all copies stay identical', () => {
    const { g, consortium, publish } = fixture(71);
    const { total, evidence } = publish(1);
    const out = consortium.record(recordFor(g.operator, evidence, total));
    expect(out).toMatchObject({ committed: true, refusals: [] });
    expect(out.endorsements).toHaveLength(3);
    expect(consortium.validators.every((v) => v.ledger.totalOf(1, 1) === total)).toBe(true);
    expect(consortium.consistent()).toBe(true);
  });

  it('commits what a quorum endorses when the operator shows one validator a different total, and keeps the proof', () => {
    const { g, consortium, publish } = fixture(72);
    const { total, evidence } = publish(1);
    const honest = recordFor(g.operator, evidence, total);
    const forged = recordFor(g.operator, evidence, total + 5n);
    const out = consortium.record(honest, undefined, (v) => (v.name === 'consumer body' ? forged : honest));
    expect(out.committed).toBe(true);
    expect(out.equivocation?.map((r) => r.total)).toEqual([total, total + 5n]); // both signed by the operator
    expect(byName(consortium, 'consumer body').ledger.totalOf(1, 1)).toBe(total); // it caught up with the quorum
    expect(consortium.consistent()).toBe(true);
  });

  it('commits nothing when no quorum sees the same record', () => {
    const { g, consortium, publish } = fixture(73);
    const { total, evidence } = publish(1);
    const variants = new Map(VALIDATORS.map((name, i) => [name, recordFor(g.operator, evidence, total + BigInt(i))]));
    const out = consortium.record(variants.get('utility')!, undefined, (v) => variants.get(v.name)!);
    expect(out.committed).toBe(false);
    expect(out.equivocation).toBeDefined();
    expect(consortium.validators.every((v) => v.ledger.totalOf(1, 1) === undefined)).toBe(true);
  });

  it('lets no single validator commit, even one that endorses a record the others refuse', () => {
    const { g, consortium, publish } = fixture(74);
    const { total, evidence } = publish(1);
    const unsigned = { ...recordFor(g.operator, evidence, total), signature: new Uint8Array(64) };
    const out = consortium.record(unsigned);
    expect(out.committed).toBe(false);
    expect(out.refusals.map((r) => r.reason)).toEqual(Array(3).fill('record is not signed by the operator'));
  });

  it('in verified mode, every validator refuses a total that is not the sum of the commitments', () => {
    const { g, consortium, publish } = fixture(75, 16);
    const { total, evidence } = publish(1);
    const out = consortium.record(recordFor(g.operator, evidence, total + 1n));
    expect(out.committed).toBe(false);
    expect(new Set(out.refusals.map((r) => r.reason))).toEqual(new Set(['total differs from the sum of the co-signed commitments']));
    expect(consortium.record(recordFor(g.operator, evidence, total)).committed).toBe(true);
  });
});

