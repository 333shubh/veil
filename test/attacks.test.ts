// Phase 3 gate: replayed attacks. The test plays a malicious coordinator that controls every message and holds the
// full state of the meters it corrupts; honest meters run the real protocol code.
import { describe, expect, it } from 'vitest';
import { prg } from '../src/crypto.ts';
import { audit, recordFor } from '../src/ledger.ts';
import { isAborted, type Confirm, type MeterId, type RoundEvidence } from '../src/protocol.ts';
import { add, decode, sub, type U64 } from '../src/ring.ts';
import { combine, type Share } from '../src/shamir.ts';
import { distinctIds, everyone, Rng, runRound, setupGroup, type Group } from './support.ts';

interface Internals {
  epoch: { pairs: Map<MeterId, { mask: Uint8Array }> };
}

/** A corrupted meter's round mask with a neighbour, read straight from its state. */
const stolenMask = (g: Group, owner: MeterId, peer: MeterId, round: number) =>
  prg((g.meters.get(owner) as unknown as Internals).epoch.pairs.get(peer)!.mask, g.params.epoch, round);

const signedMask = (acc: U64, self: MeterId, peer: MeterId, mask: U64) => (self < peer ? add(acc, mask) : sub(acc, mask));

function readingsFor(rng: Rng, ids: MeterId[]) {
  return new Map<MeterId, bigint>(ids.map((id) => [id, BigInt(rng.int(-5_000, 20_000))]));
}

/**
 * Survivor-set attack on `victim` in one round: the `dropped` honest neighbours are told the victim missed the
 * deadline, everyone else is told it reported. The coordinator collects every correction, share and corrupted state,
 * then tries to unmask the victim's report.
 */
function survivorSet(g: Group, victim: MeterId, corrupt: ReadonlySet<MeterId>, dropped: ReadonlySet<MeterId>, round: number, forwardAll: boolean, rng: Rng) {
  const readings = readingsFor(rng, g.ids);
  const withVictim = new Set(g.ids);
  const withoutVictim = new Set(g.ids.filter((id) => id !== victim));
  const viewOf = (id: MeterId) => (dropped.has(id) ? withoutVictim : withVictim);
  const y = new Map(g.ids.map((id) => [id, g.meters.get(id)!.report(round, readings.get(id)!).y]));

  const confirms = new Map<MeterId, Confirm>();
  for (const id of g.ids) {
    const c = g.meters.get(id)!.confirm(round, viewOf(id));
    if (!isAborted(c)) confirms.set(id, c);
  }
  const shares: Share[] = [];
  let detected = 0;
  for (const id of g.ids) {
    const view = viewOf(id);
    const inbox = [...confirms.values()].filter(
      (c) => g.params.graph.get(id)!.includes(c.id) && view.has(c.id) && (forwardAll || viewOf(c.id) === view),
    );
    const r = g.meters.get(id)!.release(round, view, inbox);
    if (isAborted(r)) {
      if (!corrupt.has(id) && r.aborted.startsWith('active set differs')) detected++;
      continue;
    }
    const s = r.shares.get(victim);
    if (s !== undefined) shares.push({ x: BigInt(id), y: s });
  }

  // The coordinator's best reconstruction of the victim's reading.
  let masks: U64 = 0n;
  let missing = 0;
  for (const j of g.params.graph.get(victim)!) {
    if (corrupt.has(j)) masks = signedMask(masks, victim, j, stolenMask(g, j, victim, round));
    else if (dropped.has(j)) masks = sub(masks, confirms.get(j)!.correction); // its correction is -s_vj m_vj
    else missing++;
  }
  const t = g.params.threshold;
  if (shares.length < t || missing > 0) return { unmasked: false, detected, shares: shares.length, missing };
  const selfMask = Buffer.from(combine(shares, t)).readBigUInt64LE(0);
  return { unmasked: decode(sub(sub(y.get(victim)!, selfMask), masks)) === readings.get(victim), detected, shares: shares.length, missing };
}

