// Test harness: seeded randomness for readings and dropout patterns; the group driver lives in src/simulation.ts.
import type { MeterId } from '../src/protocol.ts';

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

export { everyone, runRound, setupGroup, startEpoch, type Group, type Pattern } from '../src/simulation.ts';
