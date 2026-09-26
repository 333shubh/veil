import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { harary } from '../src/graph.ts';

const roster = (n: number) => Array.from({ length: n }, (_, i) => 1000 + 7 * i);
const seedOf = (i: number) => {
  const s = Buffer.alloc(32);
  s.writeUInt32LE(i);
  return s;
};

describe('random Harary graph', () => {
  it('is a function of the roster and the public seed only', () => {
    const seed = randomBytes(32);
    expect(harary(roster(50), 6, seed)).toEqual(harary([...roster(50)].reverse(), 6, Buffer.from(seed)));
    expect(harary(roster(50), 6, seed)).not.toEqual(harary(roster(50), 6, randomBytes(32)));
  });

  it('is symmetric, with exactly k distinct neighbours per meter', () => {
    for (const [n, k] of [[3, 2], [10, 4], [10, 9], [11, 10], [101, 2], [200, 54]] as const) {
      const g = harary(roster(n), k, randomBytes(32));
      expect(g.size).toBe(n);
      for (const [i, ns] of g) {
        expect(ns.length).toBe(Math.min(k, n - 1));
        expect(new Set(ns).size).toBe(ns.length);
        expect(ns).not.toContain(i);
        for (const j of ns) expect(g.get(j)).toContain(i);
      }
    }
  });

  it("draws each meter's neighbourhood uniformly (chi-square over 4,000 seeds)", () => {
    const [n, k, runs] = [20, 4, 4000];
    const ids = roster(n);
    const counts = new Map<number, number>();
    for (let r = 0; r < runs; r++) for (const j of harary(ids, k, seedOf(r)).get(ids[0]!)!) counts.set(j, (counts.get(j) ?? 0) + 1);
    const expected = (runs * k) / (n - 1);
    const chi2 = ids.slice(1).reduce((s, j) => s + ((counts.get(j) ?? 0) - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(42.31); // 18 degrees of freedom, p = 0.001
  });

  it('rejects odd k below N - 1, k < 2, repeated ids and short seeds', () => {
    const seed = randomBytes(32);
    expect(() => harary(roster(10), 3, seed)).toThrow(RangeError);
    expect(() => harary(roster(10), 0, seed)).toThrow(RangeError);
    expect(() => harary([1, 1, 2], 2, seed)).toThrow(RangeError);
    expect(() => harary(roster(10), 4, seed.subarray(0, 16))).toThrow(RangeError);
  });
});
