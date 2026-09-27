// A malicious coordinator for replayed attacks: it controls every message and holds the full state of the meters it
// corrupts, while honest meters run the real protocol code. Used by the Phase 3 gate and the demo's collusion slider.
import { prg } from './crypto.ts';
import { isAborted, type Confirm, type MeterId } from './protocol.ts';
import { add, decode, sub, type U64 } from './ring.ts';
import { combine, type Share } from './shamir.ts';
import type { Group } from './simulation.ts';

interface Internals {
  epoch: { pairs: Map<MeterId, { mask: Uint8Array }> };
}

/** A corrupted meter's round mask with a neighbour, read straight from its state. */
export const stolenMask = (g: Group, owner: MeterId, peer: MeterId, round: number): U64 =>
  prg((g.meters.get(owner) as unknown as Internals).epoch.pairs.get(peer)!.mask, g.params.epoch, round);

export const signedMask = (acc: U64, self: MeterId, peer: MeterId, mask: U64): U64 => (self < peer ? add(acc, mask) : sub(acc, mask));

/** Every subset of `items`. */
export function splits<T>(items: readonly T[]): Set<T>[] {
  return Array.from({ length: 2 ** items.length }, (_, mask) => new Set(items.filter((_, i) => mask & (1 << i))));
}

export interface AttackOutcome {
  unmasked: boolean; // the coordinator's reconstruction equals the victim's true reading
  guess?: bigint; // its reconstruction, when it had everything it needed
  detected: number; // honest meters that aborted on conflicting confirmations
  shares: number; // shares of the victim's self-mask it collected
  missing: number; // victim's pair masks it could not learn
}

/**
 * Survivor-set attack on `victim` in one round: the `dropped` honest neighbours are told the victim missed the
 * deadline, everyone else is told it reported. The coordinator collects every correction, share and corrupted state,
 * then tries to unmask the victim's report. With `forwardAll`, it relays the conflicting confirmations too.
 */
export function survivorSet(
  g: Group,
  victim: MeterId,
  corrupt: ReadonlySet<MeterId>,
  dropped: ReadonlySet<MeterId>,
  round: number,
  forwardAll: boolean,
  readings: ReadonlyMap<MeterId, bigint>,
): AttackOutcome {
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
  const guess = decode(sub(sub(y.get(victim)!, selfMask), masks));
  return { unmasked: guess === readings.get(victim), guess, detected, shares: shares.length, missing };
}
