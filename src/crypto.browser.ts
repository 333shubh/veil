// Browser backend for src/crypto.ts: the same functions and byte layouts, built on @noble and the Web Crypto random
// source instead of node:crypto. The demo's bundler swaps this module in; test/crypto-browser.test.ts checks that both
// backends agree byte for byte.
import { chacha20, chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 as curve } from '@noble/curves/ed25519.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import type { U64 } from './ring.ts';

const random = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));

export interface KeyPair {
  sk: Uint8Array;
  pk: Uint8Array;
  privateKey: Uint8Array;
}

export function x25519Public(sk: Uint8Array): Uint8Array {
  return Buffer.from(curve.getPublicKey(sk));
}

export function x25519Keygen(): KeyPair {
  const sk = Buffer.from(random(32));
  return { sk, pk: x25519Public(sk), privateKey: sk };
}

export const x25519KeyPair = (sk: Uint8Array, pk: Uint8Array): KeyPair => ({ sk, pk, privateKey: sk });

export function x25519(own: KeyPair, peer: Uint8Array): Uint8Array {
  const shared = curve.getSharedSecret(own.sk, peer);
  if (shared.every((b) => b === 0)) throw new Error('x25519: low-order public key');
  return Buffer.from(shared);
}

export interface KemKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export const kemKeygen = (): KemKeyPair => ml_kem768.keygen();

export function kemEncapsulate(publicKey: Uint8Array): { ciphertext: Uint8Array; secret: Uint8Array } {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
  return { ciphertext: cipherText, secret: sharedSecret };
}

export const kemDecapsulate = (ciphertext: Uint8Array, secretKey: Uint8Array): Uint8Array => ml_kem768.decapsulate(ciphertext, secretKey);

export const hkdf = (ikm: Uint8Array, info: Uint8Array, length = 32): Uint8Array => nobleHkdf(nobleSha256, ikm, undefined, info, length);

function nonce(epoch: number, round: number): Uint8Array {
  const n = Buffer.alloc(12);
  n.writeUInt32LE(epoch, 0);
  n.writeBigUInt64LE(BigInt(round), 4);
  return n;
}

/** ChaCha20 keystream (RFC 8439, block counter 0) under nonce = epoch (u32 LE) || round (u64 LE). */
export const keystream = (key: Uint8Array, epoch: number, round: number, length: number): Buffer =>
  Buffer.from(chacha20(key, nonce(epoch, round), new Uint8Array(length)));

export const prg = (key: Uint8Array, epoch: number, round: number): U64 => keystream(key, epoch, round, 8).readBigUInt64LE(0);

/** Endless ChaCha20 keystream (zero nonce) read as u32s. */
export function u32Stream(key: Uint8Array): () => number {
  const zero = new Uint8Array(12);
  let counter = 0;
  let block = new Uint8Array(0);
  let at = 0;
  return () => {
    if (at === block.length) {
      block = chacha20(key, zero, new Uint8Array(4096), undefined, counter);
      counter += 4096 / 64;
      at = 0;
    }
    const v = (block[at]! | (block[at + 1]! << 8) | (block[at + 2]! << 16) | (block[at + 3]! << 24)) >>> 0;
    at += 4;
    return v;
  };
}

export const seal = (key: Uint8Array, n: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array =>
  Buffer.from(chacha20poly1305(key, n, aad).encrypt(plaintext));

/** Throws if the ciphertext, nonce or AAD was altered. */
export const open = (key: Uint8Array, n: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array =>
  Buffer.from(chacha20poly1305(key, n, aad).decrypt(sealed));

export const sha256 = (...parts: Uint8Array[]): Buffer => Buffer.from(nobleSha256(Buffer.concat(parts)));

export const tag = (key: Uint8Array, message: Uint8Array): Buffer => Buffer.from(hmac(nobleSha256, key, message)).subarray(0, 16);

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface SigningKey {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function ed25519Keygen(): SigningKey {
  const privateKey = random(32);
  return { publicKey: Buffer.from(ed25519.getPublicKey(privateKey)), privateKey };
}

export const signBytes = (key: SigningKey, message: Uint8Array): Buffer => Buffer.from(ed25519.sign(message, key.privateKey));

/** False for a bad signature or a malformed key or signature. */
export function verifyBytes(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
