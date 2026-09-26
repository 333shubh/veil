// Neighbour graph for one epoch, derived from public randomness so every meter can rebuild and check it.
import { hkdf, u32Stream } from './crypto.ts';
import type { MeterId } from './protocol.ts';

/** Uniform integer in [0, n) by rejection, so the shuffle is unbiased. */
function below(next: () => number, n: number): number {
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    const v = next();
    if (v < limit) return v % n;
  }
}

/**
 * Random Harary graph: the roster is shuffled onto a ring by a stream keyed from the epoch's public seed, and
 * each meter is joined to the k/2 nearest meters on either side. Every meter gets exactly k neighbours, and a
 * given meter's neighbours are a uniformly random k-subset of the others. k >= N - 1 gives the complete graph.
 */
export function harary(ids: readonly MeterId[], k: number, seed: Uint8Array): Map<MeterId, MeterId[]> {
  const n = ids.length;
  const sorted = [...ids].sort((a, b) => a - b);
  if (n < 2 || new Set(ids).size !== n) throw new RangeError('roster needs at least two distinct meters');
  if (!Number.isInteger(k) || k < 2 || (k < n - 1 && k % 2 === 1)) {
    throw new RangeError(`k = ${k} must be even and at least 2, or at least N - 1`);
  }
  if (seed.length !== 32) throw new RangeError('graph seed must be 32 bytes');
  if (k >= n - 1) return new Map(sorted.map((id) => [id, sorted.filter((j) => j !== id)]));

  const ring = [...sorted];
  const next = u32Stream(hkdf(seed, Buffer.from('veil/v1/graph')));
  for (let i = n - 1; i > 0; i--) {
    const j = below(next, i + 1);
    [ring[i], ring[j]] = [ring[j]!, ring[i]!];
  }
  const adj = new Map<MeterId, MeterId[]>(sorted.map((id) => [id, []]));
  for (let p = 0; p < n; p++) {
    for (let d = 1; d <= k / 2; d++) {
      const a = ring[p]!;
      const b = ring[(p + d) % n]!;
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }
  }
  for (const ns of adj.values()) ns.sort((a, b) => a - b);
  return adj;
}
