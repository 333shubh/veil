// Shamir secret sharing of 32-byte secrets over GF(P).
import { randomBytes } from 'node:crypto';

/** Smallest prime above 2^256, so every 32-byte secret is a single field element. */
export const P = (1n << 256n) + 297n;
export const SHARE_BYTES = 33;

export interface Share {
  x: bigint; // evaluation point, nonzero and distinct per holder
  y: bigint;
}

const mod = (a: bigint): bigint => {
  const r = a % P;
  return r < 0n ? r + P : r;
};

/** Points below 2^32 (meter ids) let several small factors multiply before one reduction mod P. */
const SMALL = 1n << 32n;
const CHUNK = 7; // 7 factors below 2^33 stay below 2^231

function inverse(a: bigint): bigint {
  let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new RangeError('not invertible');
  return mod(s0);
}

function randomElement(): bigint {
  for (;;) {
    const b = randomBytes(SHARE_BYTES);
    b[0] &= 1; // 257 bits; P > 2^256, so at most two draws on average
    const v = toBigInt(b);
    if (v < P) return v;
  }
}

export const toBigInt = (bytes: Uint8Array): bigint => BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));

export function toBytes(v: bigint, length: number): Uint8Array {
  const hex = v.toString(16).padStart(length * 2, '0');
  if (v < 0n || hex.length > length * 2) throw new RangeError(`value does not fit in ${length} bytes`);
  return Buffer.from(hex, 'hex');
}

function checkPoints(xs: readonly bigint[]): void {
  if (new Set(xs).size !== xs.length || xs.some((x) => x <= 0n || x >= P)) {
    throw new RangeError('share points must be distinct and nonzero');
  }
}

/** Split a 32-byte secret into one share per point; any t of them rebuild it. */
export function split(secret: Uint8Array, t: number, xs: readonly bigint[]): Share[] {
  if (secret.length !== 32) throw new RangeError('secret must be 32 bytes');
  if (!Number.isInteger(t) || t < 1 || t > xs.length) throw new RangeError(`threshold ${t} with ${xs.length} holders`);
  checkPoints(xs);
  const coeffs = [toBigInt(secret)];
  for (let i = 1; i < t; i++) coeffs.push(randomElement());
  // Horner's rule; with a small point, each step adds about 32 bits, so reducing every fourth step is enough.
  const every = xs.every((x) => x < SMALL) ? 4 : 1;
  return xs.map((x) => {
    let acc = 0n;
    for (let i = coeffs.length - 1, n = 1; i >= 0; i--, n++) {
      acc = acc * x + coeffs[i]!;
      if (n % every === 0) acc %= P;
    }
    return { x, y: acc % P };
  });
}

/** Product mod P of factors that may be negative; small factors are multiplied in chunks before each reduction. */
function product(factors: readonly bigint[], small: boolean): bigint {
  let acc = 1n;
  let chunk = 1n;
  for (let i = 0; i < factors.length; i++) {
    chunk *= factors[i]!;
    if (!small || (i + 1) % CHUNK === 0) {
      acc = mod(acc * chunk);
      chunk = 1n;
    }
  }
  return mod(acc * chunk);
}

/** Inverses of every element with one field inversion (Montgomery's trick). */
function inverses(values: readonly bigint[]): bigint[] {
  const prefix: bigint[] = [];
  let acc = 1n;
  for (const v of values) {
    prefix.push(acc);
    acc = (acc * v) % P;
  }
  let inv = inverse(acc);
  const out = Array<bigint>(values.length);
  for (let i = values.length - 1; i >= 0; i--) {
    out[i] = (inv * prefix[i]!) % P;
    inv = (inv * values[i]!) % P;
  }
  return out;
}

/**
 * Lagrange interpolation at 0 over the first t shares:
 *   secret = sum_j y_j prod_{m != j} x_m / (x_m - x_j) = (prod_m x_m) sum_j y_j / (x_j prod_{m != j} (x_m - x_j)).
 * The denominators are products of small integers when the points are meter ids, and one batched inversion covers
 * all t of them.
 */
export function combine(shares: readonly Share[], t: number): Uint8Array {
  if (shares.length < t) throw new RangeError(`need ${t} shares, have ${shares.length}`);
  const use = shares.slice(0, t);
  const xs = use.map((s) => s.x);
  checkPoints(xs);
  const small = xs.every((x) => x < SMALL);
  const dens = xs.map((xj, j) => product([xj, ...xs.filter((_, m) => m !== j).map((xm) => xm - xj)], small));
  const inv = inverses(dens);
  let sum = 0n;
  for (let j = 0; j < t; j++) sum = (sum + use[j]!.y * inv[j]!) % P;
  return toBytes((product(xs, small) * sum) % P, 32);
}
