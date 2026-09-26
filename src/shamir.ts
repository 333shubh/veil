// Shamir secret sharing of 32-byte secrets over GF(P).
import { randomBytes } from 'node:crypto';

/** Smallest prime above 2^256, so every 32-byte secret is a single field element. */
export const P = (1n << 256n) + 297n;
export const SHARE_BYTES = 33;

export interface Share {
  x: bigint; // evaluation point, nonzero and distinct per holder
  y: bigint;
}

const mod = (a: bigint): bigint => ((a % P) + P) % P;

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
  return xs.map((x) => ({ x, y: coeffs.reduceRight((acc, c) => (acc * x + c) % P, 0n) }));
}

/** Lagrange interpolation at 0 over the first t shares, kept as one fraction so it costs one inversion. */
export function combine(shares: readonly Share[], t: number): Uint8Array {
  if (shares.length < t) throw new RangeError(`need ${t} shares, have ${shares.length}`);
  const use = shares.slice(0, t);
  checkPoints(use.map((s) => s.x));
  let num = 0n; // secret = num / den
  let den = 1n;
  for (const [j, sj] of use.entries()) {
    let n = sj.y;
    let d = 1n;
    for (const [m, sm] of use.entries()) {
      if (m === j) continue;
      n = (n * sm.x) % P;
      d = mod(d * (sm.x - sj.x));
    }
    num = (num * d + n * den) % P;
    den = (den * d) % P;
  }
  return toBytes((num * inverse(den)) % P, 32);
}
