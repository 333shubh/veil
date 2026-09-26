import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { combine, P, split } from '../src/shamir.ts';
import { Rng } from './support.ts';

function powMod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  for (b %= m; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
}

function isProbablePrime(n: bigint, bases: readonly bigint[]): boolean {
  let d = n - 1n;
  let s = 0;
  for (; (d & 1n) === 0n; d >>= 1n) s++;
  return bases.every((a) => {
    let x = powMod(a, d, n);
    if (x === 1n || x === n - 1n) return true;
    for (let i = 1; i < s; i++) if ((x = (x * x) % n) === n - 1n) return true;
    return false;
  });
}

describe('Shamir over GF(2^256 + 297)', () => {
  it('uses the smallest prime above 2^256', () => {
    const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n];
    expect(isProbablePrime(P, bases)).toBe(true);
    for (let n = (1n << 256n) + 1n; n < P; n += 2n) expect(isProbablePrime(n, bases)).toBe(false);
  });

  it('rebuilds any 32-byte secret from any t shares', () => {
    const rng = new Rng(1);
    for (let trial = 0; trial < 200; trial++) {
      const n = rng.int(1, 16);
      const t = rng.int(1, n);
      const secret = trial === 0 ? Buffer.alloc(32) : trial === 1 ? Buffer.alloc(32, 0xff) : randomBytes(32);
      const points = new Set<bigint>();
      while (points.size < n) points.add(BigInt(rng.int(1, 0xffffffff)));
      const shares = rng.shuffle(split(secret, t, [...points]));
      expect(Buffer.from(combine(shares, t)).equals(secret)).toBe(true);
      expect(Buffer.from(combine(shares.slice(n - t), t)).equals(secret)).toBe(true);
      expect(() => combine(shares.slice(0, t - 1), t)).toThrow(RangeError);
    }
  });

  it('rejects bad thresholds and points', () => {
    const s = randomBytes(32);
    expect(() => split(s, 0, [1n, 2n])).toThrow(RangeError);
    expect(() => split(s, 3, [1n, 2n])).toThrow(RangeError);
    expect(() => split(s, 2, [1n, 1n])).toThrow(RangeError);
    expect(() => split(s, 1, [0n])).toThrow(RangeError);
  });
});
