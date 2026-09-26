// Z_{2^64}: masked reports, masks and totals all live here (M = 2^64).
// Signed readings (solar export) are carried as two's complement.

export type U64 = bigint; // invariant: 0 <= v < 2^64

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

export const add = (a: U64, b: U64): U64 => BigInt.asUintN(64, a + b);
export const sub = (a: U64, b: U64): U64 => BigInt.asUintN(64, a - b);

/** Signed reading -> ring element. */
export function encode(x: bigint): U64 {
  if (x < INT64_MIN || x > INT64_MAX) throw new RangeError(`reading ${x} outside int64`);
  return BigInt.asUintN(64, x);
}

/** Ring element -> signed value. Exact while the true total lies in int64, i.e. M > 2 * max |total|. */
export const decode = (v: U64): bigint => BigInt.asIntN(64, v);
