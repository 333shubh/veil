import { describe, expect, it } from 'vitest';
import { hkdf, open, prg, seal, x25519, x25519KeyPair, x25519Keygen } from '../src/crypto';

const hex = (s: string) => Buffer.from(s, 'hex');
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('X25519', () => {
  it('matches RFC 7748 section 6.1', () => {
    const alice = x25519KeyPair(
      hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
      hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'),
    );
    const bob = x25519KeyPair(
      hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'),
      hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'),
    );
    const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(toHex(x25519(alice, bob.pk))).toBe(shared);
    expect(toHex(x25519(bob, alice.pk))).toBe(shared);
  });

  it('agrees on fresh key pairs', () => {
    const a = x25519Keygen();
    const b = x25519Keygen();
    expect(toHex(x25519(a, b.pk))).toBe(toHex(x25519(b, a.pk)));
  });
});

describe('HKDF-SHA256', () => {
  it('matches RFC 5869 test case 3', () => {
    expect(toHex(hkdf(Buffer.alloc(22, 0x0b), new Uint8Array(0), 42))).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });
});

describe('ChaCha20 mask PRG', () => {
  it('matches RFC 8439 appendix A.1 vector 1 (zero key, zero nonce, counter 0)', () => {
    expect(prg(new Uint8Array(32), 0, 0)).toBe(0x903df1a0ade0b876n); // keystream 76 b8 e0 ad a0 f1 3d 90, LE
  });

  it('gives a distinct mask per epoch and round', () => {
    const k = new Uint8Array(32).fill(7);
    expect(new Set([prg(k, 1, 0), prg(k, 0, 1), prg(k, 1, 1), prg(k, 0, 2 ** 32)]).size).toBe(4);
  });
});

describe('ChaCha20-Poly1305 share transport', () => {
  it('round-trips and rejects tampered ciphertext or AAD', () => {
    const key = new Uint8Array(32).fill(1);
    const nonce = new Uint8Array(12);
    const sealed = seal(key, nonce, hex('01'), hex('00112233'));
    expect(toHex(open(key, nonce, hex('01'), sealed))).toBe('00112233');
    const flipped = Buffer.from(sealed);
    flipped[0]! ^= 1;
    expect(() => open(key, nonce, hex('01'), flipped)).toThrow();
    expect(() => open(key, nonce, hex('02'), sealed)).toThrow();
  });
});