function splits<T>(items: readonly T[]): Set<T>[] {
  return Array.from({ length: 2 ** items.length }, (_, mask) => new Set(items.filter((_, i) => mask & (1 << i))));
}

describe('survivor-set attack', () => {
  const rng = new Rng(31);
  const ids = distinctIds(rng, 16);
  const g = setupGroup(ids, 3, 6, 4); // k = 6, t = 4
  const victim = ids[0]!;
  const neighbours = g.params.graph.get(victim)!;
  let round = 100;

  it('fails for every split of the victim\'s neighbours when fewer than t are corrupted', () => {
    const corrupt = new Set(neighbours.slice(0, 2));
    const honest = neighbours.filter((j) => !corrupt.has(j));
    const outcomes = splits(honest).map((dropped) => survivorSet(g, victim, corrupt, dropped, round++, false, rng));
    console.log(`[attack] survivor-set, 2 of 6 neighbours corrupted, t = 4: ${outcomes.filter((o) => o.unmasked).length}/${outcomes.length} splits unmask the victim`);
    expect(outcomes.filter((o) => o.unmasked)).toEqual([]);
  });

  it('succeeds once t neighbours are corrupted (control: the attack is real)', () => {
    const corrupt = new Set(neighbours.slice(0, 4));
    const honest = neighbours.filter((j) => !corrupt.has(j));
    const outcomes = splits(honest).map((dropped) => survivorSet(g, victim, corrupt, dropped, round++, false, rng));
    console.log(`[attack] survivor-set, 4 of 6 neighbours corrupted, t = 4: ${outcomes.filter((o) => o.unmasked).length}/${outcomes.length} splits unmask the victim`);
    expect(outcomes.some((o) => o.unmasked)).toBe(true);
  });

  it('is detected by honest meters when the coordinator relays the conflicting confirmations', () => {
    const corrupt = new Set(neighbours.slice(0, 2));
    const honest = neighbours.filter((j) => !corrupt.has(j));
    const o = survivorSet(g, victim, corrupt, new Set(honest.slice(0, 2)), round++, true, rng);
    console.log(`[attack] survivor-set with conflicting confirmations relayed: ${o.detected} honest meters detect it, victim unmasked: ${o.unmasked}`);
    expect(o.detected).toBeGreaterThan(0);
    expect(o.unmasked).toBe(false);
  });
});

