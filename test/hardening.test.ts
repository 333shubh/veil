import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { kemEncapsulate, x25519Keygen } from '../src/crypto.ts';
import { signAnchor } from '../src/ledger.ts';
import { anchoredParams, type MeterId, type PublicKeys } from '../src/protocol.ts';
import { distinctIds, Rng, setupGroup, startEpoch } from './support.ts';

const fresh = (seed: number, n = 8) => {
  const ids = distinctIds(new Rng(seed), n);
  return { ids, g: setupGroup(ids, 1, 4, 3) };
};

interface Internals {
  chain: Uint8Array;
  epoch: { seed: Uint8Array; reportKey: Uint8Array; maskKeys: { sk: Uint8Array }; pairs: Map<MeterId, { mask: Uint8Array }> };
}

describe('per-round report MAC', () => {
  it('leaves out a report altered in transit, and a report replayed from the previous epoch', () => {
    const { ids, g } = fresh(41);
    const reports = ids.map((id) => g.meters.get(id)!.report(1, 100n));
    const altered = { ...reports[0]!, y: reports[0]!.y ^ 1n };
    const closed = g.coordinator.close(1, [altered, ...reports.slice(1)]);
    expect(closed.status === 'open' && [...closed.active]).toEqual(ids.slice(1));

    startEpoch(g, 2, 4, 3);
    const replay = g.coordinator.close(1, reports);
    expect(replay).toMatchObject({ status: 'suppressed' }); // every epoch-1 tag fails under the ratcheted key
  });
});

describe('device-signed epoch keys', () => {
  it('stop a relay that substitutes its own key for a meter\'s', () => {
    const { ids, g } = fresh(42);
    g.anchor = signAnchor(g.operator, { epoch: 2, roster: ids, beacon: randomBytes(32), k: 4 });
    g.ledger.anchor(g.anchor);
    g.params = anchoredParams(g.anchor, g.registry, 3, 3);
    g.coordinator.startEpoch(g.params, g.anchor);
    const directory = new Map(g.coordinator.register([...g.meters.values()].map((m) => m.startEpoch(g.params, g.anchor))));
    const victim = ids[0]!;
    directory.set(victim, { ...directory.get(victim)!, mask: x25519Keygen().pk } satisfies PublicKeys);
    const neighbour = g.params.graph.get(victim)![0]!;
    expect(() => g.meters.get(neighbour)!.keyExchange(directory)).toThrow(`no valid keys from neighbour ${victim}`);
  });
});

describe('ML-KEM encapsulations', () => {
  it('stop a relay that swaps in a secret it encapsulated itself', () => {
    const { ids, g } = fresh(46);
    g.anchor = signAnchor(g.operator, { epoch: 2, roster: ids, beacon: randomBytes(32), k: 4 });
    g.ledger.anchor(g.anchor);
    g.params = anchoredParams(g.anchor, g.registry, 3, 3);
    g.coordinator.startEpoch(g.params, g.anchor);
    const keys = [...g.meters.values()].map((m) => m.startEpoch(g.params, g.anchor));
    const directory = g.coordinator.register(keys);
    const inbox = g.coordinator.relay([...g.meters.values()].flatMap((m) => m.keyExchange(directory)));
    const [victim, messages] = [...inbox].find(([, list]) => list.length > 0)!;
    const forged = messages.map((m, i) => (i === 0 ? { ...m, ciphertext: kemEncapsulate(directory.get(victim)!.kem).ciphertext } : m));
    expect(() => g.meters.get(victim)!.finishKeys(forged)).toThrow(`invalid encapsulation from ${messages[0]!.from}`);
  });
});

describe('epoch key ratchet', () => {
  it('overwrites the old epoch\'s secrets, and the new state does not derive them', () => {
    const { ids, g } = fresh(43);
    const meter = g.meters.get(ids[0]!)! as unknown as Internals;
    const old = meter.epoch;
    const oldChain = meter.chain;
    const copies = [old.seed, old.reportKey, old.maskKeys.sk, [...old.pairs.values()][0]!.mask, oldChain].map((b) => Buffer.from(b));
    startEpoch(g, 2, 4, 3);
    const now = meter.epoch;
    expect([old.seed, old.reportKey, old.maskKeys.sk, [...old.pairs.values()][0]!.mask].every((b) => b.every((x) => x === 0))).toBe(true);
    expect(oldChain.every((x) => x === 0)).toBe(true);
    // Everything a thief could take now: none of it equals an epoch-1 secret.
    const stolen = [meter.chain, now.seed, now.reportKey, now.maskKeys.sk, ...[...now.pairs.values()].map((p) => p.mask)].map((b) => Buffer.from(b));
    expect(stolen.some((s) => copies.some((c) => c.equals(s)))).toBe(false);
  });
});

describe('ledger anchoring', () => {
  it('meters refuse a graph that differs from the anchored one', () => {
    const { ids, g } = fresh(44);
    const anchor = signAnchor(g.operator, { epoch: 2, roster: ids, beacon: randomBytes(32), k: 4 });
    const params = anchoredParams(anchor, g.registry, 3, 3);
    const [a, b] = [ids[0]!, params.graph.get(ids[0]!)![0]!];
    const c = ids.find((id) => id !== a && !params.graph.get(a)!.includes(id))!;
    const tampered = new Map([...params.graph].map(([id, ns]) => [id, [...ns]]));
    tampered.set(a, tampered.get(a)!.map((n) => (n === b ? c : n)));
    expect(() => g.meters.get(a)!.startEpoch({ ...params, graph: tampered }, anchor)).toThrow(/differ from the anchored graph/);
  });

  it('accepts one operator-signed anchor per epoch', () => {
    const { ids, g } = fresh(45);
    const unsigned = { epoch: 2, roster: ids, beacon: randomBytes(32), k: 4 };
    expect(() => g.ledger.anchor({ ...unsigned, signature: new Uint8Array(64) })).toThrow(/not signed by the operator/);
    g.ledger.anchor(signAnchor(g.operator, unsigned));
    expect(() => g.ledger.anchor(signAnchor(g.operator, { ...unsigned, beacon: randomBytes(32) }))).toThrow(/already anchored/);
  });
});
