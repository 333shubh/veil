// Primitives: X25519, HKDF-SHA256, ChaCha20 mask PRG, ChaCha20-Poly1305 for share transport.
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import type { U64 } from './ring.ts';

export interface KeyPair {
  sk: Uint8Array; // raw 32-byte X25519 private key (what gets Shamir-shared)
  pk: Uint8Array; // raw 32-byte X25519 public key
  privateKey: KeyObject; // parsed once: OpenSSL 3 key parsing dominates the cost of a DH
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export function x25519Keygen(): KeyPair {
  const { privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { sk: Buffer.from(jwk.d!, 'base64url'), pk: Buffer.from(jwk.x!, 'base64url'), privateKey };
}

/** Key pair from raw bytes, e.g. a mask key rebuilt from shares. */
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

const ZERO8 = new Uint8Array(8);

/**
 * PRG(key, epoch, round): the first 8 bytes of the ChaCha20 keystream (RFC 8439, block counter 0)
 * under nonce = epoch (u32 LE) || round (u64 LE), read as a little-endian ring element.
 * Each (epoch, round) is used once per key, so no nonce repeats under one key.
 */
export function prg(key: Uint8Array, epoch: number, round: number): U64 {
  const iv = Buffer.alloc(16); // Node's chacha20 IV: u32 LE block counter, then the 12-byte nonce
  iv.writeUInt32LE(epoch, 4);
  iv.writeBigUInt64LE(BigInt(round), 8);
  return createCipheriv('chacha20', key, iv).update(ZERO8).readBigUInt64LE(0);
}

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