describe('mask reuse', () => {
  it('released round values never unmask another round', () => {
    const rng = new Rng(32);
    const ids = distinctIds(rng, 12);
    const g = setupGroup(ids, 4, 6, 4);
    const victim = ids[0]!;
    const neighbours = g.params.graph.get(victim)!;
    const rest = new Set(ids.filter((id) => id !== victim));
    const x1 = readingsFor(rng, ids);
    const x3 = readingsFor(rng, ids);

    // Round 1: the victim reports and its self-mask is rebuilt. Round 2: it drops, so every neighbour releases its
    // round-2 mask with it. Round 3: it reports again.
    const r1 = runRound(g, 1, x1, everyone(ids)).result as { status: 'published'; evidence: RoundEvidence };
    const r2 = runRound(g, 2, readingsFor(rng, ids), { reporting: rest, confirming: rest, releasing: rest }).result as { status: 'published'; evidence: RoundEvidence };
    const r3 = runRound(g, 3, x3, everyone(ids)).result as { status: 'published'; evidence: RoundEvidence };
    expect([r1.status, r2.status, r3.status]).toEqual(['published', 'published', 'published']);

    const y = (ev: RoundEvidence) => ev.contributions.find((c) => c.id === victim)!.y;
    const self = (ev: RoundEvidence) => Buffer.from(ev.secrets.get(victim)!).readBigUInt64LE(0);
    // Round 2: each neighbour's correction is exactly -s_vj m_vj(2), since the victim was its only absent neighbour.
    const released2 = neighbours.reduce((acc, j) => sub(acc, r2.evidence.contributions.find((c) => c.id === j)!.correction), 0n as U64);

    // Everything the coordinator saw: round-2 masks, round-1 and round-3 self-masks.
    const guess1 = decode(sub(sub(y(r1.evidence), self(r1.evidence)), released2));
    const guess3 = decode(sub(sub(y(r3.evidence), self(r3.evidence)), released2));
    const difference = decode(sub(sub(y(r1.evidence), self(r1.evidence)), sub(y(r3.evidence), self(r3.evidence))));
    const reuse = { round1: guess1 === x1.get(victim), round3: guess3 === x3.get(victim), difference: difference === x1.get(victim)! - x3.get(victim)! };
    console.log(`[attack] mask reuse with round-2 masks: ${JSON.stringify(reuse)}`);
    expect(reuse).toEqual({ round1: false, round3: false, difference: false });

    // Control: epoch-level keys (what rebuilding a dropped meter's key released in Phase 1) unmask every round.
    const epochKeys = neighbours.reduce((acc, j) => signedMask(acc, victim, j, stolenMask(g, j, victim, 1)), 0n as U64);
    const control = decode(sub(sub(y(r1.evidence), self(r1.evidence)), epochKeys)) === x1.get(victim);
    console.log(`[attack] control with epoch-level pair keys: round 1 unmasked = ${control}`);
    expect(control).toBe(true);
  });
});

describe('tampered totals against the ledger', () => {
  const rng = new Rng(33);
  const ids = distinctIds(rng, 12);
  const g = setupGroup(ids, 5, 6, 4);
  const publish = (round: number) => runRound(g, round, readingsFor(rng, ids), everyone(ids)).result as { status: 'published'; total: bigint; evidence: RoundEvidence };

  it('accepts one total per round and audits it clean', () => {
    const { total, evidence } = publish(1);
    const record = recordFor(g.operator, evidence, total);
    g.ledger.record(record);
    expect(audit(record, evidence, g.params.graph, g.registry)).toEqual({ total, problems: [] });
    expect(() => g.ledger.record(recordFor(g.operator, evidence, total + 1n))).toThrow(/already has a total/);
    expect(g.ledger.totalOf(g.params.epoch, 1)).toBe(total); // a party shown total + 1 can check this
  });

  it('catches a false recorded total, and evidence forged to support it', () => {
    const { total, evidence } = publish(2);
    const record = recordFor(g.operator, evidence, total + 5n);
    g.ledger.record(record); // validators check signatures, not arithmetic
    expect(audit(record, evidence, g.params.graph, g.registry).problems).toEqual([`recorded total ${total + 5n} differs from recomputed ${total}`]);

    const [first, ...others] = evidence.contributions;
    const forged: RoundEvidence = { ...evidence, contributions: [{ ...first!, correction: sub(first!.correction, 5n) }, ...others] };
    const problems = audit(record, forged, g.params.graph, g.registry).problems;
    expect(problems).toContain('contributions differ from the recorded Merkle root');
    expect(problems).toContain(`contribution of ${first!.id} is not signed by its meter`);
  });

  it('rejects an active set the meters did not co-sign, and exposes a rewritten entry', () => {
    const { total, evidence } = publish(3);
    const mixed = recordFor(g.operator, { ...evidence, active: evidence.active.slice(1) }, total);
    expect(() => g.ledger.record(mixed)).toThrow(/quorum/);

    expect(g.ledger.verifyChain()).toBe(true);
    const entry = g.ledger.log[1]!;
    const at = entry.body.indexOf('"total":"') + 9;
    entry.body[at] = entry.body[at] === 0x31 ? 0x32 : 0x31; // rewrite a stored total in place
    expect(g.ledger.verifyChain()).toBe(false);
  });
});
