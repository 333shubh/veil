// Primitives: X25519, HKDF-SHA256, ChaCha20 mask PRG, ChaCha20-Poly1305 for share transport,
// Ed25519 for device signatures, HMAC-SHA256 for per-round tags, SHA-256 for commitments.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import type { U64 } from './ring.ts';

export interface KeyPair {
  sk: Uint8Array; // raw 32-byte X25519 private key
  pk: Uint8Array; // raw 32-byte X25519 public key
  privateKey: KeyObject; // parsed once: OpenSSL 3 key parsing dominates the cost of a DH
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export function x25519Keygen(): KeyPair {
  const { privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { sk: Buffer.from(jwk.d!, 'base64url'), pk: Buffer.from(jwk.x!, 'base64url'), privateKey };
}

/** Key pair from raw bytes. */
export function x25519KeyPair(sk: Uint8Array, pk: Uint8Array): KeyPair {
  const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64u(sk), x: b64u(pk) }, format: 'jwk' });
  return { sk, pk, privateKey };
}

export function x25519(own: KeyPair, peer: Uint8Array): Uint8Array {
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(peer) }, format: 'jwk' });
  const shared = diffieHellman({ privateKey: own.privateKey, publicKey });
  if (shared.every((b) => b === 0)) throw new Error('x25519: low-order public key');
  return shared;
}

export function hkdf(ikm: Uint8Array, info: Uint8Array, length = 32): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, new Uint8Array(0), info, length));
}

/**
 * ChaCha20 keystream (RFC 8439, block counter 0) under nonce = epoch (u32 LE) || round (u64 LE).
 * Each (epoch, round) is used once per key, so no nonce repeats under one key.
 */
export function keystream(key: Uint8Array, epoch: number, round: number, length: number): Buffer {
  const iv = Buffer.alloc(16); // Node's chacha20 IV: u32 LE block counter, then the 12-byte nonce
  iv.writeUInt32LE(epoch, 4);
  iv.writeBigUInt64LE(BigInt(round), 8);
  return createCipheriv('chacha20', key, iv).update(Buffer.alloc(length));
}

/** PRG(key, epoch, round): the first 8 keystream bytes, read as a little-endian ring element. */
export const prg = (key: Uint8Array, epoch: number, round: number): U64 => keystream(key, epoch, round, 8).readBigUInt64LE(0);

/** Endless ChaCha20 keystream (zero nonce) read as u32s: deterministic randomness from a public seed. */
export function u32Stream(key: Uint8Array): () => number {
  const cipher = createCipheriv('chacha20', key, Buffer.alloc(16));
  const zeros = Buffer.alloc(4096);
  let block = Buffer.alloc(0);
  let at = 0;
  return () => {
    if (at === block.length) {
      block = cipher.update(zeros);
      at = 0;
    }
    const v = block.readUInt32LE(at);
    at += 4;
    return v;
  };
}

const TAG = 16;

export function seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

/** Throws if the ciphertext, nonce or AAD was altered. */
export function open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  const body = sealed.subarray(0, sealed.length - TAG);
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  d.setAAD(aad, { plaintextLength: body.length });
  return Buffer.concat([d.update(body), d.final()]);
}

export const sha256 = (...parts: Uint8Array[]): Buffer => createHash('sha256').update(Buffer.concat(parts)).digest();

/** HMAC-SHA256 truncated to 16 bytes. */
export const tag = (key: Uint8Array, message: Uint8Array): Buffer => createHmac('sha256', key).update(message).digest().subarray(0, 16);

export const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

export interface SigningKey {
  publicKey: Uint8Array; // raw 32-byte Ed25519 public key
  privateKey: KeyObject;
}

export function ed25519Keygen(): SigningKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: Buffer.from(privateKey.export({ format: 'jwk' }).x!, 'base64url'), privateKey };
}

export const signBytes = (key: SigningKey, message: Uint8Array): Buffer => sign(null, message, key.privateKey);

const verifiers = new Map<string, KeyObject>(); // parsed device keys; parsing costs more than verifying

/** False for a bad signature or a malformed key or signature. */
export function verifyBytes(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const x = b64u(publicKey);
    let key = verifiers.get(x);
    if (!key) {
      key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
      verifiers.set(x, key);
    }
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
