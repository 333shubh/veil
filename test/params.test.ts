import { describe, expect, it } from 'vitest';
import { choose, DESIGN, evaluate, neighbourhoodSizes, perMeter, type Design } from '../src/params.ts';

const d = (corrupt: number, dropout: number): Design => ({ ...DESIGN, corrupt, dropout });

describe('failure model', () => {
  it('matches hand-computed per-meter probabilities', () => {
    // 10 meters, 2 corrupt, complete graph: an honest meter always has exactly 2 corrupt neighbours.
    expect(perMeter(10, 9, 2, d(0.2, 0.1)).breach).toBe(1);
    expect(perMeter(10, 9, 3, d(0.2, 0.1)).breach).toBe(0);
    // 6 meters, 2 corrupt, k = 2: P(both neighbours corrupt) = C(2,2) / C(5,2) = 1/10.
    expect(perMeter(6, 2, 2, d(1 / 3, 0.1)).breach).toBeCloseTo(0.1, 12);
    // Stranded with k = 2, t = 2, dropout 0.1: 1 - 0.9^2.
    expect(perMeter(6, 2, 2, d(0, 0.1)).stranded).toBeCloseTo(0.19, 12);
    // No corruption: k given meters are all silent with probability dropout^k.
    expect(perMeter(100, 4, 3, d(0, 0.1)).runsBad).toBeCloseTo(1e-4, 15);
  });

  it('has no partition term for complete graphs', () => {
    expect(evaluate(50, 49, 30, DESIGN).partition).toBe(-Infinity);
    expect(evaluate(50, 48, 30, DESIGN).partition).toBeGreaterThan(-Infinity);
  });

  it('lists even Harary sizes, then the complete graph', () => {
    expect(neighbourhoodSizes(3)).toEqual([2]);
    expect(neighbourhoodSizes(8)).toEqual([2, 4, 6, 7]);
  });
});

describe('choosing k and t', () => {
  it('returns the smallest k meeting both bounds, with t > k/2', () => {
    for (const n of [50, 200, 1000]) {
      const c = choose(n, DESIGN)!;
      expect(c.t).toBeGreaterThan(c.k / 2);
      expect(c.privacy).toBeLessThanOrEqual(DESIGN.privacyLog2);
      expect(c.recovery).toBeLessThanOrEqual(DESIGN.recoveryLog2);
      const smaller = c.k - 2;
      for (let t = Math.floor(smaller / 2) + 1; t <= smaller; t++) {
        const f = evaluate(n, smaller, t, DESIGN);
        expect(f.privacy <= DESIGN.privacyLog2 && f.recovery <= DESIGN.recoveryLog2).toBe(false);
      }
    }
  });

  it('reports no k when even the complete graph aborts too often', () => {
    expect(choose(10, DESIGN)).toBeUndefined();
    expect(choose(10, d(0.2, 0.001))).toBeDefined();
  });
});
