// Verified mode: Pedersen commitments to readings over ristretto255, and range proofs that a committed reading lies in
// [-2^(B-1), 2^(B-1)). A proof decomposes the reading into B bit commitments and proves each is a commitment to 0 or
// to 1 with a Cramer-Damgard-Schoenmakers OR-proof, made non-interactive with Fiat-Shamir and 128-bit challenges.
// Pure JavaScript (@noble), so it runs unchanged in the browser demo.
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';

type Point = InstanceType<typeof ristretto255.Point>;
const P = ristretto255.Point;

/** Order of the ristretto255 group. */
export const L = P.Fn.ORDER;
const C_BITS = 128n;
const C_MOD = 1n << C_BITS;

export const G: Point = P.BASE;
/** Second generator, from hashing a fixed label to the group: nobody knows its discrete log to base G. */
export const H: Point = ristretto255_hasher.hashToCurve(new TextEncoder().encode('veil/v1/pedersen-H'));
H.precompute(8, false);

export const POINT_BYTES = 32;
export const SCALAR_BYTES = 32;
const CHALLENGE_BYTES = 16;

export const mod = (v: bigint): bigint => ((v % L) + L) % L;

function leNumber(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

function leBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

/** A scalar from 64 or more uniform bytes (wide reduction, negligible bias). */
export const wideScalar = (bytes: Uint8Array): bigint => mod(leNumber(bytes));
export const scalarBytes = (s: bigint): Uint8Array => leBytes(mod(s), SCALAR_BYTES);

function randomScalar(): bigint {
  return wideScalar(globalThis.crypto.getRandomValues(new Uint8Array(64)));
}

/** s * point, allowing s = 0; `unsafe` skips constant time for public scalars. */
function mul(point: Point, s: bigint, unsafe = false): Point {
  const k = mod(s);
  if (k === 0n) return P.ZERO;
  return unsafe ? point.multiplyUnsafe(k) : point.multiply(k);
}

/** C = x G + r H, with a signed reading x taken mod L. */
export const commitPoint = (x: bigint, r: bigint): Point => mul(G, x).add(mul(H, r));
export const commit = (x: bigint, r: bigint): Uint8Array => commitPoint(x, r).toBytes();

/** Parse a commitment; throws on bytes that are not a canonical ristretto255 encoding. */
export const point = (bytes: Uint8Array): Point => P.fromBytes(bytes);

/** Size of a B-bit range proof in bytes. */
export const proofBytes = (bits: number) => (bits - 1) * POINT_BYTES + CHALLENGE_BYTES + bits * (CHALLENGE_BYTES + 2 * SCALAR_BYTES);

/** Fiat-Shamir challenge over the context, the commitment, every bit commitment and every OR-proof first message. */
function challenge(context: Uint8Array, c: Point, d: Point[], a: Point[]): bigint {
  const parts = [new TextEncoder().encode('veil/v1/range'), context, c.toBytes(), ...d.map((x) => x.toBytes()), ...a.map((x) => x.toBytes())];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return leNumber(sha512(buf).subarray(0, CHALLENGE_BYTES));
}

/**
 * Prove that C = x G + r H commits to x in [-2^(bits-1), 2^(bits-1)). `context` binds the proof to one meter and round.
 * Throws for an x outside the range: an honest meter cannot prove it.
 */
export function prove(x: bigint, r: bigint, bits: number, context: Uint8Array): Uint8Array {
  const v = x + (1n << BigInt(bits - 1));
  if (v < 0n || v >= 1n << BigInt(bits)) throw new RangeError(`reading ${x} is outside the ${bits}-bit range`);
  const c = commitPoint(x, r);
  const rho: bigint[] = [0n];
  let rest = 0n;
  for (let k = 1; k < bits; k++) {
    rho.push(randomScalar());
    rest += rho[k]! << BigInt(k);
  }
  rho[0] = mod(r - rest); // so that sum 2^k D_k = C + 2^(bits-1) G
  const bit = (k: number) => (v >> BigInt(k)) & 1n;
  const d = rho.map((s, k) => (bit(k) ? G.add(mul(H, s)) : mul(H, s)));
  const target = (k: number, branch: number) => (branch === 0 ? d[k]! : d[k]!.subtract(G));
  const w: bigint[] = [];
  const fake: { c: bigint; z: bigint }[] = [];
  const a: Point[] = [];
  for (let k = 0; k < bits; k++) {
    const real = Number(bit(k));
    w.push(randomScalar());
    fake.push({ c: leNumber(globalThis.crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES))), z: randomScalar() });
    const aReal = mul(H, w[k]!);
    const aFake = mul(H, fake[k]!.z).subtract(mul(target(k, 1 - real), fake[k]!.c));
    a.push(real === 0 ? aReal : aFake, real === 0 ? aFake : aReal);
  }
  const ch = challenge(context, c, d, a);
  const out = new Uint8Array(proofBytes(bits));
  let at = 0;
  for (let k = 1; k < bits; k++, at += POINT_BYTES) out.set(d[k]!.toBytes(), at);
  out.set(leBytes(ch, CHALLENGE_BYTES), at);
  at += CHALLENGE_BYTES;
  for (let k = 0; k < bits; k++) {
    const real = Number(bit(k));
    const cReal = (((ch - fake[k]!.c) % C_MOD) + C_MOD) % C_MOD;
    const zReal = mod(w[k]! + cReal * rho[k]!);
    const [c0, z0, z1] = real === 0 ? [cReal, zReal, fake[k]!.z] : [fake[k]!.c, fake[k]!.z, zReal];
    out.set(leBytes(c0, CHALLENGE_BYTES), at);
    out.set(scalarBytes(z0), at + CHALLENGE_BYTES);
    out.set(scalarBytes(z1), at + CHALLENGE_BYTES + SCALAR_BYTES);
    at += CHALLENGE_BYTES + 2 * SCALAR_BYTES;
  }
  return out;
}

