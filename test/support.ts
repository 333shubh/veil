// Test harness: seeded randomness for readings and dropout patterns, and a driver for epochs and rounds.
import { randomBytes } from 'node:crypto';
import { ed25519Keygen, type SigningKey } from '../src/crypto.ts';
import { Ledger, signAnchor } from '../src/ledger.ts';
import {
  anchoredParams,
  Coordinator,
  isAborted,
  Meter,
  type Confirm,
  type EpochAnchor,
  type GroupParams,
  type MeterId,
  type Release,
  type RoundResult,
} from '../src/protocol.ts';

/** mulberry32: reproducible test randomness (protocol secrets still come from node:crypto). */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  u32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  float(): number {
    return this.u32() / 2 ** 32;
  }
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }
  /** Near-uniform bigint in [lo, hi] (96 random bits reduced; bias below 2^-32). */
  big(lo: bigint, hi: bigint): bigint {
    const r = (BigInt(this.u32()) << 64n) | (BigInt(this.u32()) << 32n) | BigInt(this.u32());
    return lo + (r % (hi - lo + 1n));
  }
  chance(p: number): boolean {
    return this.float() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

export function distinctIds(rng: Rng, n: number): MeterId[] {
  const ids = new Set<MeterId>();
  while (ids.size < n) ids.add(rng.int(1, 0xffffffff));
  return [...ids];
}

export interface Group {
  ids: MeterId[];
  registry: Map<MeterId, Uint8Array>;
  operator: SigningKey;
  ledger: Ledger;
  meters: Map<MeterId, Meter>;
  coordinator: Coordinator;
  params: GroupParams;
  anchor: EpochAnchor;
}

/** Devices, meters, coordinator and ledger for a roster, then its first epoch. */
export function setupGroup(ids: MeterId[], epoch: number, k: number, threshold: number, minGroupSize = 3): Group {
  const devices = new Map(ids.map((id) => [id, ed25519Keygen()]));
  const registry = new Map(ids.map((id) => [id, devices.get(id)!.publicKey]));
  const secrets = new Map(ids.map((id) => [id, randomBytes(32)]));
  const operator = ed25519Keygen();
  const g = {
    ids,
    registry,
    operator,
    ledger: new Ledger(operator.publicKey, registry),
    meters: new Map(ids.map((id) => [id, new Meter(id, devices.get(id)!, secrets.get(id)!, registry)])),
    coordinator: new Coordinator(secrets, registry),
  } as Group;
  startEpoch(g, epoch, k, threshold, minGroupSize);
  return g;
}

/** Epoch setup: anchor roster and beacon on the ledger, derive the graph, exchange device-signed keys. */
export function startEpoch(g: Group, epoch: number, k: number, threshold: number, minGroupSize = 3): void {
  g.anchor = signAnchor(g.operator, { epoch, roster: g.ids, beacon: randomBytes(32), k });
  g.ledger.anchor(g.anchor);
  g.params = anchoredParams(g.anchor, g.registry, threshold, minGroupSize);
  g.coordinator.startEpoch(g.params, g.anchor);
  const directory = g.coordinator.register([...g.meters.values()].map((m) => m.startEpoch(g.params, g.anchor)));
  for (const m of g.meters.values()) m.keyExchange(directory);
}

/** Who answers each phase of a round: reporting ⊇ confirming ⊇ releasing. */
export interface Pattern {
  reporting: ReadonlySet<MeterId>;
  confirming: ReadonlySet<MeterId>;
  releasing: ReadonlySet<MeterId>;
}

export const everyone = (ids: MeterId[]): Pattern => ({ reporting: new Set(ids), confirming: new Set(ids), releasing: new Set(ids) });

export function runRound(
  g: Group,
  round: number,
  readings: ReadonlyMap<MeterId, bigint>,
  pattern: Pattern,
): { result: RoundResult; aborts: string[] } {
  const aborts: string[] = [];
  const reports = [...pattern.reporting].map((id) => g.meters.get(id)!.report(round, readings.get(id)!));
  const closed = g.coordinator.close(round, reports);
  if (closed.status === 'suppressed') return { result: closed, aborts };
  const confirms: Confirm[] = [];
  for (const id of closed.active) {
    if (!pattern.confirming.has(id)) continue;
    const c = g.meters.get(id)!.confirm(round, closed.active);
    if (isAborted(c)) aborts.push(c.aborted);
    else confirms.push(c);
  }
  const collected = g.coordinator.collect(confirms);
  if (collected.status === 'suppressed') return { result: collected, aborts };
  const releases: Release[] = [];
  for (const id of collected.final) {
    if (!pattern.releasing.has(id)) continue;
    const r = g.meters.get(id)!.release(round, collected.final, collected.inbox.get(id) ?? []);
    if (isAborted(r)) aborts.push(r.aborted);
    else releases.push(r);
  }
  return { result: g.coordinator.recover(releases), aborts };
}
