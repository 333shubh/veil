// A malicious coordinator for replayed attacks. It chooses what each meter is shown (its active set U and final set F)
// and which messages reach whom, and holds the full state of the meters it corrupts, while honest meters run the real
// protocol code. Used by the attack tests and the demo's collusion slider.
import { prg } from './crypto.ts';
import { isAborted, openEscrow, setHash, type Check, type Confirm, type MeterId, type Release, type Removal, type Unmask } from './protocol.ts';
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

/** What the coordinator shows each meter. Corrupted meters are shown whatever helps the attack. */
export interface Views {
  active: (id: MeterId) => ReadonlySet<MeterId>;
  final: (id: MeterId) => ReadonlySet<MeterId>;
}

export interface AttackOutcome {
  unmasked: boolean; // the coordinator's reconstruction equals the victim's true reading
  guess?: bigint; // its reconstruction, when it had everything it needed
  detected: number; // honest meters that aborted on conflicting views
  shares: number; // shares of the victim's self-mask it collected (0 if the victim revealed it)
  missing: number; // victim's pair masks it could not learn
}

/**
 * One round under chosen views. Every meter reports; each is shown its own U and F; confirmations and checks are
 * delivered only between meters shown the same sets, unless `forwardAll` relays the conflicting ones too. The
 * coordinator then asks everyone for the victim's shares and tries to unmask the victim's report.
 */
export function attack(
  g: Group,
  victim: MeterId,
  corrupt: ReadonlySet<MeterId>,
  views: Views,
  round: number,
  readings: ReadonlyMap<MeterId, bigint>,
  forwardAll = false,
): AttackOutcome {
  const { epoch, threshold: t, graph } = g.params;
  const hashOf = (kind: 'active' | 'final', set: ReadonlySet<MeterId>) => setHash(kind, epoch, round, set).toString('hex');
  const y = new Map(g.ids.map((id) => [id, g.meters.get(id)!.report(round, readings.get(id)!).y]));
  let detected = 0;
  const failed = (id: MeterId, reason: string) => {
    if (!corrupt.has(id) && /differs/.test(reason)) detected++;
  };

  const confirms = new Map<MeterId, Confirm>();
  for (const id of g.ids) {
    const c = g.meters.get(id)!.confirm(round, views.active(id));
    if (!isAborted(c)) confirms.set(id, c);
  }
  const checks = new Map<MeterId, Check>();
  for (const [id] of confirms) {
    const mine = hashOf('active', views.active(id));
    const inbox = [...confirms.values()].filter(
      (c) => graph.get(id)!.includes(c.id) && (forwardAll || Buffer.from(c.activeHash).toString('hex') === mine),
    );
    const c = g.meters.get(id)!.check(round, views.final(id), inbox);
    if (isAborted(c)) failed(id, c.aborted);
    else checks.set(id, c);
  }
  const releases = new Map<MeterId, Release>();
  for (const [id] of checks) {
    if (!views.final(id).has(id)) continue;
    const mine = hashOf('final', views.final(id));
    const inbox = [...checks.values()].filter((c) => graph.get(id)!.includes(c.id) && (forwardAll || Buffer.from(c.finalHash).toString('hex') === mine));
    const r = g.meters.get(id)!.release(round, inbox);
    if (isAborted(r)) failed(id, r.aborted);
    else releases.set(id, r);
  }
  const unmasks: Unmask[] = [];
  const want = new Set([victim, ...graph.get(victim)!]);
  for (const [id] of checks) {
    const u = g.meters.get(id)!.unmask(round, want);
    if (!isAborted(u)) unmasks.push(u);
  }

  // Everything the coordinator now holds about the victim and about each neighbour's removal.
  const shares: Share[] = unmasks.flatMap((u) => (u.shares.has(victim) ? [{ x: BigInt(u.id), y: u.shares.get(victim)! }] : []));
  const removalOf = (id: MeterId): Removal | undefined => {
    const released = releases.get(id)?.removal;
    if (released) return released;
    const sealed = checks.get(id)?.escrow?.sealed;
    const keys = unmasks.flatMap((u) => (u.keys.has(id) ? [{ x: BigInt(u.id), y: u.keys.get(id)! }] : []));
    if (!sealed || keys.length < t) return undefined;
    try {
      return openEscrow(epoch, round, id, combine(keys, t), sealed);
    } catch {
      return undefined;
    }
  };
  const self = releases.get(victim)?.secret ?? (shares.length >= t ? combine(shares, t) : undefined);
  const secretShares = releases.has(victim) ? 0 : shares.length;

  // The victim's own correction covers neighbours outside its U, its removal those in its U but outside its F.
  const vc = confirms.get(victim);
  const vRemoval = removalOf(victim);
  let masks: U64 = vc?.correction ?? 0n;
  if (vRemoval) masks = add(masks, vRemoval.value);
  let missing = vc ? 0 : graph.get(victim)!.length;
  for (const j of vc ? graph.get(victim)! : []) {
    const inU = views.active(victim).has(j);
    if (!inU) continue; // in the victim's correction
    if (!views.final(victim).has(j) && vRemoval) continue; // in the victim's removal
    if (corrupt.has(j)) {
      masks = signedMask(masks, victim, j, stolenMask(g, j, victim, round));
      continue;
    }
    // An honest neighbour gives the mask away alone only when the victim is the one neighbour it removes.
    const outsideU = graph.get(j)!.filter((l) => !views.active(j).has(l));
    const outsideF = graph.get(j)!.filter((l) => views.active(j).has(l) && !views.final(j).has(l));
    const jc = confirms.get(j);
    const jr = views.final(j).has(j) ? removalOf(j) : undefined;
    if (jc && outsideU.length === 1 && outsideU[0] === victim) masks = sub(masks, jc.correction); // -s_vj m_vj
    else if (jr && outsideF.length === 1 && outsideF[0] === victim) masks = sub(masks, jr.value);
    else missing++;
  }
  if (!vc || self === undefined || missing > 0) return { unmasked: false, detected, shares: secretShares, missing };
  const guess = decode(sub(sub(y.get(victim)!, Buffer.from(self).readBigUInt64LE(0)), masks));
  return { unmasked: guess === readings.get(victim), guess, detected, shares: secretShares, missing };
}

/**
 * Survivor-set attack on `victim`: the `dropped` honest neighbours are shown a U without the victim, everyone else the
 * true U; each meter's F is its U.
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
  const all = new Set(g.ids);
  const without = new Set(g.ids.filter((id) => id !== victim));
  const view = (id: MeterId) => (dropped.has(id) ? without : all);
  return attack(g, victim, corrupt, { active: view, final: view }, round, readings, forwardAll);
}

/**
 * Final-set split on `victim`: everyone is shown the true U. The victim is shown an F without the `excluded` honest
 * neighbours, so it removes its masks with them; they are shown the full F, so they pass on the victim's self-mask
 * shares. The corrupted meters and the other honest neighbours are shown the victim's F.
 */
export function finalSplit(
  g: Group,
  victim: MeterId,
  corrupt: ReadonlySet<MeterId>,
  excluded: ReadonlySet<MeterId>,
  round: number,
  readings: ReadonlyMap<MeterId, bigint>,
): AttackOutcome {
  const all = new Set(g.ids);
  const shown = new Set(g.ids.filter((id) => !excluded.has(id)));
  const neighbours = new Set(g.params.graph.get(victim)!);
  const final = (id: MeterId) => (id === victim || corrupt.has(id) || (neighbours.has(id) && !excluded.has(id)) ? shown : all);
  return attack(g, victim, corrupt, { active: () => all, final }, round, readings);
}