/** Check a range proof against the commitment it was made for; false on any malformed input. */
export function verify(commitment: Uint8Array, proof: Uint8Array, bits: number, context: Uint8Array): boolean {
  try {
    if (proof.length !== proofBytes(bits)) return false;
    const c = point(commitment);
    const d: Point[] = [P.ZERO];
    let at = 0;
    let sum = P.ZERO;
    for (let k = 1; k < bits; k++, at += POINT_BYTES) {
      d.push(point(proof.subarray(at, at + POINT_BYTES)));
      sum = sum.add(mul(d[k]!, 1n << BigInt(k), true));
    }
    d[0] = c.add(mul(G, 1n << BigInt(bits - 1), true)).subtract(sum);
    const ch = leNumber(proof.subarray(at, at + CHALLENGE_BYTES));
    at += CHALLENGE_BYTES;
    const a: Point[] = [];
    for (let k = 0; k < bits; k++) {
      const c0 = leNumber(proof.subarray(at, at + CHALLENGE_BYTES));
      const z0 = leNumber(proof.subarray(at + CHALLENGE_BYTES, at + CHALLENGE_BYTES + SCALAR_BYTES));
      const z1 = leNumber(proof.subarray(at + CHALLENGE_BYTES + SCALAR_BYTES, at + CHALLENGE_BYTES + 2 * SCALAR_BYTES));
      if (z0 >= L || z1 >= L) return false;
      const c1 = (((ch - c0) % C_MOD) + C_MOD) % C_MOD;
      a.push(mul(H, z0, true).subtract(mul(d[k]!, c0, true)), mul(H, z1, true).subtract(mul(d[k]!.subtract(G), c1, true)));
      at += CHALLENGE_BYTES + 2 * SCALAR_BYTES;
    }
    return challenge(context, c, d, a) === ch;
  } catch {
    return false;
  }
}

/** A scalar from a hash of the given parts (SHA-512, wide reduction). */
export function hashToScalar(...parts: Uint8Array[]): bigint {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return wideScalar(sha512(buf));
}

/** Sum of commitments, for the aggregate check: sum_i C_i must equal total G + R H. */
export function sumsTo(commitments: readonly Uint8Array[], total: bigint, blinding: bigint): boolean {
  try {
    const sum = commitments.reduce((acc, c) => acc.add(point(c)), P.ZERO);
    return sum.equals(commitPoint(total, blinding));
  } catch {
    return false;
  }
}
