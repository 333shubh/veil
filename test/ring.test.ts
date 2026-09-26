import { describe, expect, it } from 'vitest';
import { add, decode, encode, sub } from '../src/ring';

const MAX = (1n << 63n) - 1n;
const MIN = -(1n << 63n);

describe('Z_2^64', () => {
  it("round-trips int64 readings through two's complement", () => {
    for (const x of [0n, 1n, -1n, -4200n, MAX, MIN]) expect(decode(encode(x))).toBe(x);
    expect(encode(-1n)).toBe((1n << 64n) - 1n);
  });

  it('rejects readings outside int64', () => {
    expect(() => encode(MAX + 1n)).toThrow(RangeError);
    expect(() => encode(MIN - 1n)).toThrow(RangeError);
  });

  it('wraps modulo 2^64 and keeps signed sums exact', () => {
    expect(add((1n << 64n) - 1n, 1n)).toBe(0n);
    expect(sub(0n, 1n)).toBe((1n << 64n) - 1n);
    expect(decode(add(encode(-7n), encode(3n)))).toBe(-4n);
    expect(decode(add(encode(MAX), encode(MIN)))).toBe(-1n);
  });
});
