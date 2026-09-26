// Test harness: seeded randomness for readings, graphs and dropout patterns, and a round driver.
import { Coordinator, Meter, type GroupParams, type MeterId, type Release, type RoundResult } from '../src/protocol';

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

/** Random symmetric graph in which every meter has at least k neighbours. */
export function randomGraph(rng: Rng, ids: readonly MeterId[], k: number): Map<MeterId, MeterId[]> {
  const adj = new Map(ids.map((id) => [id, new Set<MeterId>()]));
  for (const i of ids) {
    while (adj.get(i)!.size < k) {
      const j = rng.pick(ids);
      if (j === i) continue;
      adj.get(i)!.add(j);
      adj.get(j)!.add(i);
    }
  }
  return new Map([...adj].map(([id, ns]) => [id, [...ns]]));
}

export interface Group {
  params: GroupParams;
  meters: Map<MeterId, Meter>;
  coordinator: Coordinator;
}

/** Epoch setup: publish keys, derive k_ij, deal encrypted shares through the coordinator. */
export function setupGroup(params: GroupParams): Group {
  const meters = new Map([...params.graph.keys()].map((id) => [id, new Meter(id, params)]));
  const coordinator = new Coordinator(params);
  const directory = coordinator.register([...meters.values()].map((m) => m.publicKeys()));
  const inbox = coordinator.route([...meters.values()].flatMap((m) => m.deal(directory)));
  for (const m of meters.values()) m.accept(inbox.get(m.id) ?? []);
  return { params, meters, coordinator };
}

/** One round: `reporting` meters report by the deadline; `responding` ones (a subset) answer the share request. */
export function runRound(
  g: Group,
  round: number,
  readings: ReadonlyMap<MeterId, bigint>,
  reporting: ReadonlySet<MeterId>,
  responding: ReadonlySet<MeterId>,
): { result: RoundResult; releases: Release[] } {
  const reports = [...reporting].map((id) => g.meters.get(id)!.report(round, readings.get(id)!));
  const closed = g.coordinator.close(round, reports);
  if (closed.status === 'suppressed') return { result: closed, releases: [] };
  const releases = [...responding].map((id) => g.meters.get(id)!.release(round, closed.active));
  return { result: g.coordinator.recover(releases), releases };
}
